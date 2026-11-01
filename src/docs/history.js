// Learn from Pierce's own past correspondence. Threads about a listing are indexed as `history` documents
// (tier: sensitive by default, so anything the bot pulls from them is reviewed before it goes out).
// Two feeds: (a) Dropbox "05 - Correspondence" folders are picked up by the normal sync; (b) Outlook threads
// via Graph, matched to listings by subject/body, imported by importEmailHistory().
import { config } from '../config.js';
import { db } from '../db/index.js';
import { matchListing } from '../listings.js';
import { chunkText } from './search.js';

const E = config.email;
let token = null; let exp = 0;
async function getToken() {
  if (token && Date.now() < exp - 60e3) return token;
  const res = await fetch(`https://login.microsoftonline.com/${E.tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: E.clientId, client_secret: E.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Graph auth ${res.status}`);
  const j = await res.json(); token = j.access_token; exp = Date.now() + j.expires_in * 1000; return token;
}

const strip = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// Drop quoted replies and signatures so a thread isn't indexed five times over.
const trimQuoted = (t) => t.split(/\n?(?:From: |On .{5,80} wrote:|-----Original Message-----|Sent from my)/)[0].trim();

/**
 * Pull Pierce's sent + received mail mentioning each active listing (last `days`), group by conversation,
 * and index each thread as one `history` document for that listing. Idempotent by conversationId.
 */
export async function importEmailHistory({ days = 365, maxPerListing = 60 } = {}) {
  if (E.mode !== 'live') return { skipped: 'email_off' };
  const listings = await db.listListings();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const report = {};
  for (const listing of listings) {
    const names = [listing.name, ...(listing.aliases || [])].filter(Boolean);
    const q = names.map((n) => `"${n.replace(/"/g, '')}"`).join(' OR ');
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(E.mailbox)}/messages?$search=${encodeURIComponent(q)}&$top=${maxPerListing}&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}`, ConsistencyLevel: 'eventual' } });
    if (!res.ok) { report[listing.name] = `error ${res.status}`; continue; }
    const msgs = ((await res.json()).value || []).filter((m) => m.receivedDateTime >= since);
    const threads = new Map();
    for (const m of msgs) { if (!threads.has(m.conversationId)) threads.set(m.conversationId, []); threads.get(m.conversationId).push(m); }
    const existing = new Map((await db.listDocuments(listing.id)).filter((d) => d.doc_type === 'history').map((d) => [d.dropbox_id, d]));
    let added = 0; let unchanged = 0;
    for (const [convId, list] of threads) {
      list.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
      const hash = `${list.length}:${list.at(-1).receivedDateTime}`;
      const prev = existing.get(`graph:${convId}`);
      if (prev && prev.content_hash === hash) { unchanged++; continue; }
      if (prev) await db.deleteDocument(prev.id);
      const text = list.map((m) => {
        const who = m.from?.emailAddress?.address?.toLowerCase() === E.mailbox.toLowerCase() ? 'PIERCE' : (m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'them');
        return `[${m.receivedDateTime.slice(0, 10)} ${who}] ${trimQuoted(strip(m.body?.content) || m.bodyPreview || '')}`;
      }).join('\n');
      const doc = await db.insertDocument({
        listing_id: listing.id, filename: `Email thread: ${list[0].subject || '(no subject)'}`, doc_type: 'history', tier: 'sensitive',
        dropbox_id: `graph:${convId}`, dropbox_path: null, content_hash: hash, status: 'processed',
        summary: `${list.length} emails, ${list[0].receivedDateTime.slice(0, 10)} to ${list.at(-1).receivedDateTime.slice(0, 10)}`, extracted: {},
      });
      await db.insertChunks(chunkText(`[${doc.filename}]\n${text}`).map((content) => ({ document_id: doc.id, listing_id: listing.id, tier: 'sensitive', content })));
      added++;
    }
    report[listing.name] = { threads: threads.size, added, unchanged };
  }
  return report;
}

/** Quick structured check the agent can call: has X ever come up on this listing? */
export async function priorMentions(listingId, topic) {
  const chunks = await db.listChunks(listingId, ['sensitive', 'ca', 'public']);
  const { searchChunks } = await import('./search.js');
  const hits = searchChunks(chunks.filter((c) => c.doc_type === 'history'), topic, 5);
  return hits.map((h) => ({ thread: h.filename, excerpt: h.content.slice(0, 700) }));
}

/** Match an arbitrary email (subject + body) to a listing. Used by the import and by inbound email later. */
export async function listingForEmail(subject, body) {
  return (await matchListing(subject)) || (await matchListing(body?.slice(0, 2000)));
}
