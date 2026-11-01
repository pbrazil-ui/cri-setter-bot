// Morning Broker Brief: what the bot did, who replied, what moved, what's stalled, what needs Pierce.
// Short version by text; full version as an Outlook draft (or email) when email is configured.
import { config } from './config.js';
import { db } from './db/index.js';
import { now } from './clock.js';
import { notifyOwner, leadLabel } from './notify.js';
import { sendEmail } from './email.js';
import { policies, audit } from './policy.js';

const fmtLead = (l) => `${leadLabel(l)}${l.summary ? ` — ${l.summary}` : ''}`;

export async function buildBrief({ sinceHours = 24 } = {}) {
  const since = new Date(+now() - sinceHours * 3600e3).toISOString();
  const [events, leads, pending, openQs] = await Promise.all([
    db.listAuditSince(since), db.listLeadsUpdatedSince(since), db.listPendingApprovals(), db.listOpenOwnerQuestionsAll(),
  ]);
  const byLead = new Map(leads.map((l) => [l.id, l]));
  const lead = async (id) => byLead.get(id) || (await db.getLead(id));
  const count = (ev) => events.filter((e) => e.event === ev).length;
  const repliedIds = [...new Set(events.filter((e) => e.event === 'received').map((e) => e.lead_id))];
  const replied = (await Promise.all(repliedIds.map(lead))).filter(Boolean);
  const moved = events.filter((e) => e.event === 'status' && ['qualified', 'booked', 'in_dd'].includes(e.detail?.to));
  const booked = (await Promise.all(moved.filter((e) => e.detail.to === 'booked').map((e) => lead(e.lead_id)))).filter(Boolean);
  const qualified = (await Promise.all(moved.filter((e) => e.detail.to === 'qualified').map((e) => lead(e.lead_id)))).filter(Boolean);
  const lost = events.filter((e) => e.event === 'status' && ['no_response', 'disqualified'].includes(e.detail?.to)).length;
  const optOuts = count('opted_out');
  const stalledSince = new Date(+now() - 5 * 864e5).toISOString();
  const all = await db.listLeadsAwaitingReply();
  const stalled = all.filter((l) => l.status === 'in_dd' && l.last_outbound_at < stalledSince);

  return {
    period: `${sinceHours}h`,
    done: { sent: count('sent'), drafted: count('drafted'), received: count('received'), askedPierce: count('asked_pierce'), answered: count('answered') },
    replied, booked, qualified, lost, optOuts, stalled, pending, openQs,
    pausedOrStopped: policies().emergency_stop ? 'EMERGENCY STOP' : (await db.getSetting('paused')) ? 'PAUSED' : null,
  };
}

export function renderSms(b) {
  const lines = [`Broker Brief ${new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(now())}`];
  if (b.pausedOrStopped) lines.push(`⚠ Bot is ${b.pausedOrStopped}`);
  lines.push(`Did: ${b.done.sent} sent, ${b.done.received} replies in, ${b.done.askedPierce} asked you, ${b.done.answered} answered.`);
  if (b.booked.length) lines.push(`Booked: ${b.booked.map((l) => leadLabel(l)).join('; ')}`);
  if (b.qualified.length) lines.push(`Qualified: ${b.qualified.map((l) => leadLabel(l)).join('; ')}`);
  if (b.replied.length) lines.push(`Replied: ${b.replied.slice(0, 6).map((l) => leadLabel(l)).join('; ')}${b.replied.length > 6 ? ` +${b.replied.length - 6}` : ''}`);
  if (b.stalled.length) lines.push(`Stalled in DD: ${b.stalled.slice(0, 4).map((l) => leadLabel(l)).join('; ')}`);
  if (b.lost || b.optOuts) lines.push(`Closed out: ${b.lost}. Opt-outs: ${b.optOuts}.`);
  const needs = [];
  if (b.pending.length) needs.push(`${b.pending.length} drafts (${b.pending.map((a) => `Y${a.id}`).join(' ')})`);
  if (b.openQs.length) needs.push(`${b.openQs.length} questions (${b.openQs.map((q) => `A${q.id}`).join(' ')})`);
  lines.push(needs.length ? `Needs you: ${needs.join(', ')}.` : 'Needs you: nothing.');
  return lines.join('\n');
}

export function renderEmail(b) {
  const sec = (title, items) => (items.length ? `${title}\n${items.map((x) => `- ${x}`).join('\n')}\n` : '');
  return [
    b.pausedOrStopped ? `⚠ The bot is ${b.pausedOrStopped}.\n` : '',
    `Completed (last ${b.period}): ${b.done.sent} messages sent, ${b.done.drafted} email drafts prepared, ${b.done.received} replies received, ${b.done.askedPierce} questions escalated to you, ${b.done.answered} answered.\n`,
    sec('Moving', [...b.booked.map((l) => `BOOKED: ${fmtLead(l)}`), ...b.qualified.map((l) => `Qualified: ${fmtLead(l)}`)]),
    sec('Responded', b.replied.map(fmtLead)),
    sec('Stalled (in DD, quiet 5+ days)', b.stalled.map(fmtLead)),
    b.lost || b.optOuts ? `Closed out: ${b.lost} no-response/not-a-fit. Opt-outs: ${b.optOuts}.\n` : '',
    sec('Decisions that need you', [
      ...b.pending.map((a) => `Y${a.id} / N${a.id} / E${a.id}: ${a.kind} draft${a.reason ? ` (${a.reason})` : ''}: "${a.draft.slice(0, 140)}"`),
      ...b.openQs.map((q) => `A${q.id}: "${q.question}"`),
    ]),
    'Reply to any item by text from your cell.',
  ].filter(Boolean).join('\n');
}

export async function sendMorningBrief() {
  const b = await buildBrief();
  await notifyOwner(renderSms(b));
  if (config.email.mode !== 'off' && config.owner.email) {
    try { await sendEmail({ to: config.owner.email, cc: [], subject: `Morning Broker Brief — ${new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric' }).format(now())}`, text: renderEmail(b) }); } catch (e) { console.error('[brief email]', e.message); }
  }
  await audit('morning_brief', { actor: 'system', detail: { sent: b.done.sent, pending: b.pending.length, openQs: b.openQs.length } });
  return b;
}
