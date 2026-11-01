// Listing-platform lead emails (Crexi, LoopNet, RVParkStore, MHVillage, website forms), forwarded to
// this server by Postmark inbound, Zapier, or any JSON POST.
import { config } from '../config.js';
import { extractLeadFromEmail } from '../llm.js';
import { upsertIncomingLead } from './common.js';
import { processFirstTouch } from '../agent/setter.js';
import { detectPlatform } from '../platforms.js';
import { db } from '../db/index.js';
import * as hubspot from '../hubspot.js';

const htmlToText = (html) => String(html || '')
  .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

export function normalizeEmailPayload(p = {}) {
  const subject = p.Subject ?? p.subject ?? '';
  const html = p.HtmlBody ?? p.html ?? p.body_html ?? '';
  const text = (p.TextBody ?? p.text ?? p.body_plain ?? p.body ?? '') || htmlToText(html);
  const from = p.From ?? p.from ?? '';
  const listingUrl = `${text}\n${html}`.match(/https?:\/\/(?:www\.)?crexi\.com\/properties\/[^\s"'<>)]+/i)?.[0];
  return { subject, text, from, listingUrl };
}

export async function ingestEmail(payload) {
  const { subject, text, from, listingUrl } = normalizeEmailPayload(payload);
  const platform = detectPlatform(from, subject, text);
  if (config.requireKnownPlatform && (!platform || !config.leadPlatforms.includes(platform))) return { ignored: 'unknown_platform' };
  const ex = await extractLeadFromEmail({ subject, text: text.slice(0, 12000) });
  if (!ex?.is_lead) return { ignored: 'not_a_lead' };
  const result = await upsertIncomingLead({
    first_name: ex.first_name, last_name: ex.last_name, email: ex.email, phone: ex.phone,
    company: ex.company, role: ex.role, property_name: ex.property_name, crexi_url: listingUrl, platform,
    inquiry: [ex.action_taken, ex.inquiry_message].filter(Boolean).join(': '),
    raw: { subject, from },
  }, 'listing_email');
  // Crexi runs its own CA. "Signed CA" activity from Crexi unlocks confidential docs.
  if (result.lead && platform === 'crexi' && config.autoVerifyCrexiCa && /sign/i.test(ex.action_taken || '') && /\bca\b|confidential/i.test(ex.action_taken || '')) {
    result.lead = await db.updateLead(result.lead.id, { ca_verified: true });
    await hubspot.addNote(result.lead.id, 'CA signed on Crexi (from lead email). Confidential docs unlocked for the setter bot.');
  }
  // speed to lead: text a brand-new lead right away (or at the next send window)
  if (result.created || result.reopened) result.firstTouch = await processFirstTouch(result.lead);
  return result;
}
