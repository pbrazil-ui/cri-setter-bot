// Lead emails straight from Pierce's inbox (Microsoft Graph), so no Postmark account or Outlook forwarding rule is needed.
// Only messages FROM a listing platform's address are considered (never his own threads or a buyer's reply that quotes
// a platform name). Each message is processed once (claimEvent), then handed to the same ingestEmail() as /ingest/email.
import { config } from '../config.js';
import { db } from '../db/index.js';
import { now } from '../clock.js';
import { listInboxSince } from '../email.js';
import { ingestEmail } from './email.js';

// sender domains only; "website" forms arrive from HubSpot's notification address
const SENDER = /@([\w-]+\.)*(crexi\.com|loopnet\.com|rvparkstore\.com|mhvillage\.com|mhbay\.com|costar\.com|biproxi\.com|hubspot\.com)$/i;
export const isPlatformSender = (address) => SENDER.test(String(address || '').trim());

export async function pollInboxForLeads() {
  if (config.email.mode === 'off' || !config.email.pollLeads) return null;
  // first run: look back one hour so a restart never misses a lead, never re-blasts old ones
  const since = (await db.getSetting('lead_poll_since')) || new Date(+now() - 3600e3).toISOString();
  const msgs = await listInboxSince(since);
  const out = { seen: msgs.length, leads: 0, ignored: 0 };
  let newest = since;
  for (const m of msgs) {
    if (m.receivedDateTime > newest) newest = m.receivedDateTime;
    const from = m.from?.emailAddress?.address || '';
    if (!isPlatformSender(from)) { out.ignored++; continue; }
    if (!(await db.claimEvent(`mail:${m.id}`))) continue;
    const html = m.body?.contentType === 'html';
    const r = await ingestEmail({ From: from, Subject: m.subject || '', [html ? 'HtmlBody' : 'TextBody']: m.body?.content || '' });
    if (r.created || r.duplicate) out.leads++; else out.ignored++;
  }
  await db.setSetting('lead_poll_since', newest);
  return out;
}
