// The setter: first touches, inbound replies, follow-ups, and the send/approve/schedule decision.
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { now, hoursSince } from '../clock.js';
import { sendSms } from '../ringcentral.js';
import { runSetter, polishAnswer } from '../llm.js';
import { makeExecutors } from './tools.js';
import { sendEmail } from '../email.js';
import { download, viewLink } from '../dropbox.js';
import { classify, resolve, limits, audit, policies } from '../policy.js';
import { optOutIntent, isStartKeyword, needsHuman, inWindow, nextWindowStart, cleanSms } from '../guardrails.js';
import { notifyOwner, leadLabel } from '../notify.js';
import * as hubspot from '../hubspot.js';
import { platformPhrase } from '../platforms.js';
import { publicListingName, isAvailable, availabilityPhrase } from '../listings.js';

const templates = JSON.parse(readFileSync(new URL('../../playbook/templates.json', import.meta.url), 'utf8'));
export const MUTED = new Set(['escalated', 'human', 'opted_out', 'wrong_number']);
const iso = () => now().toISOString();
/** Random whole seconds in [minSec, maxSec]: varied, never on a fixed beat. */
export const randSec = ({ minSec, maxSec }) => (maxSec <= 0 ? 0 : Math.round(minSec + Math.random() * Math.max(0, maxSec - minSec)));
export const isPaused = async () => (await db.getSetting('paused')) === true;

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
  return [
    listing.summary ? templates.email_details_summary.replace('{summary}', listing.summary) : '',
    page ? linkLine('Listing page', page) : '',
    ...links.map((l) => linkLine(l.label, l.url)),
    listing.ca_link ? templates.email_details_ca.replace('{ca_link}', listing.ca_link) : '',
  ].join('');
}

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
  const smsLink = open && listing?.ca_link && !lead.ca_verified ? templates.sms_link.replace('{ca_link}', listing.ca_link) : '';
  return tpl
    .replace('{first}', lead.first_name ? ` ${titleCase(lead.first_name.trim())}` : '')
    .replace('{who}', who)
    .replace('{property}', propertyLabel(lead, listing))
    .replace('{platform}', platformPhrase(lead.platform))
    .replace('{availability}', availabilityPhrase(listing))
    .replace('{details}', emailDetails(listing, links))
    .replace('{sms_link}', smsLink);
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
    const r = await sendEmail({ to: lead.email, subject, text, attachments: files, inReplyToId: lead.email_last_message_id || null });
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
export async function sendNow(lead, text, kind, onSend = {}, attachments = [], channel) {
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
    await notifyOwner(`Send FAILED to ${leadLabel(lead)}: ${e.message}`);
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
export async function deliver(lead, text, { kind, forceApproval = false, reason, onSend = {}, attachments = [], flags = {}, decision = {}, human = false, channel, pace = false }) {
  const email = viaEmail(lead, channel);
  if (!text || !String(text).trim()) return { skipped: 'empty' };
  if (lead.phone && (await db.isOptedOut(lead.phone))) return { skipped: 'opted_out' };
  if (!lead.phone && !lead.email) return { skipped: 'no_contact' };
  if (email ? !lead.email : !lead.phone) return { skipped: 'no_contact' };

  const sentToday = await db.countOutboundSince(lead.id, new Date(+now() - 864e5).toISOString());
  if (sentToday >= (limits().max_msgs_per_lead_per_day ?? config.maxMsgsPerLeadPerDay)) {
    await notifyOwner(`Rate limit hit for ${leadLabel(lead)} (${sentToday} msgs/24h). Bot held its reply.`);
    await audit('rate_limited', { leadId: lead.id, detail: { kind } });
    return { skipped: 'rate_limit' };
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

  if (!email && !inWindow(kind === 'reply' ? config.replyWindow : config.sendWindow)) {
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
  const r = await sendNow(lead, text, kind, onSend, attachments, email ? 'email' : 'sms');
  if (r.sent || r.draft) await audit(r.sent ? 'sent' : 'drafted', { leadId: lead.id, detail: { kind, policy: key, chars: text.length, attachments: attachments.map((d) => d.filename) } });
  return r;
}

// ---------- first touch ----------
/**
 * Pierce's sequence: 1-2 min after the inquiry, the email (any hour); ~5 min later, the text (send window only).
 * Leads with only one channel get just that one. Called by the fast job loop and right after intake.
 */
export async function processFirstTouch(lead) {
  if (!['new', 'no_phone'].includes(lead.status)) return { skipped: 'not_new' };
  const emailOn = !!lead.email && config.email.mode !== 'off';
  if (!lead.phone && !emailOn) return { skipped: 'no_channel' };
  if (lead.next_action_at && new Date(lead.next_action_at) > now()) return { deferred: 'pacing', at: lead.next_action_at };
  if (!lead.phone) lead = await db.updateLead(lead.id, { preferred_channel: 'email' });
  if (lead.phone && (await db.isOptedOut(lead.phone))) { await setStatus(lead, 'opted_out'); return { skipped: 'opted_out' }; }
  const listing = await getListing(lead);

  // step 1: email
  if (emailOn && !lead.first_email_at) {
    await hubspot.ensureBuyerDeal(lead, listing);
    const links = await publicDocLinks(listing);
    const text = firstTouchText(lead, listing, { channel: 'email', links });
    const r = await deliver(lead, text, { kind: 'first_touch', channel: 'email', onSend: lead.phone ? {} : { status: 'contacted' } });
    if (r.deferred) { await db.updateLead(lead.id, { next_action_at: new Date(+now() + 30 * 60e3).toISOString() }); return { email: r }; }
    if (r.sent || r.draft) await hubspot.addNote(lead.id, `First email ${r.sent ? 'sent' : 'drafted in Outlook'}${links.length ? ` with ${links.map((l) => l.doc).join(', ')}` : ''}.`);
    if (!lead.phone) {
      if (r.approval) await db.updateLead(lead.id, { status: 'awaiting_approval', first_email_at: iso() });
      else await db.updateLead(lead.id, { first_email_at: iso(), ...(r.sent || r.draft ? { status: 'contacted' } : {}) });
      return r;
    }
    const wait = randSec(config.textAfterEmail);
    lead = await db.updateLead(lead.id, { first_email_at: iso(), next_action_at: new Date(+now() + wait * 1000).toISOString() });
    if (wait > 0) return { email: r, text: { deferred: 'after_email', at: lead.next_action_at } };
    return { ...(await processFirstTouch(lead)), email: r };
  }

  // step 2: text
  if (!lead.phone) return { skipped: 'no_phone' };
  if (!inWindow(config.sendWindow)) {
    await db.updateLead(lead.id, { next_action_at: nextWindowStart(config.sendWindow).toISOString() });
    return { deferred: 'outside_window' };
  }
  await hubspot.ensureBuyerDeal(lead, listing);
  const text = firstTouchText(lead, listing, { channel: 'sms', afterEmail: !!lead.first_email_at });
  const r = await deliver(lead, text, { kind: 'first_touch', channel: 'sms', onSend: { status: 'contacted' } });
  if (r.approval) await db.updateLead(lead.id, { status: 'awaiting_approval' });
  else if (r.deferred) await db.updateLead(lead.id, { next_action_at: new Date(+now() + 30 * 60e3).toISOString() });
  if (r.sent) await hubspot.addNote(lead.id, `First text sent: "${text}"`);
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
  if (['new', 'awaiting_approval', 'contacted', 'disqualified', 'no_response'].includes(lead.status)) lead = await setStatus(lead, 'engaged');
  return queueReply(lead);
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
  const ctx = { lead, listing, flags: { usedSensitive: false, links: [], needsAttachment: [] } };
  let d;
  try {
    d = await runSetter({
      lead, listing, messages, mode: 'reply', executors: makeExecutors(ctx),
      kb: await db.listQa(listing?.id ?? null), openQuestions: await db.listOpenOwnerQuestions(lead.id),
    });
  } catch (e) {
    await notifyOwner(`Bot error on ${leadLabel(lead)}: ${e.message}\nThey said: "${inboundText}" — reply manually.`);
    return { error: e.message };
  }
  return applyDecision(lead, d, { inboundText, kind: 'reply', flags: ctx.flags });
}

/** Pierce answered an open question (A12 ...): save it for future buyers, reply to this one. */
export async function answerOwnerQuestion(id, answer) {
  const q = await db.getOwnerQuestion(id);
  if (!q || q.status !== 'open') return { error: 'not_open' };
  await db.updateOwnerQuestion(id, { status: 'answered', answer, answered_at: iso() });
  await db.addQa({ listing_id: q.listing_id ?? null, question: q.question, answer });
  const lead = await db.getLead(q.lead_id);
  const text = await polishAnswer({ lead, question: q.question, answer });
  await audit('answered', { leadId: lead.id, actor: 'pierce', detail: { question: id, answer } });
  const r = await deliver(lead, text, { kind: 'answer', pace: true });
  await hubspot.addNote(lead.id, `Pierce answered "${q.question}": ${answer}`);
  return { lead, ...r };
}

export async function applyDecision(lead, d, { inboundText = '', kind = 'reply', flags = {} } = {}) {
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
    await hubspot.addNote(lead.id, `Call booked: ${qualification.call_time || 'TBD'}. ${d.summary || ''} Qualification: ${JSON.stringify(qualification)}`);
  } else if (nextStatus === 'qualified') {
    await hubspot.addNote(lead.id, `Qualified by text. ${d.summary || ''} ${JSON.stringify(qualification)}`);
  } else if (nextStatus === 'escalated' || nextStatus === 'disqualified') {
    await hubspot.addNote(lead.id, `${nextStatus}: ${d.escalation_reason || d.summary || ''}`);
  }

  if (d.action === 'ask_pierce') {
    const listing = await getListing(lead);
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
    return { action: d.action };
  }
  const human = needsHuman(inboundText);
  const r = await deliver(lead, d.reply_text, {
    kind, flags, decision: d, human,
    attachments: flags.needsAttachment || [],
    reason: d.escalation_reason || (human ? 'sensitive topic (price/terms/legal)' : flags.usedSensitive ? 'answer uses sensitive docs (inspections/water/leases)' : undefined),
  });
  if (flags.links?.length && (r.sent || r.scheduled)) await hubspot.addNote(lead.id, `Sent view-only link(s): ${flags.links.map((l) => l.doc).join(', ')}`);
  return { action: d.action, ...r };
}

// ---------- follow-ups ----------
export async function runFollowups() {
  if (!inWindow(config.sendWindow)) return { skipped: 'outside_window' };
  const results = [];
  for (const lead of await db.listLeadsAwaitingReply()) {
    if ((await db.listOpenOwnerQuestions(lead.id)).length) continue; // ball is in Pierce's court, not the buyer's
    const n = lead.followup_count || 0;
    const dd = lead.status === 'in_dd';
    const days = dd ? config.followupDaysDd : config.followupDays;
    if (dd && n >= days.length) {
      // never auto-close a buyer reviewing DD; tell Pierce once
      if (n === days.length) { await notifyOwner(`${leadLabel(lead)} has gone quiet in DD after ${days.length} follow-ups. Your call: a personal call, or let it rest.`); await db.updateLead(lead.id, { followup_count: n + 1 }); }
      continue;
    }
    if (n >= days.length) {
      if (hoursSince(lead.last_outbound_at) >= 48) {
        await setStatus(lead, 'no_response');
        await hubspot.addNote(lead.id, 'No reply after full follow-up cadence. Closed out by setter bot.');
        results.push({ id: lead.id, closed: true });
      }
      continue;
    }
    const gapHours = (days[n] - (n > 0 ? days[n - 1] : 0)) * 24;
    if (hoursSince(lead.last_outbound_at) < gapHours) continue;
    const listing = await getListing(lead);
    const messages = await db.listMessages(lead.id);
    const ctx = { lead, listing, flags: { usedSensitive: false, links: [], needsAttachment: [] } };
    let d;
    try { d = await runSetter({ lead, listing, messages, mode: 'followup', executors: makeExecutors(ctx), kb: await db.listQa(listing?.id ?? null) }); } catch (e) { console.error('[followup]', e.message); continue; }
    if (!d.reply_text?.trim() || d.action === 'no_reply') continue;
    const r = await deliver(lead, d.reply_text, { kind: 'followup' });
    if (r.sent) await db.updateLead(lead.id, { followup_count: n + 1 });
    if (r.approval) await db.updateLead(lead.id, { followup_count: n + 1, last_outbound_at: iso() }); // don't re-draft every tick
    results.push({ id: lead.id, ...r });
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
