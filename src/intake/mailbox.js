// Lead emails straight from Pierce's inbox (Microsoft Graph), so no Postmark account or Outlook forwarding rule is needed.
// Only messages FROM a listing platform's address are considered (never his own threads or a buyer's reply that quotes
// a platform name). Each message is processed once (claimEvent), then handed to the same ingestEmail() as /ingest/email.
import { config } from '../config.js';
import { db } from '../db/index.js';
import { now } from '../clock.js';
import { listInboxSince } from '../email.js';
import { ingestEmail, normalizeEmailPayload } from './email.js';
import { detectPlatform } from '../platforms.js';
import { handleInboundEmail } from '../agent/setter.js';

const AUTO_REPLY = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification|mail delivery failed|returned mail)/i;

/** Keep only what the buyer wrote: drop the quoted thread, signatures from phones, etc. */
export function stripQuoted(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (/^\s*(On .{5,200}wrote:|-{2,}\s*Original Message|From:\s|Sent from my |>)/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

// sender domains only; "website" forms arrive from HubSpot's notification address
const SENDER = /@([\w-]+\.)*(crexi\.com|loopnet\.com|rvparkstore\.com|mhvillage\.com|mhbay\.com|costar\.com|biproxi\.com|hubspot\.com)$/i;
export const isPlatformSender = (address) => SENDER.test(String(address || '').trim());

const FORWARD = /^\s*(fw|fwd)\s*:/i;
/** Dylan (or Pierce's other address) forwarding a platform lead email: "Fwd:" subject and a platform in the body. */
const isForwardedLead = (from, subject, text) => {
  const f = String(from || '').toLowerCase();
  const trusted = config.email.trustedForwarders.includes(f) || config.email.allowedMailboxes.includes(f);
  return trusted && FORWARD.test(subject || '') && !!detectPlatform('', subject, text);
};

/** Pierce's mailboxes only (config.email.readMailboxes, each checked against the allowlist in email.js). */
export async function pollInboxForLeads() {
  if (config.email.mode === 'off' || !config.email.pollLeads) return null;
  const out = { seen: 0, leads: 0, replies: 0, ignored: 0, errors: [] };
  for (const mailbox of [...new Set(config.email.readMailboxes)]) {
    try { await pollOne(mailbox, out); } catch (e) { out.errors.push(`${mailbox}: ${e.message.slice(0, 200)}`); }
  }
  if (!out.errors.length) delete out.errors;
  return out;
}

async function pollOne(mailbox, out) {
  // first run: look back one hour so a restart never misses a lead, never re-blasts old ones
  const key = `lead_poll_since:${mailbox}`;
  const since = (await db.getSetting(key)) || new Date(+now() - 3600e3).toISOString();
  const msgs = await listInboxSince(since, 50, mailbox);
  out.seen += msgs.length;
  let newest = since;
  for (const m of msgs) {
    if (m.receivedDateTime > newest) newest = m.receivedDateTime;
    const from = m.from?.emailAddress?.address || '';
    const html = m.body?.contentType === 'html';
    const { text } = normalizeEmailPayload({ [html ? 'HtmlBody' : 'TextBody']: m.body?.content || '' });
    const platformLead = isPlatformSender(from) || isForwardedLead(from, m.subject, text);
    if (!platformLead) {
      // a buyer replying by email: the bot answers in the thread, same rules as texts
      const lead = from && !AUTO_REPLY.test(m.subject || '') ? await db.findLeadByEmail(from.toLowerCase()) : null;
      if (!lead || !(await db.claimEvent(`mail:${m.id}`))) { out.ignored++; continue; }
      const body = stripQuoted(text);
      if (!body) { out.ignored++; continue; }
      await handleInboundEmail(lead, { id: m.id, conversationId: m.conversationId, subject: m.subject, text: body, receivedAt: m.receivedDateTime });
      out.replies++;
      continue;
    }
    if (!(await db.claimEvent(`mail:${m.id}`))) continue;
    const r = await ingestEmail({ From: from, Subject: m.subject || '', [html ? 'HtmlBody' : 'TextBody']: m.body?.content || '' });
    if (r.created || r.duplicate) out.leads++; else out.ignored++;
  }
  await db.setSetting(key, newest);
}
