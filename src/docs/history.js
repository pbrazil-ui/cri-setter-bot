// Learn from Pierce's own past correspondence. Threads about a listing are indexed as `history` documents
// (tier: sensitive by default, so anything the bot pulls from them is reviewed before it goes out).
// Two feeds: (a) Dropbox "05 - Correspondence" folders are picked up by the normal sync; (b) Outlook threads
// via Graph, matched to listings by subject/body, imported by importEmailHistory().
import { config } from '../config.js';
import { assertGraphAllowed } from '../email.js';
import { db } from '../db/index.js';
import { matchListing, publicListingName } from '../listings.js';
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
export async function importEmailHistory({ days = 365, maxMessages = 5000 } = {}) {
  if (E.mode !== 'live') return { skipped: 'email_off' };
  const listings = await db.listListings();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // One plain read of the mailbox, matched to listings here. Graph's $search returns 403 under Exchange RBAC for
  // Applications (Nov 2 2026, every listing), while $filter reads work, so no $search.
  const msgs = [];
  let path = `/users/${encodeURIComponent(E.mailbox)}/messages?${new URLSearchParams({ $filter: `receivedDateTime ge ${since}`, $orderby: 'receivedDateTime desc', $top: '100', $select: 'id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview' })}`;
  while (path && msgs.length < maxMessages) {
    assertGraphAllowed('GET', path);
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${await getToken()}`, Prefer: 'outlook.body-content-type="text"' } });
    if (!res.ok) return { error: `Graph ${res.status}: ${(await res.text()).slice(0, 200)}`, read: msgs.length };
    const j = await res.json();
    msgs.push(...(j.value || []));
    path = j['@odata.nextLink'] ? j['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  const byListing = matchMessagesToListings(msgs, listings);
  const report = { read: msgs.length };
  for (const listing of listings) {
    const threads = new Map();
    for (const m of byListing.get(listing.id) || []) { if (!threads.has(m.conversationId)) threads.set(m.conversationId, []); threads.get(m.conversationId).push(m); }
    if (!threads.size) continue;
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

/** Which listings a message is about: a listing's name (seller prefix stripped) or alias in the subject or body. */
export function matchMessagesToListings(msgs, listings) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const keys = listings.map((l) => ({ id: l.id, names: [...new Set([l.name, publicListingName(l.name), ...(l.aliases || [])]
    .map((n) => norm(String(n || '').replace(/\(.*?\)/g, '').replace(/\s+-\s+[^-]+,\s*[A-Z]{2}\s*$/, '')))
    .filter((n) => n.length >= 8))] }));
  const out = new Map();
  for (const m of msgs) {
    const hay = ` ${norm(m.subject)} ${norm(m.body?.content || m.bodyPreview)} `;
    for (const k of keys) if (k.names.some((n) => hay.includes(` ${n} `))) { if (!out.has(k.id)) out.set(k.id, []); out.get(k.id).push(m); }
  }
  return out;
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
