// Hourly: mirror Dropbox listing folders + SOPs into the knowledge base. Only changed files are re-read.
import { config } from '../config.js';
import { db } from '../db/index.js';
import { listFolder, download } from '../dropbox.js';
import { classifyFile, blocksDataRoom, rules } from './classify.js';
import { ingestFile } from './ingest.js';
import { matchListing, mostRestrictive, publicListingName } from '../listings.js';
import { inDataRoom } from '../dataroom.js';
import { notifyOwner } from '../notify.js';
import { audit } from '../policy.js';

// Set by jobs.js to "is this instance still the leader?". A long sync stops between files once a newer instance
// takes over, so two instances never read the same files at once.
let keepGoing = () => true;
export const setSyncGuard = (fn) => { keepGoing = fn; };
const checkGuard = () => { if (!keepGoing()) { const e = new Error('handed over to a newer instance'); e.handover = true; throw e; } };

const baseName = (folder) => folder.replace(/\s+-\s+[^-]+,\s*[A-Z]{2}\s*$/, '').trim(); // "Lighthouse Resort - Isleton, CA" -> "Lighthouse Resort"
const cityOf = (folder) => folder.match(/-\s+([^-]+,\s*[A-Z]{2})\s*$/)?.[1] || null;

export async function syncFolder(listingId, rootPath, { internal = false } = {}) {
  const entries = (await listFolder(rootPath, { recursive: true })).filter((e) => e['.tag'] === 'file');
  const existing = new Map((await db.listDocuments(listingId)).map((d) => [d.dropbox_id, d]));
  const listing = !internal && listingId != null ? await db.getListing(listingId) : null;
  const roomHits = []; // files in the listing's data room that buyers must never see
  const seen = new Set();
  const out = { added: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0, failed: 0 };
  for (const entry of entries) {
    checkGuard();
    const rel = entry.path_display.slice(rootPath.length + 1);
    if (inDataRoom(listing, entry.path_display) !== null && blocksDataRoom(rel)) roomHits.push(rel);
    const cls = internal ? { tier: 'internal', doc_type: 'sop' } : classifyFile(rel, entry.size);
    if (!internal && cls.tier === 'exclude') { out.skipped++; continue; }
    if (internal && !/\.(pdf|docx|txt|md|csv|xlsx)$/i.test(entry.name)) { out.skipped++; continue; }
    seen.add(entry.id);
    const prev = existing.get(entry.id);
    // unchanged = same bytes, same tier, and read successfully; a failed read is retried on the next sync
    if (prev && prev.content_hash === entry.content_hash && prev.tier === cls.tier && prev.status !== 'failed') { out.unchanged++; continue; }
    try {
      const doc = await ingestFile({ listingId, entry, buffer: await download(entry.id), cls });
      if (doc.status === 'failed') out.failed++; else if (prev) out.updated++; else out.added++;
    } catch (e) { out.failed++; console.error('[dropbox sync] file', entry.path_display, e.message); } // next file
  }
  for (const [id, d] of existing) if (!seen.has(id)) { await db.deleteDocument(d.id); out.removed++; }
  if (listing?.facts?.data_room_path) await checkDataRoom(listing, roomHits);
  return out;
}

/**
 * Keep listing.facts.data_room_blocked in step with what is actually in the data room folder. While it lists anything
 * (contracts, financing, insurance, seller emails...), dataRoomFor() returns null and deliver() holds any data room link.
 * Pierce gets one text when it becomes blocked and one when it is clear again.
 */
async function checkDataRoom(listing, hits) {
  const before = listing.facts?.data_room_blocked || [];
  const after = hits.slice(0, 20);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await db.updateListing(listing.id, { facts: { ...listing.facts, data_room_blocked: after } });
  const name = publicListingName(listing.name);
  if (after.length && !before.length) {
    await notifyOwner(`Data room for ${name} now has files buyers shouldn't see: ${after.slice(0, 5).join(', ')}${after.length > 5 ? ` (+${after.length - 5} more)` : ''}. The bot stopped sending its link until they're moved out of that folder.`);
  } else if (!after.length && before.length) {
    await notifyOwner(`Data room for ${name} is clear again. The bot will share its link with CA-verified buyers.`);
  }
  await audit(after.length ? 'data_room_blocked' : 'data_room_clear', { detail: { listing: listing.id, files: after } });
}

const subfolders = async (root) => (await listFolder(root, { recursive: false })).filter((e) => e['.tag'] === 'folder' || e['.tag'] === 'mount');

/** Find the listing for a deal folder, claiming the folder if the listing has none yet. null = no match. */
async function listingForFolder(f, listings) {
  let listing = listings.find((l) => l.dropbox_path?.toLowerCase() === f.path_display.toLowerCase());
  if (listing) return listing;
  listing = await matchListing(baseName(f.name));
  if (listing && !listing.dropbox_path) return db.updateListing(listing.id, { dropbox_path: f.path_display, city: listing.city || cityOf(f.name) });
  return listing?.dropbox_path && listing.dropbox_path !== f.path_display ? null : listing; // already mapped elsewhere
}

/** A deal folder HubSpot doesn't know about becomes a listing of its own (Pierce: Dropbox decides when HubSpot doesn't). */
const listingFromFolder = (f, status) => db.upsertListing({
  hubspot_deal_id: `dropbox:${f.id || f.path_display.toLowerCase()}`, name: baseName(f.name), city: cityOf(f.name),
  status, dropbox_path: f.path_display, facts: { source: 'dropbox', ...(status === 'in_escrow' ? { dropbox_stage: 'under_contract' } : {}) },
});

/** Map "01 - Listed" folders to listings and sync each; "02 - Under Contract" folders mark listings under contract; then SOPs. */
export async function syncDropbox() {
  if (config.dropbox.mode === 'off') return null;
  const report = { listings: {}, unmatched_folders: [], created_from_dropbox: [], under_contract: [], sops: null };

  // under contract first, so a folder moved to 02 is never treated as available, whatever HubSpot says
  if (rules.under_contract_root) {
    for (const f of await subfolders(rules.under_contract_root)) {
      const listing = await listingForFolder(f, await db.listListings());
      if (listing) await db.updateListing(listing.id, { status: mostRestrictive(listing.status, 'in_escrow'), facts: { ...(listing.facts || {}), dropbox_stage: 'under_contract' } });
      else await listingFromFolder(f, 'in_escrow');
      report.under_contract.push(f.name);
    }
  }

  for (const f of await subfolders(rules.listings_root)) {
    checkGuard();
    let listing = await listingForFolder(f, await db.listListings());
    if (!listing) {
      listing = await listingFromFolder(f, 'active');
      report.created_from_dropbox.push(f.name);
      report.unmatched_folders.push(f.name); // still logged: Pierce may want to add it to HubSpot or set an alias
    }
    report.listings[listing.name] = await syncFolder(listing.id, listing.dropbox_path);
  }
  if (rules.sop_root) report.sops = await syncFolder(null, rules.sop_root, { internal: true });
  return report;
}
