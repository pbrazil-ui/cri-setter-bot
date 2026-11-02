// Pierce runs the bot by texting the RingCentral number from OWNER_PHONE.
import { config } from '../config.js';
import { db } from '../db/index.js';
import { now } from '../clock.js';
import { inWindow } from '../guardrails.js';
import { notifyOwner, leadLabel } from '../notify.js';
import { sendNow, scheduleSend, setStatus, answerOwnerQuestion, processFirstTouch } from './setter.js';
import { matchListing, publicListingName } from '../listings.js';
import * as hubspot from '../hubspot.js';
import { audit } from '../policy.js';

const HELP = `Setter bot commands:
Y12 send draft #12 · YA send all pending
N12 skip #12 · E12 <text> send your text instead
A7 <answer> answer question Q7 (saved for future buyers)
CA34 CA verified for L34: unlocks OM, rent roll, financials
T34 take over lead L34 (bot goes quiet) · B34 bot resumes L34
PAUSE / RESUME (kill switch) · STATUS
TEST <listing> your cell plays a buyer for 2h (commands then need #, e.g. #Y12) · #ENDTEST stops`;

async function approve(id, overrideText) {
  const a = await db.getApproval(id);
  if (!a || a.status !== 'pending') return notifyOwner(`#${id} isn't pending (already handled, or the lead replied since — check the newer draft).`);
  const lead = await db.getLead(a.lead_id);
  if (lead.phone && (await db.isOptedOut(lead.phone))) {
    await db.updateApproval(id, { status: 'rejected', resolved_at: now().toISOString() });
    return notifyOwner(`#${id} not sent: ${leadLabel(lead)} opted out.`);
  }
  const text = overrideText || a.draft;
  const kind = overrideText ? 'owner_edit' : 'approved';
  const { _attachments = [], _channel, ...onSend } = a.on_send || {};
  const attachments = (await Promise.all(_attachments.map((id) => db.getDocument(id)))).filter(Boolean);
  const email = _channel ? _channel === 'email' : (lead.preferred_channel === 'email' || !lead.phone);
  const r = (email || inWindow(config.replyWindow)) ? await sendNow(lead, text, kind, onSend, attachments, email ? 'email' : 'sms') : await scheduleSend(lead, text, kind, onSend);
  await db.updateApproval(id, { status: overrideText ? 'edited' : 'approved', resolved_at: now().toISOString() });
  await audit(overrideText ? 'edited' : 'approved', { leadId: lead.id, actor: 'pierce', detail: { approval: id, policy: a.policy, ...(overrideText ? { original: a.draft, final: overrideText } : {}) } });
  if (r.scheduled) return notifyOwner(`#${id} queued for ${new Date(r.scheduled).toLocaleString('en-US', { timeZone: config.timezone })} (quiet hours).`);
  if (r.draft) return notifyOwner(`#${id} is in your Outlook Drafts.`);
  return r.sent ? notifyOwner(`Sent #${id}.`) : null;
}

async function reject(id) {
  const a = await db.getApproval(id);
  if (!a || a.status !== 'pending') return notifyOwner(`#${id} isn't pending.`);
  await db.updateApproval(id, { status: 'rejected', resolved_at: now().toISOString() });
  await audit('rejected', { leadId: a.lead_id, actor: 'pierce', detail: { approval: id, policy: a.policy } });
  await settleDeclinedApproval(a);
  return notifyOwner(`Skipped #${id}.`);
}

/** A draft Pierce passed on (N#) or let expire: a lead waiting on its first message is moved on, never left stuck. */
export async function settleDeclinedApproval(a) {
  const lead = a?.lead_id ? await db.getLead(a.lead_id) : null;
  if (!lead) return null;
  const emailStep = a.kind === 'first_touch' && a.on_send?._channel === 'email' && lead.phone; // the text still follows
  if (lead.status === 'awaiting_approval' && !emailStep) return setStatus(lead, 'human'); // you passed on the first text; bot leaves them alone
  return lead;
}

/** TEST <listing>: Pierce's own cell becomes a test buyer on that listing for 2 hours (no HubSpot, any hour). */
export async function startOwnerTest(property, { hours = 2 } = {}) {
  const listing = await matchListing(property);
  if (!listing) return notifyOwner(`TEST: no listing matches "${property}". Try the name as it shows on Crexi.`);
  const fields = {
    first_name: config.owner.firstName, last_name: config.owner.name.split(' ').slice(1).join(' ') || null, email: null,
    source: 'listing_email', platform: 'crexi', status: 'new', listing_id: listing.id, listing_code: listing.listing_code ?? null,
    property_name: publicListingName(listing.name), inquiry: 'TEST inquiry (Pierce)', raw: { test: true },
    next_action_at: now().toISOString(), first_email_at: null, followup_count: 0, qualification: {}, ca_verified: false,
    reply_due_at: null, reply_pending_since: null, hubspot_tasks: {}, preferred_channel: 'sms',
  };
  const existing = await db.findLeadByPhone(config.owner.phone);
  const lead = existing ? await db.updateLead(existing.id, fields) : await db.insertLead({ phone: config.owner.phone, auto_send: true, ...fields });
  await db.setSetting('owner_test', { lead_id: lead.id, expires_at: new Date(+now() + hours * 3600e3).toISOString() });
  await audit('owner_test_started', { leadId: lead.id, actor: 'pierce', detail: { listing: listing.name } });
  await notifyOwner(`TEST on: your cell is buyer L${lead.id} on ${publicListingName(listing.name)} for ${hours}h. Reply like a buyer. Commands need # first (#STATUS, #ENDTEST).`);
  return processFirstTouch(lead);
}

export async function endOwnerTest() {
  const t = await db.getSetting('owner_test');
  if (t?.lead_id) { const lead = await db.getLead(t.lead_id); if (lead) await db.updateLead(lead.id, { status: 'human' }); }
  await db.setSetting('owner_test', null);
  return notifyOwner('TEST off. Your texts are commands again.');
}

export async function handleOwnerCommand(raw) {
  const t = String(raw || '').trim();
  let m;
  if (/^(help|\?|commands)$/i.test(t)) return notifyOwner(HELP);
  if (/^pause$/i.test(t)) { await db.setSetting('paused', true); await audit('paused', { actor: 'pierce' }); return notifyOwner('Bot PAUSED. Every message now waits for your Y. Text RESUME to undo.'); }
  if (/^resume$/i.test(t)) { await db.setSetting('paused', false); await audit('resumed', { actor: 'pierce' }); return notifyOwner('Bot RESUMED.'); }
  if (/^status$/i.test(t)) {
    const c = await db.countByStatus();
    const pending = await db.listPendingApprovals();
    const line = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || 'no leads yet';
    return notifyOwner(`${(await db.getSetting('paused')) ? 'PAUSED. ' : ''}Leads: ${line}. Pending approvals: ${pending.map((a) => `#${a.id}`).join(' ') || 'none'}`);
  }
  if ((m = t.match(/^test\s+(.+)$/i))) return startOwnerTest(m[1].trim());
  if (/^end\s?test$/i.test(t)) return endOwnerTest();
  if (/^ya$/i.test(t)) { for (const a of await db.listPendingApprovals()) await approve(a.id); return null; }
  if ((m = t.match(/^y\s*#?(\d+)$/i))) return approve(Number(m[1]));
  if ((m = t.match(/^n\s*#?(\d+)$/i))) return reject(Number(m[1]));
  if ((m = t.match(/^e\s*#?(\d+)\s+([\s\S]+)$/i))) return approve(Number(m[1]), m[2].trim());
  if ((m = t.match(/^a\s*q?(\d+)\s+([\s\S]+)$/i))) {
    const r = await answerOwnerQuestion(Number(m[1]), m[2].trim());
    if (r.error === 'polish_failed') return null; // already told him it didn't go out
    if (r.error) return notifyOwner(`Q${m[1]} isn't open.`);
    return notifyOwner(r.sent ? `Answered Q${m[1]} and saved it.` : r.approval ? `Saved Q${m[1]}; reply is waiting on your Y${r.approval.id}.` : `Saved Q${m[1]}; reply ${r.scheduled ? 'queued for send hours' : 'not sent: ' + JSON.stringify(r)}.`);
  }
  if ((m = t.match(/^(?:ca|dd)\s*l?(\d+)$/i))) {
    const lead = await db.getLead(Number(m[1]));
    if (!lead) return notifyOwner(`No lead L${m[1]}.`);
    await db.updateLead(lead.id, { ca_verified: true });
    if (!['human', 'escalated', 'booked', 'opted_out', 'wrong_number'].includes(lead.status)) await setStatus(lead, 'in_dd', { followup_count: 0 });
    await hubspot.addNote(lead.id, 'CA verified by Pierce. Confidential docs unlocked for the setter bot.');
    return notifyOwner(`CA verified for ${leadLabel(lead)}. Bot can now share the OM, rent roll and financials with them.`);
  }
  if ((m = t.match(/^t\s*l?(\d+)$/i))) {
    const lead = await db.getLead(Number(m[1]));
    if (!lead) return notifyOwner(`No lead L${m[1]}.`);
    await db.supersedeApprovalsForLead(lead.id); await db.cancelScheduledForLead(lead.id);
    await setStatus(lead, 'human');
    await hubspot.addNote(lead.id, 'Pierce took over this thread; bot muted.');
    return notifyOwner(`You own ${leadLabel(lead)} now. Text them at ${lead.phone}. B${lead.id} hands it back.`);
  }
  if ((m = t.match(/^b\s*l?(\d+)$/i))) {
    const lead = await db.getLead(Number(m[1]));
    if (!lead) return notifyOwner(`No lead L${m[1]}.`);
    await setStatus(lead, lead.status === 'booked' ? 'booked' : 'engaged');
    return notifyOwner(`Bot is back on ${leadLabel(lead)}.`);
  }
  return notifyOwner(`Didn't catch that. Text HELP for commands.`);
}
