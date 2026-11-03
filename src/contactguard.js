// Contact awareness (Pierce, Nov 2 2026: "don't text people in communication like Matthew, he booked a call, got to be
// smarter, Jacob is in HubSpot as seller"). Before the bot sends anything it wrote on its own (first touch, replies,
// follow-ups, nurture, the intro email), it checks whether this person is already Pierce's:
//   seller            a HubSpot contact for this phone/email is on a Sellers-pipeline deal (every duplicate is checked)
//   meeting_booked    HubSpot shows a next activity (not one of the bot's own call tasks) or a meeting booked/held lately
//   pierce_in_touch   HubSpot "last contacted" in the last 14 days that isn't one of the bot's own sends
//   deal_with_pierce  a buyer deal for them is at Offer Out or later (non-negotiable 8)
//   pierce_texting    RingCentral shows a text to them in the last 30 days that the bot didn't send
// Any one: the bot steps back (lead muted, scheduled sends cancelled, audit row, one text to Pierce). B# overrides the
// time-based signals that were already there; a seller or a deal past Offer Out is never handed back by B#.
// Read-only toward HubSpot and RingCentral; a seller's records are never written to.
import { config } from './config.js';
import { db } from './db/index.js';
import { now } from './clock.js';
import * as hubspot from './hubspot.js';
import { listOutboundSms } from './ringcentral.js';
import { notifyOwner, leadLabel } from './notify.js';
import { audit } from './policy.js';

const DAY = 864e5;
export const GUARD = {
  cacheMs: 10 * 60e3,
  lastContactedDays: 14, // c) Pierce emailed/called/met them
  nextActivityGraceDays: 1, // b) a next activity up to a day in the past still counts
  meetingDays: 30, // b) meeting booked / meeting activity
  rcDays: 30, // e) Pierce texting them from the RingCentral line
  botSendMatchMin: 30, // c) a "last contacted" this close to one of the bot's own sends is the bot's (email logging)
  botTaskMatchMin: 15, // b) a next activity this close to one of the bot's own call tasks is the bot's
  rcBodyMatchMin: 10, // e) same text within this window = the bot's send
  rcTimeMatchSec: 120, // e) any bot text this close = the bot's send (RingCentral id not stored)
};
// a reply to a buyer who just wrote may still go while the lookups are down, but only for a platform inquiry the bot
// already contacted (Pierce, Nov 2 2026: fail closed for everything else)
const PLATFORM_SOURCES = new Set(['listing_email', 'webhook', 'favorite', 'email']);
const KEEP_STATUS = new Set(['escalated', 'human', 'opted_out', 'wrong_number', 'booked']);
const ORDER = ['seller', 'deal_with_pierce', 'meeting_booked', 'pierce_texting', 'pierce_in_touch'];

const cache = new Map(); // lead id -> { key, at, signals }
// per source: Pierce is told once per HubSpot outage and once per RingCentral outage; a source's flag clears only after
// a successful call to that same source (an email-only lead never queries RingCentral, so it can't end its outage)
const outage = { hubspot: false, rc: false };
/** Tests: forget cached lookups and the outage alerts. */
export function _resetContactGuard() { cache.clear(); outage.hubspot = false; outage.rc = false; }
export function forgetContactGuard(leadId) { cache.delete(leadId); }

const iso = (ms = +now()) => new Date(ms).toISOString();
const parseT = (v) => {
  if (v == null || v === '') return null;
  const ms = /^\d+$/.test(String(v)) ? Number(v) : +new Date(v);
  return Number.isFinite(ms) ? ms : null;
};
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric' });
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Every signal for this lead, ignoring any B# override. Never throws: lookup failures come back in `errors`. */
async function evaluate(lead) {
  const t = +now();
  const signals = [];
  const errors = [];
  const failed = []; // sources whose lookup errored
  const okSources = []; // sources queried successfully
  const sent = (await db.listMessages(lead.id, 500)).filter((m) => m.direction === 'out' && m.status === 'sent');
  const botTimes = sent.map((m) => parseT(m.meta?.sent_at) ?? parseT(m.created_at)).filter((x) => x != null);
  const botTaskDue = (lead.raw?.bot_task_due || []).map(parseT).filter((x) => x != null);
  const near = (list, ms, min) => list.some((x) => Math.abs(x - ms) <= min * 60e3);
  // 'texted' = no HubSpot task was made (Pierce was texted instead)
  let tasksUnreadable = false;
  const taskIds = Object.values(lead.hubspot_tasks || {}).filter((id) => id && id !== 'texted');

  try {
    // call tasks made before raw.bot_task_due existed (or more tasks than recorded due times): read their due times from
    // HubSpot, so the bot's own reminders are never mistaken for a meeting Pierce booked
    if (taskIds.length > botTaskDue.length) {
      try {
        for (const d of (await hubspot.taskDueTimes(taskIds)) || []) { const ms = parseT(d); if (ms != null) botTaskDue.push(ms); }
      } catch (e) {
        // the service key can't read tasks (scope): the next-activity date can't be told apart from the bot's own task,
        // so it is not used for this lead (meetings booked/held still are). Any other error is an outage (fail closed).
        if (e.status !== 401 && e.status !== 403) throw e;
        tasksUnreadable = true;
      }
    }
    const contacts = (await hubspot.findContactsFor({ phone: lead.phone, email: lead.email })) || [];
    for (const c of contacts.slice(0, 10)) {
      const p = c.properties || {};
      const who = { contact_id: c.id, matched: c.matched };
      const deals = (await hubspot.dealsForContact(c.id)) || [];
      const sellerDeals = deals.filter((d) => d.pipeline === config.hubspot.sellersPipeline);
      if (sellerDeals.length) signals.push({ reason: 'seller', overridable: false, evidence: { ...who, deals: sellerDeals } });
      const pierceDeals = deals.filter((d) => d.pipeline === config.hubspot.buyersPipeline && hubspot.isHumanStage(d.stage));
      if (pierceDeals.length) signals.push({ reason: 'deal_with_pierce', overridable: false, evidence: { ...who, deals: pierceDeals } });

      const next = parseT(p.notes_next_activity_date);
      if (next != null && !tasksUnreadable && next >= t - GUARD.nextActivityGraceDays * DAY && !near(botTaskDue, next, GUARD.botTaskMatchMin)) {
        signals.push({ reason: 'meeting_booked', overridable: true, nextActivity: String(p.notes_next_activity_date), at: null, when: next, evidence: { ...who, next_activity_date: iso(next) } });
      }
      for (const prop of ['engagements_last_meeting_booked', 'hs_latest_meeting_activity']) {
        const m = parseT(p[prop]);
        // nextActivity = identity of this meeting: B# records it, so a meeting he already knew about (even one still in
        // the future, whose `at` would otherwise always read "now") stays handed back; a different meeting counts again
        if (m != null && m >= t - GUARD.meetingDays * DAY) signals.push({ reason: 'meeting_booked', overridable: true, nextActivity: `${prop}:${p[prop]}`, at: iso(Math.min(m, t)), when: m, evidence: { ...who, [prop]: iso(m) } });
      }
      const lc = parseT(p.notes_last_contacted);
      if (lc != null && lc >= t - GUARD.lastContactedDays * DAY && !near(botTimes, lc, GUARD.botSendMatchMin)) {
        signals.push({ reason: 'pierce_in_touch', overridable: true, at: iso(lc), when: lc, evidence: { ...who, notes_last_contacted: iso(lc) } });
      }
    }
    for (const d of await hubspot.leadDealStages(lead)) {
      if (hubspot.isHumanStage(d.stage)) signals.push({ reason: 'deal_with_pierce', overridable: false, evidence: { deals: [d] } });
    }
    okSources.push('hubspot');
  } catch (e) { errors.push(`HubSpot: ${e.message}`); failed.push('hubspot'); }

  if (lead.phone) {
    try {
      const rcIds = new Set(sent.map((m) => String(m.rc_message_id || '')).filter(Boolean));
      // only bot texts with no stored RingCentral id (older rows) are matched by time/body; a bot text WITH an id is
      // recognized by its id alone, so Pierce texting right after the bot is never mistaken for the bot
      const botSms = sent.filter((m) => (m.channel || 'sms') === 'sms' && !m.rc_message_id);
      const isBot = (r) => {
        if (rcIds.has(String(r.id))) return true;
        const at = parseT(r.creationTime);
        return botSms.some((m) => {
          const mt = parseT(m.meta?.sent_at) ?? parseT(m.created_at);
          if (mt == null || at == null) return false;
          if (Math.abs(mt - at) <= GUARD.rcTimeMatchSec * 1000) return true;
          return Math.abs(mt - at) <= GUARD.rcBodyMatchMin * 60e3 && r.subject && norm(r.subject) === norm(m.body);
        });
      };
      const pierce = (await listOutboundSms(lead.phone, iso(t - GUARD.rcDays * DAY))).filter((r) => !isBot(r));
      if (pierce.length) {
        const latest = pierce.map((r) => parseT(r.creationTime)).filter((x) => x != null).sort((a, b) => b - a)[0] ?? t;
        signals.push({ reason: 'pierce_texting', overridable: true, at: iso(latest), when: latest, evidence: { rc_message_ids: pierce.slice(0, 5).map((r) => String(r.id)), last_text_at: iso(latest), count: pierce.length } });
      }
      okSources.push('rc');
    } catch (e) { errors.push(`RingCentral: ${e.message}`); failed.push('rc'); }
  }
  return { signals, errors, failed, okSources };
}

/** Signals still in force after Pierce's B#: only what happened after it, and never a seller or a deal past Offer Out. */
function inForce(signals, raw) {
  const ov = raw?.guard_override_at;
  if (!ov) return signals;
  const seen = raw.guard_override_seen_next || [];
  return signals.filter((s) => {
    if (!s.overridable) return true;
    if (s.nextActivity && seen.includes(s.nextActivity)) return false; // the meeting he already knew about when he said B#
    if (!s.at) return true; // a next activity he hadn't seen
    return s.at > ov;
  });
}
const top = (signals) => [...signals].sort((a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason))[0];

/** Plain words for Pierce. */
export function describe(s) {
  if (!s) return '';
  const e = s.evidence || {};
  switch (s.reason) {
    case 'seller': return `seller in HubSpot (Sellers deal "${e.deals?.[0]?.name || e.deals?.[0]?.id}")`;
    case 'deal_with_pierce': return `their buyer deal "${e.deals?.[0]?.name || e.deals?.[0]?.id}" is at Offer Out or later in HubSpot`;
    case 'meeting_booked': return e.next_activity_date ? `HubSpot shows something scheduled with them (${day(+new Date(e.next_activity_date))})` : 'HubSpot shows a meeting booked with them';
    case 'pierce_in_touch': return `you were in touch ${day(+new Date(e.notes_last_contacted))} (HubSpot last contacted)`;
    case 'pierce_texting': return `you texted them from RingCentral ${day(+new Date(e.last_text_at))}`;
    default: return s.reason;
  }
}

async function cachedSignals(lead) {
  const key = `${lead.phone || ''}|${lead.email || ''}`;
  const hit = cache.get(lead.id);
  const t = +now();
  if (hit && hit.key === key && t >= hit.at && t - hit.at < GUARD.cacheMs) return { signals: hit.signals, errors: [], failed: [] };
  const r = await evaluate(lead);
  for (const s of r.okSources) outage[s] = false;
  if (!r.errors.length) cache.set(lead.id, { key, at: t, signals: r.signals });
  return r;
}

/**
 * The check deliver() (and the cheap pre-checks before drafting) run for a bot-written message.
 * Returns { ok: true } | { ok: false, held: 'contact_guard', reason } | { ok: false, deferred: 'contact_check_failed' }.
 * kind: 'first_touch' | 'reply' | 'followup' (anything else is treated like a follow-up).
 */
export async function checkBeforeSend(leadIn, kind = 'followup') {
  if (!leadIn?.id || leadIn.raw?.test) return { ok: true }; // Pierce's own TEST session
  const lead = (await db.getLead(leadIn.id)) || leadIn; // B# override and status live on the stored lead
  if (lead.raw?.test) return { ok: true };
  const { signals, errors, failed } = await cachedSignals(lead);
  const live = inForce(signals, lead.raw);
  if (!live.length && errors.length) return unavailable(lead, kind, errors, failed);
  if (!live.length) return { ok: true };
  const first = top(live);
  await stepBack(lead, first, live, kind);
  return { ok: false, held: 'contact_guard', reason: first.reason };
}

async function unavailable(lead, kind, errors, failed = []) {
  const allowed = kind === 'reply' && PLATFORM_SOURCES.has(lead.source) && !!(lead.first_email_at || lead.last_outbound_at);
  await audit('contact_guard_unavailable', { leadId: lead.id, detail: { kind, errors, allowed } });
  const news = failed.filter((s) => !outage[s]);
  if (news.length) {
    for (const s of failed) outage[s] = true;
    await notifyOwner(`Can't check HubSpot/RingCentral before the bot writes to leads (${errors.join('; ').slice(0, 200)}). First messages and follow-ups wait until it's back; replies to platform buyers the bot is already talking with still go.`);
  }
  return allowed ? { ok: true, degraded: true } : { ok: false, deferred: 'contact_check_failed' };
}

async function stepBack(lead, first, live, kind) {
  const handsOff = live.some((s) => s.reason === 'seller' || s.reason === 'deal_with_pierce'); // no HubSpot writes at all
  const prev = lead.raw?.contact_guard;
  const ov = lead.raw?.guard_override_at;
  const told = !!prev?.notified_at && (!ov || prev.notified_at > ov); // B# starts a new round: a later step-back is news
  const status = KEEP_STATUS.has(lead.status) ? lead.status : first.reason === 'meeting_booked' ? 'booked' : 'human';
  const evidence = live.map((s) => ({ reason: s.reason, ...s.evidence }));
  const { booked_bot_ok: _ok, ...raw } = lead.raw || {}; // a booked lead goes quiet again
  // Pierce's own HubSpot contact for this person (phone stored in his format): notes and the buyer deal go there instead
  // of a duplicate contact the bot would create from the E.164 number
  const adopt = !handsOff && !lead.hubspot_contact_id ? live.find((s) => s.evidence?.contact_id)?.evidence.contact_id : null;
  await db.cancelScheduledForLead(lead.id);
  await db.updateLead(lead.id, {
    status, reply_due_at: null, reply_pending_since: null, ...(adopt ? { hubspot_contact_id: adopt } : {}),
    raw: { ...raw, contact_guard: { reason: first.reason, at: iso(), kind, evidence, notified_at: told ? prev.notified_at : iso() } },
  });
  await audit('contact_guard', { leadId: lead.id, detail: { reason: first.reason, kind, status, evidence } });
  // only an existing buyer deal follows the status; stepping back never opens a deal (or qualifies one) on its own
  if (!handsOff && status !== lead.status) await hubspot.syncDealStage(lead.id, { create: false });
  if (told) return;
  const why = describe(first);
  if (!handsOff) await hubspot.addNote(lead.id, `Setter bot stepped back: ${why}. Pierce owns this thread.`);
  const label = leadLabel(lead);
  const phone = lead.phone && !label.includes(lead.phone) ? ` ${lead.phone}` : '';
  const after = first.reason === 'seller' ? 'The bot never texts sellers; it stays yours.'
    : first.reason === 'deal_with_pierce' ? 'It stays yours.'
      : `B${lead.id} to hand it back.`;
  await notifyOwner(`Bot stepped back from ${label}${phone}: ${why}. ${after}`);
}

/**
 * Pierce's B#: the bot may go back to this lead. Time-based signals already there (his texts, last contacted, the
 * meeting he knows about) are ignored from now on; newer ones still count. A seller or a deal at Offer Out+ is refused.
 * Returns { ok: true, errors } or { refused: reason, why }.
 */
export async function handBack(leadIn) {
  cache.delete(leadIn.id);
  const lead = (await db.getLead(leadIn.id)) || leadIn;
  const { signals, errors, failed } = await evaluate(lead);
  const prevHard = ['seller', 'deal_with_pierce'].includes(lead.raw?.contact_guard?.reason) && !lead.raw.contact_guard.cleared_at;
  if (prevHard && failed.includes('hubspot')) {
    // can't confirm the seller / Offer Out deal is gone: stays Pierce's until HubSpot answers
    return { refused: lead.raw.contact_guard.reason, why: `${describe({ reason: lead.raw.contact_guard.reason, evidence: lead.raw.contact_guard.evidence?.find((e) => e.reason === lead.raw.contact_guard.reason) || {} })} (HubSpot didn't answer just now, so that couldn't be re-checked)` };
  }
  const hard = signals.filter((s) => !s.overridable);
  if (hard.length) {
    const first = top(hard);
    await audit('contact_guard_override_refused', { leadId: lead.id, actor: 'pierce', detail: { reason: first.reason, evidence: first.evidence } });
    return { refused: first.reason, why: describe(first) };
  }
  const prev = lead.raw?.contact_guard;
  const raw = {
    ...(lead.raw || {}), guard_override_at: iso(),
    // HubSpot no longer shows a seller / deal past Offer Out (Pierce fixed it): the bot may write to HubSpot again
    ...(prevHard ? { contact_guard: { ...prev, cleared_at: iso() } } : {}),
    guard_override_seen_next: signals.filter((s) => s.nextActivity).map((s) => s.nextActivity),
    ...(lead.status === 'booked' ? { booked_bot_ok: true } : {}),
  };
  await db.updateLead(lead.id, { raw });
  await audit('contact_guard_override', { leadId: lead.id, actor: 'pierce', detail: { ignored: signals.map((s) => s.reason), errors } });
  return { ok: true, errors };
}
