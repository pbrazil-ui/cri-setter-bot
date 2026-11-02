// The setter: first touches, inbound replies, follow-ups, and the send/approve/schedule decision.
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { now, hoursSince } from '../clock.js';
import { sendSms } from '../ringcentral.js';
import { runSetter, polishAnswer } from '../llm.js';
import { makeExecutors } from './tools.js';
import { sendEmail, sentInConversationSince } from '../email.js';
import { download, viewLink } from '../dropbox.js';
import { classify, resolve, limits, audit, policies } from '../policy.js';
import { optOutIntent, isStartKeyword, needsHuman, inWindow, nextWindowStart, cleanSms, claimsContact, asksForTour } from '../guardrails.js';
import { notifyOwner, leadLabel } from '../notify.js';
import * as hubspot from '../hubspot.js';
import { platformPhrase } from '../platforms.js';
import { publicListingName, isAvailable, availabilityPhrase } from '../listings.js';
import { dataRoomProblem } from '../dataroom.js';

const templates = JSON.parse(readFileSync(new URL('../../playbook/templates.json', import.meta.url), 'utf8'));
export const MUTED = new Set(['escalated', 'human', 'opted_out', 'wrong_number']);
const iso = () => now().toISOString();
/** Random whole seconds in [minSec, maxSec]: varied, never on a fixed beat. */
export const randSec = ({ minSec, maxSec }) => (maxSec <= 0 ? 0 : Math.round(minSec + Math.random() * Math.max(0, maxSec - minSec)));
export const isPaused = async () => (await db.getSetting('paused')) === true;
/** Pierce's own cell playing a buyer (owner TEST command): any hour, no HubSpot, muted when the test ends. */
export const isTestLead = (lead) => lead?.raw?.test === true;

export async function setStatus(lead, status, extra = {}) {
  const updated = await db.updateLead(lead.id, { status, ...extra });
  await hubspot.syncDealStage(lead.id);
  return updated;
}

const getListing = (lead) => (lead.listing_id ? db.getListing(lead.listing_id) : null);
const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** The property name a buyer sees: what the platform showed them, else the listing's public name (never a seller's name). */
export const propertyLabel = (lead, listing) => lead.property_name || (listing ? publicListingName(listing.name) : null) || templates.property_fallback;

const linkLine = (label, url) => templates.email_details_link.replace('{label}', label).replace('{url}', url);
function emailDetails(listing, links = []) {
  if (!listing || !isAvailable(listing)) return '';
  const page = listing.hub_url || listing.crexi_url;
  const flyer = listing.facts?.flyer_url; // e.g. Crexi's ?flyer=download link, set per listing
  return [
    listing.summary ? templates.email_details_summary.replace('{summary}', listing.summary) : '',
    page ? linkLine('Listing page', page) : '',
    flyer ? linkLine('Flyer', flyer) : '',
    ...links.filter((l) => !(flyer && /flyer/i.test(l.label))).map((l) => linkLine(l.label, l.url)),
    listing.ca_link ? templates.email_details_ca.replace('{ca_link}', listing.ca_link) : '',
    // Crexi's DD vault asks the buyer to sign the CA before it opens (Pierce, Nov 2 2026), so it can go in the first
    // email. Only a crexi.com link: a Dropbox data room link is CA-verified-only and never goes here.
    ddVault(listing) ? linkLine('Due diligence vault', ddVault(listing)) : '',
  ].join('');
}
const ddVault = (listing) => { const u = listing?.facts?.dd_vault_url; return /^https:\/\/(www\.)?crexi\.com\//i.test(u || '') ? u : null; };

const docLabel = (filename) => String(filename).replace(/\.[a-z0-9]+$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, '').trim();
/** View-only links to the listing's PUBLIC documents (flyer/teaser/brochure) for the first email. Team-only links are skipped. */
export async function publicDocLinks(listing, max = 3) {
  if (!listing || !isAvailable(listing)) return [];
  const docs = (await db.listDocuments(listing.id)).filter((d) => d.status === 'processed' && d.tier === 'public').slice(0, max);
  const out = [];
  for (const d of docs) {
    try { const l = await viewLink(d.dropbox_id); if (l.public) out.push({ label: docLabel(d.filename), url: l.url, doc: d.filename }); } catch { /* skip; Pierce can send it */ }
  }
  return out;
}

/**
 * Fixed first-contact wording (no model involved). channel: 'email' | 'sms' (default: the lead's channel).
 * afterEmail: the email already went (or is waiting on Pierce), so the text points to it.
 */
export function firstTouchText(lead, listing, { channel, afterEmail = false, links = [] } = {}) {
  const fill = (s) => s.replace('{owner}', config.owner.name).replace('{ownerFirst}', config.owner.firstName).replace('{companyShort}', config.companyShort).replace('{company}', config.company);
  const who = fill(config.discloseAi ? templates.who_ai : templates.who_plain);
  const email = (channel || (useEmail(lead) ? 'email' : 'sms')) === 'email';
  const open = isAvailable(listing);
  const fav = lead.source === 'favorite';
  const tpl = email ? (!open ? templates.email_unavailable : fav ? templates.email_favorite : templates.email_first_touch)
    : !open ? templates.sms_unavailable
      : fav ? (afterEmail ? templates.favorite_after_email : templates.favorite)
        : afterEmail ? templates.sms_after_email
          : (templates[lead.source] || templates.default);
  const smsLink = open && listing?.ca_link && !lead.ca_verified ? templates.sms_link.replace('{ca_link}', listing.ca_link) : templates.sms_link_profile;
  const city = listing?.city && !propertyLabel(lead, listing).includes(listing.city) ? ` in ${listing.city}` : '';
  return tpl
    .replace('{first}', lead.first_name ? ` ${titleCase(lead.first_name.trim())}` : '')
    .replace('{who}', who)
    .replace('{property}', propertyLabel(lead, listing))
    .replace('{platform}', platformPhrase(lead.platform))
    .replace('{availability}', availabilityPhrase(listing))
    .replace('{details}', emailDetails(listing, links))
    .replace('{sms_link}', smsLink)
    .replace('{in_city}', city)
    .replaceAll('{profile}', config.crexiProfileUrl);
}

async function approvalText(a, lead) {
  const msgs = await db.listMessages(lead.id, 10);
  const lastIn = [...msgs].reverse().find((m) => m.direction === 'in')?.body;
  return [
    `#${a.id} ${leadLabel(lead)} [${a.kind}${a.reason ? `: ${a.reason}` : ''}]`,
    lastIn ? `Them: "${lastIn}"` : null,
    `Draft: "${a.draft}"`,
    `Y${a.id} send · N${a.id} skip · E${a.id} <your text> · T${lead.id} take over`,
  ].filter(Boolean).join('\n');
}

const useEmail = (lead) => lead.preferred_channel === 'email' || (!lead.phone && lead.email);
const viaEmail = (lead, channel) => (channel ? channel === 'email' : useEmail(lead));

/** Send via email (Outlook draft or send, per EMAIL_SEND_MODE). attachments: documents to attach from Dropbox. */
export async function sendViaEmail(lead, text, kind, onSend = {}, attachments = []) {
  if (config.email.mode === 'off') { await notifyOwner(`Email not configured. Draft for ${leadLabel(lead)} (${lead.email}):\n${text}`); return { skipped: 'email_off' }; }
  const files = [];
  for (const doc of attachments) {
    try {
      const buf = await download(doc.dropbox_id);
      if (buf.length > config.email.maxAttachmentMb * 1024 * 1024) { await notifyOwner(`${doc.filename} is ${(buf.length / 1048576).toFixed(1)} MB, too big to attach for ${leadLabel(lead)}. Send it manually.`); continue; }
      files.push({ name: doc.filename, buffer: buf });
    } catch (e) { await notifyOwner(`Couldn't fetch ${doc.filename} from Dropbox for ${leadLabel(lead)}: ${e.message}`); }
  }
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  const subject = lead.email_thread_subject || propertyLabel(lead, listing);
  try {
    const r = await sendEmail({ to: lead.email, cc: config.email.leadCc, subject, text, attachments: files, inReplyToId: lead.email_last_message_id || null });
    await db.insertMessage({ lead_id: lead.id, direction: 'out', channel: 'email', body: text, status: r.mode === 'sent' ? 'sent' : 'drafted', kind, meta: { graph_id: r.id, attachments: files.map((f) => f.name) } });
    if (r.mode === 'sent') await db.updateLead(lead.id, { last_outbound_at: iso(), email_thread_subject: subject, ...onSend });
    else await notifyOwner(`Email draft ready in Outlook for ${leadLabel(lead)}${files.length ? ` with ${files.map((f) => f.name).join(', ')}` : ''}. Review and send from Outlook/Superhuman.`);
    return { [r.mode]: true, email: true };
  } catch (e) {
    await notifyOwner(`Email FAILED to ${leadLabel(lead)}: ${e.message}`);
    return { failed: true, error: e.message };
  }
}

/** Send immediately (guardrails already passed or Pierce approved). */
export async function sendNow(lead, text, kind, onSend = {}, attachments = [], channel, { quietFail = false } = {}) {
  if (viaEmail(lead, channel)) return sendViaEmail(lead, text, kind, onSend, attachments);
  if (await db.isOptedOut(lead.phone)) return { skipped: 'opted_out' };
  const body = cleanSms(text);
  try {
    const res = await sendSms(lead.phone, body);
    await db.insertMessage({ lead_id: lead.id, direction: 'out', channel: 'sms', body, status: 'sent', kind, rc_message_id: String(res?.id ?? '') });
    if (attachments.length) await notifyOwner(`${leadLabel(lead)} needs ${attachments.map((d) => d.filename).join(', ')} by email (no public Dropbox link).${lead.email ? ` Their email: ${lead.email}` : ' No email on file.'}`);
    const updated = await db.updateLead(lead.id, { last_outbound_at: iso(), ...onSend });
    if (onSend.status) await hubspot.syncDealStage(lead.id);
    return { sent: true, lead: updated };
  } catch (e) {
    await db.insertMessage({ lead_id: lead.id, direction: 'out', body, status: 'failed', kind, meta: { error: e.message } });
    if (!quietFail) await notifyOwner(`Send FAILED to ${leadLabel(lead)}: ${e.message}`); // quietFail: the caller tells Pierce (once)
    return { failed: true, error: e.message };
  }
}

export async function scheduleSend(lead, text, kind, onSend = {}, { delaySec = 0 } = {}) {
  const sendAt = new Date(Math.max(+nextWindowStart(config.replyWindow), +now() + delaySec * 1000));
  await db.insertMessage({ lead_id: lead.id, direction: 'out', body: cleanSms(text), status: 'scheduled', kind, send_at: sendAt.toISOString(), meta: { on_send: onSend } });
  return { scheduled: sendAt.toISOString() };
}

/**
 * The single gate every bot-written message passes through.
 * Order: opt-out -> per-lead rate limit -> policy (auto / approve / block) -> time window -> send.
 */
export async function deliver(lead, text, { kind, forceApproval = false, reason, onSend = {}, attachments = [], flags = {}, decision = {}, human = false, channel, pace = false, quietFail = false }) {
  const email = viaEmail(lead, channel);
  if (!text || !String(text).trim()) return { skipped: 'empty' };
  if (lead.phone && (await db.isOptedOut(lead.phone))) return { skipped: 'opted_out' };
  if (!lead.phone && !lead.email) return { skipped: 'no_contact' };
  if (email ? !lead.email : !lead.phone) return { skipped: 'no_contact' };

  // Runaway guard, not a conversation cap (Pierce, Nov 2 2026: "we need to respond to text and email effectively").
  // A buyer who keeps writing keeps getting answers; what's capped is messages they haven't answered, plus a high daily
  // ceiling. A held REPLY goes to Pierce as a Y# draft instead of being dropped.
  const dayAgo = new Date(+now() - 864e5).toISOString();
  const sentToday = await db.countOutboundSince(lead.id, dayAgo);
  const lastIn = lead.last_inbound_at && lead.last_inbound_at > dayAgo ? lead.last_inbound_at : dayAgo;
  const unanswered = await db.countOutboundSince(lead.id, lastIn);
  const dayCap = limits().max_msgs_per_lead_per_day ?? config.maxMsgsPerLeadPerDay;
  const unansweredCap = limits().max_unanswered_msgs ?? 3;
  if (sentToday >= dayCap || unanswered >= unansweredCap) {
    const why = sentToday >= dayCap ? `${sentToday} msgs in 24h` : `${unanswered} msgs since they last wrote`;
    await audit('rate_limited', { leadId: lead.id, detail: { kind, sentToday, unanswered } });
    if (!['reply', 'answer'].includes(kind)) {
      await notifyOwner(`Rate limit for ${leadLabel(lead)} (${why}). Bot skipped a ${kind} message.`);
      return { skipped: 'rate_limit' };
    }
    forceApproval = true;
    reason = `rate limit (${why})`;
  }

  // The bot can't call: a draft claiming Pierce called / left a voicemail never goes out on its own.
  if (['reply', 'followup', 'first_touch'].includes(kind) && claimsContact(text)) {
    forceApproval = true;
    reason = 'says Pierce called or left a voicemail; the bot cannot call';
    await audit('blocked_false_claim', { leadId: lead.id, detail: { kind, text } });
  }
  // A Dropbox data room link opens a whole folder: only CA-verified buyers of that listing get it on the bot's own say-so.
  // Pierce's own A# answer to this buyer is his call; a stored answer reused later still passes through here.
  if (kind !== 'answer') {
    const roomIssue = dataRoomProblem(text, lead, lead.listing_id ? await db.getListing(lead.listing_id) : null);
    if (roomIssue) {
      forceApproval = true;
      reason = roomIssue;
      await audit('held_data_room_link', { leadId: lead.id, detail: { kind, reason: roomIssue } });
    }
  }
  const key = classify({ kind, lead, flags, decision, human, channel: email ? 'email' : 'sms' });
  const pol = await resolve(key, { countAutoSendsLastHour: await db.countAutoSendsSince(new Date(+now() - 3600e3).toISOString()) });
  if (pol.mode === 'block') { await audit('policy_block', { leadId: lead.id, detail: { kind, policy: key } }); return { blocked: pol.reason }; }

  if (forceApproval || pol.mode === 'approve') {
    const pending = await db.listPendingApprovals();
    if (kind !== 'reply' && pending.length >= (limits().max_pending_approvals ?? config.maxPendingApprovals)) return { deferred: 'approval_queue_full' };
    const a = await db.createApproval({
      lead_id: lead.id, kind, draft: email ? text : cleanSms(text),
      on_send: { ...onSend, _attachments: attachments.map((d) => d.id), _channel: email ? 'email' : 'sms' },
      policy: key, expires_at: new Date(+now() + (limits().approval_expires_hours ?? 48) * 3600e3).toISOString(),
      reason: reason || pol.reason || 'review',
    });
    await audit('approval_created', { leadId: lead.id, detail: { approval: a.id, kind, policy: key, reason: a.reason } });
    await notifyOwner(await approvalText(a, lead));
    return { approval: a };
  }

  if (!email && !isTestLead(lead) && !inWindow(kind === 'reply' ? config.replyWindow : config.sendWindow)) {
    if (kind === 'reply') return scheduleSend(lead, text, kind, onSend);
    return { deferred: 'outside_window' };
  }
  // Human pacing for texts: never two bot texts seconds apart, and paced kinds (Pierce's A# answers) wait a random beat.
  if (!email && !attachments.length) {
    const sinceLast = lead.last_outbound_at ? (+now() - +new Date(lead.last_outbound_at)) / 1000 : Infinity;
    const delaySec = pace ? randSec(config.pace) : sinceLast < config.minGapSec ? randSec({ minSec: config.minGapSec, maxSec: config.minGapSec * 2.5 }) : 0;
    if (delaySec > 0) {
      const s = await scheduleSend(lead, text, kind, onSend, { delaySec });
      await audit('scheduled', { leadId: lead.id, detail: { kind, policy: key, send_at: s.scheduled } });
      return s;
    }
  }
  const r = await sendNow(lead, text, kind, onSend, attachments, email ? 'email' : 'sms', { quietFail });
  if (r.sent || r.draft) await audit(r.sent ? 'sent' : 'drafted', { leadId: lead.id, detail: { kind, policy: key, chars: text.length, attachments: attachments.map((d) => d.filename) } });
  return r;
}

// ---------- first touch ----------
/** The email with the summary, listing page, flyer links and NDA link (first contact, or once a buyer texts their email). */
export async function sendIntroEmail(lead, listing, { onSend = {} } = {}) {
  await hubspot.ensureBuyerDeal(lead, listing);
  const links = await publicDocLinks(listing);
  const text = firstTouchText(lead, listing, { channel: 'email', links });
  const r = await deliver(lead, text, { kind: 'first_touch', channel: 'email', onSend });
  if (r.sent || r.draft) await hubspot.addNote(lead.id, `Intro email ${r.sent ? 'sent' : 'drafted in Outlook'}${links.length ? ` with ${links.map((l) => l.doc).join(', ')}` : ''}.`);
  return r;
}

/** RingCentral refused the number itself (landline, not SMS-capable, invalid): retrying will never work. */
export const smsUndeliverable = (err) => /landline|not\s+(?:sms|text)[- ]?(?:capable|enabled)|can(?:no|')t\s+receive\s+(?:sms|text)|not\s+a\s+(?:mobile|wireless|cell)|invalid\s+(?:"?to"?\s+|recipient\s+|destination\s+)?phone\s*number|InvalidPhoneNumber|MSG-24[06]\b/i.test(String(err || ''));

const FIRST_TOUCH_MAX_TRIES = 3;
const DAY_MS = 864e5;
/**
 * The first message didn't go (failed / blocked / skipped): park the lead instead of retrying every 20s.
 * Number can't take texts -> wrong_number. Otherwise retry in 24h, up to 3 tries, then no_response.
 * An emergency stop is not the lead's fault: park without using up a try. Pierce hears once per lead per failure type.
 */
async function parkFirstTouch(lead, r, step) {
  const type = r.failed ? 'failed' : r.blocked ? 'blocked' : 'skipped';
  const why = r.error || r.blocked || r.skipped || type;
  const state = { count: 0, notified: [], ...(lead.raw?.first_touch_retry || {}) };
  const tell = async (msg) => {
    if (state.notified.includes(type)) return;
    state.notified = [...state.notified, type];
    await notifyOwner(msg);
  };
  await audit('first_touch_parked', { leadId: lead.id, detail: { step, type, why } });
  if (step === 'sms' && r.skipped === 'opted_out') { await setStatus(lead, 'opted_out'); return { ...r, parked: 'opted_out' }; }
  if (step === 'sms' && r.failed && smsUndeliverable(r.error)) {
    await tell(`First text to ${leadLabel(lead)} FAILED: ${lead.phone} can't receive texts (${why}). Marked wrong number; reach them another way.`);
    lead = await db.updateLead(lead.id, { raw: { ...(lead.raw || {}), first_touch_retry: state } });
    await setStatus(lead, 'wrong_number');
    await hubspot.addNote(lead.id, `First text failed: number can't receive SMS (${why}).`);
    await syncNextStep(lead.id);
    return { ...r, parked: 'wrong_number' };
  }
  const counts = r.blocked !== 'emergency_stop';
  if (counts) state.count += 1;
  const what = step === 'sms' ? 'First text' : 'First email';
  if (counts && state.count >= FIRST_TOUCH_MAX_TRIES) {
    await tell(`${what} to ${leadLabel(lead)} didn't go out (${type}: ${why}). Closed after ${state.count} tries.`);
    lead = await db.updateLead(lead.id, { raw: { ...(lead.raw || {}), first_touch_retry: state } });
    await setStatus(lead, 'no_response');
    await hubspot.addNote(lead.id, `${what} could not be sent after ${state.count} tries (${type}: ${why}). Closed by setter bot.`);
    await syncNextStep(lead.id);
    return { ...r, parked: 'gave_up' };
  }
  await tell(`${what} to ${leadLabel(lead)} didn't go out (${type}: ${why}). ${counts ? `Retrying once a day, up to ${FIRST_TOUCH_MAX_TRIES} tries, then closing it.` : 'Holding it while the emergency stop is on.'}`);
  const at = new Date(+now() + DAY_MS).toISOString();
  await db.updateLead(lead.id, { next_action_at: at, raw: { ...(lead.raw || {}), first_touch_retry: state } });
  return { ...r, parked: 'retry', at };
}
const notSent = (r) => !!(r.failed || r.blocked || r.skipped);
const introOutcome = (r) => (r.sent ? 'sent' : r.draft ? 'drafted in Outlook, not sent yet' : r.approval ? 'waiting on Pierce' : `not sent (${r.failed ? 'failed' : r.blocked ? `blocked: ${r.blocked}` : `skipped: ${r.skipped}`})`);

/**
 * Pierce's sequence: 1-2 min after the inquiry, the email (any hour); ~5 min later, the text (send window only).
 * Leads with only one channel get just that one. Called by the fast job loop and right after intake.
 */
const firstTouchInFlight = new Set();
export async function processFirstTouch(lead) {
  // one claim per lead for every caller (job passes, intake, TEST): never two first texts / two deals for one lead.
  // Re-read after claiming so a caller holding a stale copy sees what an earlier run already sent.
  if (firstTouchInFlight.has(lead.id)) return { skipped: 'in_progress' };
  firstTouchInFlight.add(lead.id);
  try { return await firstTouchStep((await db.getLead(lead.id)) || lead); } finally { firstTouchInFlight.delete(lead.id); }
}

async function firstTouchStep(lead) {
  if (!['new', 'no_phone'].includes(lead.status)) return { skipped: 'not_new' };
  const emailOn = !!lead.email && config.email.mode !== 'off';
  if (!lead.phone && !emailOn) {
    // email-only lead while email is off: park it so it can't hold up newer leads; picked up once email is on
    if (!lead.next_action_at || new Date(lead.next_action_at) <= now()) await db.updateLead(lead.id, { next_action_at: new Date(+now() + DAY_MS).toISOString() });
    return { skipped: 'no_channel' };
  }
  if (lead.next_action_at && new Date(lead.next_action_at) > now()) return { deferred: 'pacing', at: lead.next_action_at };
  if (!lead.phone) lead = await db.updateLead(lead.id, { preferred_channel: 'email' });
  if (lead.phone && (await db.isOptedOut(lead.phone))) { await setStatus(lead, 'opted_out'); return { skipped: 'opted_out' }; }
  const listing = await getListing(lead);

  // step 1: email. first_email_at only when it really went to the buyer; raw.intro_email records what happened.
  if (emailOn && !lead.first_email_at && !lead.raw?.intro_email) {
    const r = await sendIntroEmail(lead, listing, { onSend: lead.phone ? {} : { status: 'contacted' } });
    if (r.deferred) { await db.updateLead(lead.id, { next_action_at: new Date(+now() + 30 * 60e3).toISOString() }); return { email: r }; }
    if (!lead.phone && notSent(r)) return parkFirstTouch(lead, r, 'email');
    const outcome = { raw: { ...(lead.raw || {}), intro_email: introOutcome(r) }, ...(r.sent ? { first_email_at: iso() } : {}) };
    if (!lead.phone) {
      if (r.approval) await db.updateLead(lead.id, { status: 'awaiting_approval', ...outcome });
      else await db.updateLead(lead.id, { ...outcome, ...(r.sent || r.draft ? { status: 'contacted' } : {}) });
      return r;
    }
    const wait = randSec(config.textAfterEmail);
    lead = await db.updateLead(lead.id, { ...outcome, next_action_at: new Date(+now() + wait * 1000).toISOString() });
    if (wait > 0) return { email: r, text: { deferred: 'after_email', at: lead.next_action_at } };
    return { ...(await firstTouchStep(lead)), email: r };
  }

  // step 2: text
  if (!lead.phone) return { skipped: 'no_phone' };
  if (!inWindow(config.sendWindow) && !isTestLead(lead)) {
    await db.updateLead(lead.id, { next_action_at: nextWindowStart(config.sendWindow).toISOString() });
    return { deferred: 'outside_window' };
  }
  await hubspot.ensureBuyerDeal(lead, listing);
  // "Just sent you an email" only when the email really went out (a draft or a held email has not reached them)
  const text = firstTouchText(lead, listing, { channel: 'sms', afterEmail: !!lead.first_email_at });
  const r = await deliver(lead, text, { kind: 'first_touch', channel: 'sms', onSend: { status: 'contacted' }, quietFail: true });
  if (r.approval) await db.updateLead(lead.id, { status: 'awaiting_approval' });
  else if (r.deferred) await db.updateLead(lead.id, { next_action_at: new Date(+now() + 30 * 60e3).toISOString() });
  else if (r.scheduled) await db.updateLead(lead.id, { next_action_at: new Date(+new Date(r.scheduled) + 30 * 60e3).toISOString() }); // the queued text sets 'contacted'
  else if (notSent(r)) return parkFirstTouch(lead, r, 'sms');
  if (r.sent) await hubspot.addNote(lead.id, `First text sent: "${text}"`);
  await syncNextStep(lead.id);
  return r;
}

// ---------- inbound ----------
export async function handleInboundSms(phone, text, rcMessageId) {
  let lead = await db.findLeadByPhone(phone);
  if (!lead) {
    lead = await db.insertLead({ phone, source: 'inbound_sms', status: 'engaged', auto_send: !!config.autoSend.inbound_sms });
    await notifyOwner(`New text from unknown number ${phone}: "${text}" (L${lead.id})`);
  }
  await db.insertMessage({ lead_id: lead.id, direction: 'in', body: text, status: 'received', rc_message_id: rcMessageId || null });
  await audit('received', { leadId: lead.id, detail: { chars: text.length } });
  lead = await captureEmail(lead, text);
  await db.supersedeApprovalsForLead(lead.id); // drafts written before this reply are stale
  await db.cancelScheduledForLead(lead.id);
  lead = await db.updateLead(lead.id, { last_inbound_at: iso(), followup_count: 0 });

  const opt = optOutIntent(text);
  if (opt) {
    await db.addOptOut(phone, opt);
    await audit('opted_out', { leadId: lead.id, detail: { how: opt } });
    await setStatus(lead, opt === 'wrong_number' ? 'wrong_number' : 'opted_out');
    // carrier STOP keywords get an automatic confirmation; only confirm natural-language opt-outs
    if (opt !== 'keyword') {
      const body = "Understood, you won't get any more texts from us.";
      try { await sendSms(phone, body); await db.insertMessage({ lead_id: lead.id, direction: 'out', body, status: 'sent', kind: 'opt_out_confirm' }); } catch { /* best effort */ }
    }
    await hubspot.addNote(lead.id, `Opted out by text: "${text}"`);
    return { optedOut: opt };
  }
  if (await db.isOptedOut(phone)) {
    if (isStartKeyword(text)) { await db.removeOptOut(phone); await setStatus(lead, 'engaged'); return { resubscribed: true }; }
    return { ignored: 'opted_out' };
  }
  if (MUTED.has(lead.status)) {
    await notifyOwner(`${leadLabel(lead)} replied (your thread, bot muted): "${text}"`);
    return { forwarded: true };
  }
  if (['new', 'awaiting_approval', 'contacted', 'disqualified', 'no_response', 'nurture'].includes(lead.status)) lead = await setStatus(lead, 'engaged');
  return queueReply(lead);
}

/** A buyer's email reply (from the inbox poller). Mirrors handleInboundSms; the answer goes back in the same thread. */
export async function handleInboundEmail(lead, { id, conversationId, subject, text, receivedAt }) {
  await db.insertMessage({ lead_id: lead.id, direction: 'in', channel: 'email', body: text.slice(0, 4000), status: 'received', meta: { graph_id: id, conversation_id: conversationId || null, received_at: receivedAt || null } });
  await audit('received', { leadId: lead.id, detail: { channel: 'email', chars: text.length } });
  await db.supersedeApprovalsForLead(lead.id);
  await db.cancelScheduledForLead(lead.id);
  lead = await db.updateLead(lead.id, {
    last_inbound_at: receivedAt || iso(), followup_count: 0, email_last_message_id: id,
    email_thread_subject: lead.email_thread_subject || String(subject || '').replace(/^(re|fw|fwd):\s*/i, '') || null,
  });
  const opt = optOutIntent(text.split('\n')[0]) || (/\b(unsubscribe|remove me|stop emailing|take me off)\b/i.test(text) ? 'phrase' : null);
  if (opt) {
    if (lead.phone) await db.addOptOut(lead.phone, `email:${opt}`);
    await audit('opted_out', { leadId: lead.id, detail: { how: `email:${opt}` } });
    await setStatus(lead, 'opted_out');
    await hubspot.addNote(lead.id, `Opted out by email: "${text.slice(0, 200)}"`);
    await syncNextStep(lead.id);
    return { optedOut: opt };
  }
  if (MUTED.has(lead.status)) {
    await notifyOwner(`${leadLabel(lead)} emailed (your thread, bot muted): "${text.slice(0, 300)}"`);
    return { forwarded: true };
  }
  if (['new', 'no_phone', 'awaiting_approval', 'contacted', 'disqualified', 'no_response', 'nurture'].includes(lead.status)) lead = await setStatus(lead, 'engaged');
  return queueReply(lead);
}

/**
 * A buyer texting their email (we ask for it when the inquiry had none): save it and send the intro email with the
 * NDA/OM links (cc Dylan). If email isn't connected yet, Pierce is told to send it by hand. The reply that follows
 * sees `intro_email` in the prompt, so it never claims an email went out when it didn't.
 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
async function captureEmail(lead, text) {
  const found = String(text || '').match(EMAIL_RE)?.[0]?.toLowerCase();
  if (!found || found === lead.email) return lead;
  lead = await db.updateLead(lead.id, { email: found });
  await audit('email_captured', { leadId: lead.id, detail: { email: found } });
  if (lead.first_email_at) return lead;
  const listing = await getListing(lead);
  if (config.email.mode === 'off') {
    await notifyOwner(`${leadLabel(lead)} sent their email (${found}). Email isn't connected yet, so send them the OM and info yourself.`);
    return db.updateLead(lead.id, { raw: { ...(lead.raw || {}), intro_email: 'pending: email not connected, Pierce sending by hand' } });
  }
  const r = await sendIntroEmail(lead, listing);
  return db.updateLead(lead.id, { first_email_at: iso(), raw: { ...(lead.raw || {}), intro_email: r.sent ? 'sent' : r.draft ? 'drafted' : r.approval ? 'waiting on Pierce' : 'not sent' } });
}

// ---------- human pacing ----------
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
/** Wait a human-like 1-5 min; more texts in the meantime push it back (capped) so a burst gets one answer. */
export async function queueReply(lead) {
  const { minSec, maxSec, capSec } = config.replyDelay;
  if (maxSec <= 0) return respondNow(lead);
  const t = +now();
  const since = lead.reply_pending_since ? +new Date(lead.reply_pending_since) : t;
  let due = t + rand(minSec, maxSec) * 1000;
  if (lead.reply_due_at) due = Math.max(+new Date(lead.reply_due_at), t + 45e3);
  due = Math.min(due, since + capSec * 1000);
  await db.updateLead(lead.id, { reply_due_at: new Date(due).toISOString(), reply_pending_since: new Date(since).toISOString() });
  return { queued: new Date(due).toISOString() };
}

/** Called by the fast job loop when a queued reply is due. */
export async function processDueReplies() {
  const out = [];
  for (const lead of await db.listLeadsReplyDue()) out.push({ id: lead.id, ...(await respondNow(lead)) });
  return out;
}

export async function respondNow(lead) {
  lead = await db.updateLead(lead.id, { reply_due_at: null, reply_pending_since: null });
  if (MUTED.has(lead.status) || (await db.isOptedOut(lead.phone))) return { skipped: 'muted' };
  const listing = await getListing(lead);
  const messages = await db.listMessages(lead.id);
  const lastOutIdx = messages.map((m) => m.direction).lastIndexOf('out');
  const inboundText = messages.slice(lastOutIdx + 1).filter((m) => m.direction === 'in').map((m) => m.body).join('\n');
  // reply on the channel they used
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  const channel = lastIn?.channel === 'email' && lead.email ? 'email' : lead.phone ? 'sms' : 'email';
  // email thread: if Pierce already answered by hand since their email, stay out of it
  if (channel === 'email' && lastIn?.meta?.conversation_id && (await sentInConversationSince(lastIn.meta.conversation_id, lastIn.meta.received_at || lastIn.created_at))) {
    await audit('skipped_pierce_replied', { leadId: lead.id, detail: { conversation: lastIn.meta.conversation_id } });
    return { skipped: 'pierce_replied' };
  }
  const ctx = { lead, listing, flags: { usedSensitive: false, links: [], needsAttachment: [] } };
  let d;
  try {
    d = await runSetter({
      lead: { ...lead, preferred_channel: channel }, listing, messages, mode: 'reply', executors: makeExecutors(ctx),
      kb: await db.listQa(listing?.id ?? null), openQuestions: await db.listOpenOwnerQuestions(lead.id),
    });
  } catch (e) {
    await notifyOwner(`Bot error on ${leadLabel(lead)}: ${e.message}\nThey said: "${inboundText}" — reply manually.`);
    return { error: e.message };
  }
  return applyDecision(lead, d, { inboundText, kind: 'reply', flags: ctx.flags, channel });
}

/** Pierce answered an open question (A12 ...): save it for future buyers, reply to this one. */
export async function answerOwnerQuestion(id, answer) {
  const q = await db.getOwnerQuestion(id);
  if (!q || q.status !== 'open') return { error: 'not_open' };
  const lead = await db.getLead(q.lead_id);
  // word it first: if that fails, Q stays open and nothing is saved, so his A# can simply be sent again
  let text;
  try { text = await polishAnswer({ lead, question: q.question, answer }); } catch (e) {
    await audit('answer_failed', { leadId: lead.id, actor: 'system', detail: { question: id, error: e.message } });
    await notifyOwner(`Your A${id} didn't go out (${e.message}). Q${id} is still open: text A${id} again, or reply to ${leadLabel(lead)} yourself.`);
    return { error: 'polish_failed' };
  }
  await db.updateOwnerQuestion(id, { status: 'answered', answer, answered_at: iso() });
  await db.addQa({ listing_id: q.listing_id ?? null, question: q.question, answer });
  await audit('answered', { leadId: lead.id, actor: 'pierce', detail: { question: id, answer } });
  const r = await deliver(lead, text, { kind: 'answer', pace: true });
  await hubspot.addNote(lead.id, `Pierce answered "${q.question}": ${answer}`);
  return { lead, ...r };
}

const TOPIC_STOP = new Set('the a an of and or to in on for is are was were be it this that with what how many much does do any there their at by from as you your can could would will has have had about just also please every each all buyer buyers ask asks asked asking wants want know question pierce'.split(' '));
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|ly)$/, '') : w).replace(/(x|sh|ch|ss)es$/, '$1').replace(/([^s])s$/, '$1');
const topicWords = (s, ignore = new Set()) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9$%\s]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 1 && !TOPIC_STOP.has(w) && !ignore.has(w)).map(stem).filter((w) => !ignore.has(w)));
/**
 * Same question in other words (non-negotiable 7 dedupe). Strict on purpose: boilerplate ("buyer asks"), the listing's
 * and the lead's names are dropped, then the two word sets must nearly coincide (Jaccard over the union >= 0.8).
 * Water vs sewer, "how many RV sites" vs "do the RV sites have hookups" are different questions. When in doubt: new Q#.
 */
const normQ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function sameTopic(a, b, ignoreText = []) {
  const ignore = new Set([].concat(ignoreText).join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).flatMap((w) => [w, stem(w)]));
  const A = topicWords(a, ignore); const B = topicWords(b, ignore);
  if (!A.size || !B.size) return false;
  const both = [...A].filter((w) => B.has(w)).length;
  return both / (A.size + B.size - both) >= 0.8;
}

export async function applyDecision(lead, d, { inboundText = '', kind = 'reply', flags = {}, channel } = {}) {
  const prevCriteria = lead.qualification?.criteria;
  const qualification = { ...(lead.qualification || {}), ...(d.qualification || {}) };
  d._prevStatus = lead.status;
  lead = await db.updateLead(lead.id, { qualification, summary: d.summary || lead.summary });

  let nextStatus = null;
  if (d.action === 'booked') nextStatus = 'booked';
  else if (d.action === 'escalate') nextStatus = 'escalated';
  else if (d.action === 'disqualify') nextStatus = 'disqualified';
  else if (d.qualified && ['engaged', 'contacted'].includes(lead.status)) nextStatus = 'qualified';
  if (nextStatus && nextStatus !== lead.status) lead = await setStatus(lead, nextStatus);

  if (nextStatus) await audit('status', { leadId: lead.id, detail: { from: d._prevStatus, to: nextStatus, summary: d.summary } });
  const listingNow = await getListing(lead);
  if (listingNow && !isAvailable(listingNow) && d.qualification?.criteria && d.qualification.criteria !== prevCriteria) {
    await notifyOwner(`MATCH ${leadLabel(lead)} asked about ${propertyLabel(lead, listingNow)} (${availabilityPhrase(listingNow)}). Looking for: ${d.qualification.criteria}`);
    await hubspot.addNote(lead.id, `Inquired on ${availabilityPhrase(listingNow)} listing. Criteria: ${d.qualification.criteria}`);
  }
  if (nextStatus === 'booked') {
    await notifyOwner(`BOOKED: ${leadLabel(lead)} — ${qualification.call_time || 'time TBD'}. ${d.summary || ''}\nSend the calendar invite.`);
    await hubspot.addNote(lead.id, verifiedBuyerNote(lead, listingNow, `Call booked: ${qualification.call_time || 'time TBD'}`));
    await callTask(lead, { key: 'booked', why: `Call booked for ${qualification.call_time || 'a time TBD'}`, hot: true, notify: false, talkingPoints: d.call_talking_points });
  } else if (nextStatus === 'qualified') {
    await hubspot.addNote(lead.id, verifiedBuyerNote(lead, listingNow, d.summary || 'Qualified'));
  } else if (nextStatus === 'escalated' || nextStatus === 'disqualified') {
    await hubspot.addNote(lead.id, `${nextStatus}: ${d.escalation_reason || d.summary || ''}`);
  }
  // calls are Pierce's: the bot sets them up as HubSpot tasks (elite-cre-sales skill, section 0)
  const today = iso().slice(0, 10);
  if (nextStatus === 'escalated') await callTask(lead, { key: `escalated:${today}`, why: d.escalation_reason || 'needs your judgment (price, terms or legal)', hot: true, notify: false, talkingPoints: d.call_talking_points });
  else if (asksForTour(inboundText)) await callTask(lead, { key: 'tour', why: 'asked about a tour (bot never schedules tours)', hot: true, talkingPoints: d.call_talking_points });
  else if (d.needs_call) await callTask(lead, { key: `call:${today}`, why: d.call_reason || 'a call is the right next step', hot: true, talkingPoints: d.call_talking_points });
  if (qualification.exchange_deadline && !lead.hubspot_tasks?.['1031']) await callTask(lead, { key: '1031', why: `1031 clock: ${qualification.exchange_deadline}`, hot: true, talkingPoints: d.call_talking_points });

  if (d.action === 'ask_pierce') {
    // non-negotiable 7: one open question (and one holding reply) per topic. The same question again waits on the open Q#.
    // Only the same listing's open questions count, and names/boilerplate don't make two questions "the same".
    const asked = d.question_for_pierce || inboundText;
    const listing = await getListing(lead);
    const names = [listing?.name, lead.property_name, lead.first_name, lead.last_name].filter(Boolean);
    const dup = (await db.listOpenOwnerQuestions(lead.id))
      .find((q) => (q.listing_id ?? null) === (lead.listing_id ?? null) && sameTopic(q.question, asked, names));
    if (dup) {
      await audit('ask_pierce_deduped', { leadId: lead.id, detail: { question: dup.id, text: asked } });
      // never lose the buyer's wording: if it differs from the open Q, Pierce sees it (no new Q#, no second holding reply)
      if (normQ(asked) !== normQ(dup.question)) await notifyOwner(`Asked again (Q${dup.id}) ${leadLabel(lead)}: "${asked}"\nNo second holding reply sent. A${dup.id} answers both.`);
      await syncNextStep(lead.id);
      return { action: 'ask_pierce', deduped: dup.id };
    }
    const q = await db.createOwnerQuestion({ lead_id: lead.id, listing_id: lead.listing_id ?? null, question: d.question_for_pierce || inboundText });
    await audit('asked_pierce', { leadId: lead.id, detail: { question: q.id, text: q.question } });
    await notifyOwner([
      `Q${q.id} ${leadLabel(lead)} asks: "${q.question}"`,
      listing ? `Listing: ${listing.name}` : null,
      d.summary ? `Context: ${d.summary}` : null,
      `Reply A${q.id} <your answer>. I'll word it for them and save it for future buyers.`,
    ].filter(Boolean).join('\n'));
  }

  if (d.action === 'no_reply' || !d.reply_text?.trim()) {
    if (d.action === 'escalate') await notifyOwner(`ESCALATED ${leadLabel(lead)}: ${d.escalation_reason || d.summary}\nThey said: "${inboundText}"`);
    await syncNextStep(lead.id);
    return { action: d.action };
  }
  const human = needsHuman(inboundText);
  const r = await deliver(lead, d.reply_text, {
    kind, flags, decision: d, human, channel,
    attachments: flags.needsAttachment || [],
    reason: d.escalation_reason || (human ? 'sensitive topic (price/terms/legal)' : flags.usedSensitive ? 'answer uses sensitive docs (inspections/water/leases)' : undefined),
  });
  if (flags.links?.length && (r.sent || r.scheduled)) await hubspot.addNote(lead.id, `Sent view-only link(s): ${flags.links.map((l) => l.doc).join(', ')}`);
  await syncNextStep(lead.id);
  return { action: d.action, ...r };
}

// ---------- call tasks, CRM logging, next step ----------
const fullName = (lead) => [lead.first_name, lead.last_name].filter(Boolean).map(titleCase).join(' ') || 'Buyer';
const BUY_BOX = [['criteria', 'Buy box'], ['buyer_type', 'Buyer type'], ['owns_parks', 'Owns'], ['financing', 'Capital'], ['equity', 'Equity'], ['proof_of_funds', 'POF'], ['exchange_deadline', '1031'], ['timeline', 'Timeline'], ['decision_maker', 'Decision-maker']];
const buyBox = (q = {}) => BUY_BOX.filter(([k]) => q[k]).map(([k, label]) => `${label}: ${q[k]}`).join('; ');
function defaultTalkingPoints(q = {}) {
  const ask = [];
  if (!q.criteria) ask.push('What does your buy box look like (asset, size, price, markets)?');
  if (!q.financing) ask.push('How are you financing: cash, bank debt, seller carry, 1031?');
  if (!q.timeline) ask.push('Timeline, and who else is involved in the decision?');
  ask.push('If I found the right deal in that box, how fast could you move?');
  return ask.join(' ');
}

/** HubSpot "verified buyer" note (elite-cre-sales skill, section 10): property, buy box, capital, timeline, next step. */
function verifiedBuyerNote(lead, listing, nextStepText) {
  const q = lead.qualification || {};
  return [
    `Verified buyer: ${fullName(lead)}${lead.company ? ` (${lead.company})` : ''}`,
    `Property: ${propertyLabel(lead, listing)}`,
    `Buy box: ${q.criteria || 'not stated yet'}${q.buyer_type ? `; ${q.buyer_type}` : ''}${q.owns_parks ? `; owns ${q.owns_parks}` : ''}`,
    `Capital: ${[q.financing, q.equity && `equity ${q.equity}`, q.proof_of_funds && `POF ${q.proof_of_funds}`].filter(Boolean).join(', ') || 'not stated yet'}`,
    `Timeline: ${[q.timeline, q.exchange_deadline && `1031 ${q.exchange_deadline}`].filter(Boolean).join(', ') || 'not stated yet'}`,
    `Decision-maker: ${q.decision_maker || 'not stated yet'}`,
    `Next step: ${nextStepText}`,
  ].join('\n');
}

/** Next business day at CALL_TASK_HOUR, Pierce's time. */
const nextBusinessMorning = () => {
  const from = new Date(+now() + 16 * 3600e3); from.setUTCMinutes(0, 0, 0); // on the hour, not 9:06
  return nextWindowStart({ start: config.callTaskHour, end: config.callTaskHour + 1, days: [1, 2, 3, 4, 5] }, from);
};

/**
 * The bot can't call, so a call becomes a HubSpot task for Pierce with everything he needs. Hot = due now and he
 * gets a text; otherwise due next business morning. Once per lead per key. If HubSpot is off or fails, he gets a text.
 */
export async function callTask(lead, { key, why, hot = false, notify = true, talkingPoints }) {
  lead = await db.getLead(lead.id);
  if (lead.hubspot_tasks?.[key]) return lead.hubspot_tasks[key];
  const listing = await getListing(lead);
  const said = (await db.listMessages(lead.id)).filter((m) => m.direction === 'in').slice(-3).map((m) => `"${m.body.slice(0, 200)}"`);
  const prop = propertyLabel(lead, listing);
  const body = [
    `Why: ${why}`,
    `Phone: ${lead.phone || 'none'} · Email: ${lead.email || 'none'}`,
    `Property: ${prop}${listing && !isAvailable(listing) ? ` (${availabilityPhrase(listing)})` : ''}`,
    `They said: ${said.join(' / ') || 'nothing yet'}`,
    `Buy box: ${buyBox(lead.qualification) || 'unknown'}`,
    `Talking points: ${talkingPoints || defaultTalkingPoints(lead.qualification)}`,
  ].join('\n');
  const dueAt = (hot ? now() : nextBusinessMorning()).toISOString();
  const id = await hubspot.createTask(lead.id, { key, subject: `Call ${fullName(lead)} re ${prop}`, body, dueAt, priority: hot ? 'HIGH' : 'MEDIUM' });
  if (!id) await db.updateLead(lead.id, { hubspot_tasks: { ...(lead.hubspot_tasks || {}), [key]: 'texted' } });
  if (!id || (hot && notify)) await notifyOwner(`CALL ${leadLabel(lead)} ${lead.phone || ''}: ${why}.${id ? ' Task is in HubSpot.' : `\n${body}`}`);
  await audit('call_task', { leadId: lead.id, detail: { key, hot, hubspot_task: id || null, why } });
  return id;
}

const localDay = (d) => new Date(d).toLocaleDateString('en-US', { timeZone: config.timezone, weekday: 'short', month: 'short', day: 'numeric' });

/** One line for the deal's Next step field. No lead ever sits without a next action. */
export async function describeNextStep(lead) {
  const q = lead.qualification || {};
  switch (lead.status) {
    case 'new': return 'First email and text going out now';
    case 'no_phone': return 'First email going out now';
    case 'awaiting_approval': return 'First message waiting on Pierce\'s Y';
    case 'booked': return `Pierce: call ${q.call_time || '(time TBD)'}`;
    case 'escalated': return 'Pierce: respond (price, terms, legal or a judgment call)';
    case 'human': return 'Pierce owns this thread';
    case 'opted_out': case 'wrong_number': return 'None: opted out. Do not contact.';
    case 'disqualified': return 'None: not a buyer';
    case 'no_response': return 'None: no reply after the full cadence';
    default: break;
  }
  if (lead.reply_due_at) return 'Bot replying now';
  const open = await db.listOpenOwnerQuestions(lead.id);
  if (open.length) return `Pierce: answer Q${open[0].id}, then bot replies`;
  if (lead.last_inbound_at && (!lead.last_outbound_at || lead.last_inbound_at > lead.last_outbound_at)) return 'Bot replying now';
  const plan = followupPlan(lead);
  if (plan?.dueAt) return `Bot follow-up by ${plan.channel === 'email' ? 'email' : 'text'} ${localDay(plan.dueAt)} if no reply`;
  return lead.status === 'in_dd' ? 'Pierce: decide on a personal call (DD follow-ups done)' : 'Bot closes out or moves to the long-term email list';
}

export async function syncNextStep(leadId) {
  const lead = await db.getLead(leadId);
  if (!lead) return;
  const text = await describeNextStep(lead);
  if (text === lead.next_step) return;
  await db.updateLead(leadId, { next_step: text });
  await hubspot.setNextStep(leadId, text);
}

// ---------- follow-ups ----------
const STEP_GUIDE = {
  second_touch: 'Day 1, second touch: a quick note. Point them to the email or the NDA link and ask one question.',
  value_touch: 'Day 3, value touch: one relevant, verified fact about the listing (use the tools) or another active listing that fits, then one question.',
  still_looking: 'Day 7: "Still in the market for [asset type] in [market]?" Use what you know of their buy box.',
  nurture: 'Long-term touch: one of the other active listings that fits their buy box (from OTHER ACTIVE LISTINGS), or if nothing fits, the 9-word email: "Hi [First], are you still looking for MH or RV parks?"',
};
const DAY = 864e5;

/**
 * Next follow-up for a lead waiting on their reply: { dueAt, channel, step } or { done } or null.
 * Pre-CA: days 1, 3, 7 (text and email alternate when we have both), then long-term by email every 2 weeks to
 * day 91 and monthly after (elite-cre-sales skill). In DD: days 2, 5, 10, 21, then Pierce decides.
 */
export function followupPlan(lead) {
  if (!lead.last_outbound_at) return null;
  const emailOk = !!lead.email && config.email.mode !== 'off';
  const smsOk = !!lead.phone;
  const last = +new Date(lead.last_outbound_at);
  const n = lead.followup_count || 0;
  if (lead.status === 'nurture') {
    const age = (+now() - +new Date(lead.created_at || lead.last_outbound_at)) / DAY;
    const channel = emailOk ? 'email' : config.nurture.sms && smsOk ? 'sms' : null;
    if (!channel || (channel === 'sms' && age >= config.nurture.untilDay)) return { done: 'no_channel' };
    const gap = age < config.nurture.untilDay ? config.nurture.everyDays : config.nurture.monthlyDays;
    return { dueAt: new Date(last + gap * DAY), channel, step: 'nurture' };
  }
  const dd = lead.status === 'in_dd';
  const days = dd ? config.followupDaysDd : config.followupDays;
  if (n >= days.length) return { done: dd ? 'dd_done' : 'cadence_done' };
  const channel = emailOk && smsOk ? (n % 2 === 1 ? 'email' : 'sms') : smsOk ? 'sms' : 'email';
  const step = dd ? 'dd' : ['second_touch', 'value_touch', 'still_looking'][n] || 'still_looking';
  return { dueAt: new Date(last + (days[n] - (n > 0 ? days[n - 1] : 0)) * DAY), channel, step };
}

/** Pierce's TEST session: ends after its time limit; the test lead is muted so his cell gets no follow-ups. */
export async function expireOwnerTest() {
  const t = await db.getSetting('owner_test');
  if (!t || new Date(t.expires_at) > now()) return false;
  const lead = await db.getLead(t.lead_id);
  if (lead && !MUTED.has(lead.status)) await db.updateLead(lead.id, { status: 'human' });
  await db.setSetting('owner_test', null);
  return true;
}

export async function runFollowups() {
  await expireOwnerTest();
  if (!inWindow(config.sendWindow)) return { skipped: 'outside_window' };
  const results = [];
  const others = (await db.listListings()).filter((l) => isAvailable(l));
  for (const lead of await db.listLeadsAwaitingReply()) {
    if ((await db.listOpenOwnerQuestions(lead.id)).length) continue; // ball is in Pierce's court, not the buyer's
    const plan = followupPlan(lead);
    if (!plan) continue;
    const n = lead.followup_count || 0;
    if (plan.done === 'dd_done') {
      // never auto-close a buyer reviewing DD; tell Pierce once
      if (n === config.followupDaysDd.length) { await notifyOwner(`${leadLabel(lead)} has gone quiet in DD after ${n} follow-ups. Your call: a personal call, or let it rest.`); await db.updateLead(lead.id, { followup_count: n + 1 }); await syncNextStep(lead.id); }
      continue;
    }
    if (plan.done) {
      if (hoursSince(lead.last_outbound_at) < 48) continue;
      // email not connected yet: a lead WITH an email stays on the long-term list and gets emailed once email is on
      const emailLater = !!lead.email && config.email.mode === 'off';
      if (lead.status === 'nurture' && emailLater) continue;
      const canNurture = lead.status !== 'nurture' && (!!lead.email || (config.nurture.sms && lead.phone));
      await setStatus(lead, canNurture ? 'nurture' : 'no_response', canNurture ? { next_action_at: new Date(+now() + config.nurture.everyDays * DAY).toISOString() } : {});
      await hubspot.addNote(lead.id, canNurture ? `No reply after day 7. Moved to the long-term list: listing emails every 2 weeks to 3 months, then monthly, until they reply or opt out.${emailLater ? ' Emails start once email is connected.' : ''}` : 'No reply after full follow-up cadence. Closed out by setter bot.');
      await syncNextStep(lead.id);
      results.push({ id: lead.id, [canNurture ? 'nurture' : 'closed']: true });
      continue;
    }
    if (now() < plan.dueAt) continue;
    // a quiet lead after the first touch gets a call task for Pierce (next business morning), plus the follow-up note
    if (n === 0 && lead.status !== 'nurture' && lead.phone) await callTask(lead, { key: 'no_reply', why: 'no reply to the first email/text yet', hot: false });
    const listing = await getListing(lead);
    const messages = await db.listMessages(lead.id);
    const ctx = { lead, listing, flags: { usedSensitive: false, links: [], needsAttachment: [] } };
    let d;
    try {
      d = await runSetter({
        lead: { ...lead, preferred_channel: plan.channel }, listing, messages, mode: 'followup', executors: makeExecutors(ctx),
        kb: await db.listQa(listing?.id ?? null), followup: { step: plan.step, guide: STEP_GUIDE[plan.step] || '', number: n + 1 },
        otherListings: others.filter((l) => l.id !== listing?.id).map((l) => ({ name: publicListingName(l.name), city: l.city, summary: l.summary, crexi: l.crexi_url || l.hub_url })),
      });
    } catch (e) { console.error('[followup]', e.message); continue; }
    if (!d.reply_text?.trim() || d.action === 'no_reply') continue;
    const r = await deliver(lead, d.reply_text, {
      kind: 'followup', channel: plan.channel, flags: ctx.flags, attachments: ctx.flags.needsAttachment || [],
      reason: ctx.flags.usedSensitive ? 'follow-up uses sensitive docs or past correspondence' : undefined,
    });
    if (r.sent || r.scheduled || r.draft) await db.updateLead(lead.id, { followup_count: n + 1, ...(r.draft || r.scheduled ? { last_outbound_at: iso() } : {}) });
    if (r.approval) await db.updateLead(lead.id, { followup_count: n + 1, last_outbound_at: iso() }); // don't re-draft every tick
    if (d.needs_call) await callTask(lead, { key: `call:${iso().slice(0, 10)}`, why: d.call_reason || 'a call is the right next step', hot: true, talkingPoints: d.call_talking_points });
    await syncNextStep(lead.id);
    results.push({ id: lead.id, step: plan.step, channel: plan.channel, ...r });
  }
  return results;
}

// ---------- scheduled sends ----------
let sendingScheduled = false; // both job loops call this; never let two passes send the same row
export async function sendDueScheduled() {
  if (sendingScheduled) return;
  sendingScheduled = true;
  try { await sendDueScheduledOnce(); } finally { sendingScheduled = false; }
}

async function sendDueScheduledOnce() {
  // PAUSE and the emergency stop hold every queued text too: rows stay 'scheduled' and go once both are off
  if (policies().emergency_stop || (await isPaused())) return { held: policies().emergency_stop ? 'emergency_stop' : 'paused' };
  const sentNow = new Set();
  for (const m of await db.listDueScheduled()) {
    const lead = await db.getLead(m.lead_id);
    if (!lead || (await db.isOptedOut(lead.phone)) || (MUTED.has(lead.status) && m.kind !== 'owner_edit' && m.kind !== 'approved')) {
      await db.updateMessage(m.id, { status: 'cancelled' });
      continue;
    }
    const sinceLast = lead.last_outbound_at ? (+now() - +new Date(lead.last_outbound_at)) / 1000 : Infinity;
    if (sentNow.has(lead.id) || sinceLast < config.minGapSec) { // two due at once: space them like a person would
      await db.updateMessage(m.id, { send_at: new Date(+now() + randSec({ minSec: config.minGapSec, maxSec: config.minGapSec * 2.5 }) * 1000).toISOString() });
      continue;
    }
    sentNow.add(lead.id);
    try {
      await sendSms(lead.phone, m.body);
      await db.updateMessage(m.id, { status: 'sent', meta: { ...(m.meta || {}), sent_at: iso() } });
      await db.updateLead(lead.id, { last_outbound_at: iso(), ...(m.meta?.on_send || {}) });
    } catch (e) {
      await db.updateMessage(m.id, { status: 'failed', meta: { ...(m.meta || {}), error: e.message } });
      await notifyOwner(`Scheduled send FAILED to ${leadLabel(lead)}: ${e.message}`);
    }
  }
}
