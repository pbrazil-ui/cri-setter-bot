// Hourly: mirror Dropbox listing folders + SOPs into the knowledge base. Only changed files are re-read.
import { config } from '../config.js';
import { db } from '../db/index.js';
import { listFolder, download } from '../dropbox.js';
import { classifyFile, rules } from './classify.js';
import { ingestFile } from './ingest.js';
import { matchListing } from '../listings.js';

const baseName = (folder) => folder.replace(/\s+-\s+[^-]+,\s*[A-Z]{2}\s*$/, '').trim(); // "Lighthouse Resort - Isleton, CA" -> "Lighthouse Resort"
const cityOf = (folder) => folder.match(/-\s+([^-]+,\s*[A-Z]{2})\s*$/)?.[1] || null;

export async function syncFolder(listingId, rootPath, { internal = false } = {}) {
  const entries = (await listFolder(rootPath, { recursive: true })).filter((e) => e['.tag'] === 'file');
  const existing = new Map((await db.listDocuments(listingId)).map((d) => [d.dropbox_id, d]));
  const seen = new Set();
  const out = { added: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0, failed: 0 };
  for (const entry of entries) {
    const rel = entry.path_display.slice(rootPath.length + 1);
    const cls = internal ? { tier: 'internal', doc_type: 'sop' } : classifyFile(rel, entry.size);
    if (!internal && cls.tier === 'exclude') { out.skipped++; continue; }
    if (internal && !/\.(pdf|docx|txt|md|csv|xlsx)$/i.test(entry.name)) { out.skipped++; continue; }
    seen.add(entry.id);
    const prev = existing.get(entry.id);
    if (prev && prev.content_hash === entry.content_hash && prev.tier === cls.tier) { out.unchanged++; continue; }
    if (prev) await db.deleteDocument(prev.id);
    const doc = await ingestFile({ listingId, entry, buffer: await download(entry.id), cls });
    if (doc.status === 'failed') out.failed++; else if (prev) out.updated++; else out.added++;
  }
  for (const [id, d] of existing) if (!seen.has(id)) { await db.deleteDocument(d.id); out.removed++; }
  return out;
}

/** Map "01 - Listed" folders to listings, then sync each, then SOPs. */
export async function syncDropbox() {
  if (config.dropbox.mode === 'off') return null;
  const report = { listings: {}, unmatched_folders: [], sops: null };
  const folders = (await listFolder(rules.listings_root, { recursive: false })).filter((e) => e['.tag'] === 'folder' || e['.tag'] === 'mount');
  const listings = await db.listListings();
  for (const f of folders) {
    let listing = listings.find((l) => l.dropbox_path?.toLowerCase() === f.path_display.toLowerCase());
    if (!listing) {
      listing = await matchListing(baseName(f.name));
      if (listing && !listing.dropbox_path) listing = await db.updateListing(listing.id, { dropbox_path: f.path_display, city: listing.city || cityOf(f.name) });
      else if (listing?.dropbox_path && listing.dropbox_path !== f.path_display) listing = null; // already mapped elsewhere
    }
    if (!listing) { report.unmatched_folders.push(f.name); continue; }
    report.listings[listing.name] = await syncFolder(listing.id, listing.dropbox_path);
  }
  if (rules.sop_root) report.sops = await syncFolder(null, rules.sop_root, { internal: true });
  return report;
}
