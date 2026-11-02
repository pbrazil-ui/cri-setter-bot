// Pierce's Nov 2 2026 rules + elite-cre-sales skill: automatic follow-up (text/email alternating, then long-term email),
// call tasks in HubSpot (the bot can't call), never claiming a call, verified-buyer logging, next step on every deal,
// email replies answered in-thread, send-not-draft.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock',
  EMAIL_MODE: 'mock', EMAIL_SEND_MODE: 'send', INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: 'fake', HUBSPOT_OWNER_ID: '2145826500',
  REPLY_DELAY_MAX_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0',
});

// ---- fake HubSpot: records deals, notes, tasks, next steps ----
const hs = { deals: {}, notes: [], tasks: [], c: 0 };
globalThis.fetch = async (url, o = {}) => {
  const u = new URL(url); const b = o.body ? JSON.parse(o.body) : null; const m = o.method;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.pathname.endsWith('/search')) return ok({ results: [], total: 0 });
  if (u.pathname === '/crm/v3/objects/contacts' && m === 'POST') return ok({ id: `c${++hs.c}` });
  if (u.pathname === '/crm/v3/objects/deals' && m === 'POST') { const id = `d${Object.keys(hs.deals).length + 1}`; hs.deals[id] = { ...b.properties }; return ok({ id }); }
  const dm = u.pathname.match(/deals\/(\w+)$/);
  if (dm && m === 'GET') return ok({ id: dm[1], properties: hs.deals[dm[1]] });
  if (dm && m === 'PATCH') { Object.assign(hs.deals[dm[1]], b.properties); return ok({}); }
  if (u.pathname === '/crm/v3/objects/notes') { hs.notes.push(b.properties.hs_note_body); return ok({ id: 'n' }); }
  if (u.pathname === '/crm/v3/objects/tasks') { hs.tasks.push({ ...b.properties, associations: b.associations }); return ok({ id: `t${hs.tasks.length}` }); }
  if (u.pathname.match(/contacts\/\w+/)) return ok({ id: 'c1', properties: {} });
  throw new Error(`unmocked ${m} ${u.pathname}`);
};

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox } = await import('../src/ringcentral.js');
const { mockMailbox, mockInbox, mockSentItems } = await import('../src/email.js');
const { ownerLog } = await import('../src/notify.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { tick, replyTick, inboxTick } = await import('../src/jobs.js');
const { deliver, followupPlan } = await import('../src/agent/setter.js');
const { claimsContact } = await import('../src/guardrails.js');
const { classify } = await import('../src/policy.js');
const { buildSystemPrompt } = await import('../src/agent/prompt.js');
const { config } = await import('../src/config.js');
const { stripQuoted } = await import('../src/intake/mailbox.js');

const T0 = +new Date('2026-11-03T18:00:00Z'); // Tue 10:00 PST
const day = (d, h = 0) => new Date(T0 + d * 864e5 + h * 3600e3).toISOString();
let evt = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `f${++evt}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const BUYER = '+15305550101';
const toBuyer = () => mockOutbox.filter((m) => m.to === BUYER);
const crexi = (extra = '') => ({ From: 'notifications@crexi.com', Subject: 'New lead', TextBody: `Name: Jane Buyer\nEmail: jane@example.com\nPhone: (530) 555-0101\nProperty: Lighthouse Resort\nMessage: Is this still available?${extra}` });
const leadNow = () => db.findLeadByPhone(BUYER);

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; mockMailbox.length = 0; mockInbox.length = 0; mockSentItems.length = 0; ownerLog.length = 0;
  Object.assign(hs, { deals: {}, notes: [], tasks: [], c: 0 });
  setNow(day(0));
  await db.upsertListing({ hubspot_deal_id: 'h1', listing_code: 'LH-2026', name: 'Lighthouse Resort', city: 'Isleton, CA', ca_link: 'https://example.com/ca' });
});

test('quiet buyer: day 1 text + HubSpot call task for Pierce, day 3 email, day 7 text, then long-term email every 2 weeks', async () => {
  await ingestEmail(crexi());
  assert.equal(mockMailbox.length, 1, 'first email sent (send mode, not a draft)');
  assert.equal(toBuyer().length, 1, 'first text');
  const deal = Object.values(hs.deals)[0];
  assert.match(deal.hs_next_step, /Bot follow-up by text .*Nov 4 if no reply/);

  setNow(day(1, 0.1)); await tick();
  assert.equal(toBuyer().length, 2, 'day 1: text');
  const t = hs.tasks[0];
  assert.ok(t, 'call task created');
  assert.equal(t.hs_task_type, 'CALL');
  assert.equal(t.hubspot_owner_id, '2145826500');
  assert.match(t.hs_task_subject, /^Call Jane Buyer re Lighthouse Resort$/);
  assert.match(t.hs_task_body, /Why: no reply to the first email\/text yet/);
  assert.match(t.hs_task_body, /Phone: \+15305550101 · Email: jane@example\.com/);
  assert.match(t.hs_task_body, /Talking points: .*how fast could you move\?/);
  assert.equal(new Date(t.hs_timestamp).toISOString(), '2026-11-05T17:00:00.000Z', 'due next business morning, 9am PT');
  assert.deepEqual(t.associations.map((a) => a.types[0].associationTypeId).sort(), [204, 216]);

  setNow(day(3, 0.2)); await tick();
  assert.equal(mockMailbox.length, 2, 'day 3: email (channels alternate)');
  setNow(day(7, 0.3)); await tick();
  assert.equal(toBuyer().length, 3, 'day 7: text');
  assert.match(toBuyer().at(-1).text, /Still in the market/);
  setNow(day(9, 0.5)); await tick();
  assert.equal((await leadNow()).status, 'nurture', 'kept on the long-term list, not dropped');
  assert.match(hs.notes.at(-1), /long-term list/);

  setNow(day(7 + 14, 1)); await tick();
  assert.equal(mockMailbox.length, 3, 'nurture email 2 weeks after the last touch');
  assert.match(mockMailbox.at(-1).text, /are you still looking for MH or RV parks\?/);
  assert.equal(toBuyer().length, 3, 'long-term touches are email only (no texts)');
  assert.equal(hs.tasks.length, 1, 'one no-reply call task, not one per follow-up');
  assert.ok(!ownerLog.some((x) => /^CALL/.test(x)), 'no-reply task is not urgent: no text to Pierce');
});

test('follow-up plan: monthly after day 91; text-only leads stop after day 7', async () => {
  const base = { status: 'nurture', email: 'a@b.com', created_at: day(-100), last_outbound_at: day(0), followup_count: 3 };
  assert.equal(+followupPlan(base).dueAt, +new Date(day(30)));
  assert.equal(followupPlan({ ...base, created_at: day(-10) }).dueAt.toISOString(), day(14));
  assert.equal(followupPlan({ ...base, email: null, phone: '+1' }).done, 'no_channel');
});

test('the bot never claims a call it did not make', async () => {
  for (const t of ['Tried calling you earlier', 'Just left you a voicemail about Lighthouse', 'I called you this morning', 'Gave you a ring']) assert.ok(claimsContact(t), t);
  for (const t of ['Happy to hop on a call. What works?', 'Pierce will call you Tuesday', 'Want to set up a call?']) assert.ok(!claimsContact(t), t);
  await ingestEmail(crexi());
  const lead = await leadNow();
  const r = await deliver(lead, 'Hi Jane, tried calling you earlier. Still interested?', { kind: 'followup' });
  assert.ok(r.approval, 'held for Pierce');
  assert.match(r.approval.reason, /cannot call/);
});

test('buyer asks for a call: bot lines up a time, Pierce gets a same-day HubSpot task and a text', async () => {
  await ingestEmail(crexi());
  await sms(BUYER, 'can you give me a call this afternoon?');
  await replyTick();
  assert.match(toBuyer().at(-1).text, /Happy to hop on a call\. What's a good time for you today or tomorrow\?/);
  const t = hs.tasks.at(-1);
  assert.equal(t.hs_task_priority, 'HIGH');
  assert.match(t.hs_task_body, /They said: .*give me a call this afternoon/);
  assert.ok(Math.abs(+new Date(t.hs_timestamp) - +new Date(day(0))) < 60e3, 'due now');
  assert.ok(ownerLog.some((x) => /^CALL .*Jane Buyer.*\+15305550101: asked for a call\. Task is in HubSpot\./.test(x)));
});

test('tour request: never scheduled by the bot; held for Pierce with a call task', async () => {
  await ingestEmail(crexi());
  const before = toBuyer().length;
  await sms(BUYER, 'Can we set up a tour next week?');
  await replyTick();
  assert.equal(toBuyer().length, before, 'no automatic reply about tours');
  assert.ok((await db.listPendingApprovals()).length >= 1);
  assert.match(hs.tasks.at(-1).hs_task_body, /Why: asked about a tour/);
});

test('verified buyer is logged in HubSpot: property, buy box, capital, timeline, next step', async () => {
  await ingestEmail(crexi());
  await sms(BUYER, 'cash buyer, 1031 money');
  await replyTick();
  const note = hs.notes.find((n) => /Verified buyer/.test(n));
  assert.ok(note, hs.notes.join('\n---\n'));
  for (const line of ['Verified buyer: Jane Buyer', 'Property: Lighthouse Resort', 'Buy box:', 'Capital: cash buyer, 1031 money', 'Timeline:', 'Next step:']) assert.ok(note.includes(line), line);
});

test('buyer replies by email: bot answers in the same thread, by email', async () => {
  await ingestEmail(crexi());
  setNow(day(0, 2));
  mockInbox.push({ id: 'r1', conversationId: 'conv1', receivedDateTime: day(0, 2), from: { emailAddress: { address: 'Jane@Example.com' } }, subject: 'RE: Lighthouse Resort',
    body: { contentType: 'text', content: 'We are cash buyers, 1031 money.\n\nOn Tue, Nov 3, 2026 Pierce Brazil wrote:\n> Thanks for reaching out' } });
  const r = await inboxTick();
  assert.equal(r.replies, 1);
  const msgs = await db.listMessages((await leadNow()).id);
  assert.equal(msgs.filter((m) => m.direction === 'in').at(-1).body, 'We are cash buyers, 1031 money.', 'quoted thread stripped');
  const textsBefore = toBuyer().length;
  await replyTick();
  const m = mockMailbox.at(-1);
  assert.equal(m.to, 'jane@example.com');
  assert.equal(m.inReplyToId, 'r1', 'threaded reply');
  assert.match(m.text, /15-min call/);
  assert.equal(toBuyer().length, textsBefore, 'answered by email, not by text');
});

test('email thread Pierce already answered by hand: the bot stays out', async () => {
  await ingestEmail(crexi());
  setNow(day(0, 2));
  mockInbox.push({ id: 'r2', conversationId: 'conv2', receivedDateTime: day(0, 2), from: { emailAddress: { address: 'jane@example.com' } }, subject: 'RE: Lighthouse', body: { contentType: 'text', content: 'What is the water source?' } });
  mockSentItems.push({ conversationId: 'conv2', sentDateTime: day(0, 2.01) }); // Pierce replied by hand before the bot's turn
  const before = mockMailbox.length;
  await inboxTick(); await replyTick();
  assert.equal(mockMailbox.length, before, 'bot sent nothing');
  assert.ok((await db.listAuditSince('2026-01-01')).some((e) => e.event === 'skipped_pierce_replied'));
});

test('"unsubscribe" by email opts the buyer out everywhere', async () => {
  await ingestEmail(crexi());
  mockInbox.push({ id: 'r3', conversationId: 'c3', receivedDateTime: day(0, 1), from: { emailAddress: { address: 'jane@example.com' } }, subject: 'RE: x', body: { contentType: 'text', content: 'Please unsubscribe me.' } });
  setNow(day(0, 1)); await inboxTick();
  assert.equal((await leadNow()).status, 'opted_out');
  assert.ok(await db.isOptedOut(BUYER));
  setNow(day(1, 1)); await tick();
  assert.equal(toBuyer().length, 1, 'no follow-ups after opting out');
});

test('auto-replies and quoted threads are not treated as buyer messages', async () => {
  assert.equal(stripQuoted('Sounds good\n\nSent from my iPhone\n\nOn Mon wrote:'), 'Sounds good');
  assert.equal(stripQuoted('> old\nnew'), '');
  await ingestEmail(crexi());
  mockInbox.push({ id: 'oo', receivedDateTime: day(0, 1), from: { emailAddress: { address: 'jane@example.com' } }, subject: 'Automatic reply: Lighthouse Resort', body: { contentType: 'text', content: 'I am out of the office.' } });
  setNow(day(0, 1));
  assert.equal((await inboxTick()).replies, 0);
});

test('sensitive documents need Pierce\'s Y on email too; plain email replies send', () => {
  const emailLead = { email: 'x@y.com', preferred_channel: 'email', status: 'engaged' };
  assert.equal(classify({ kind: 'reply', lead: emailLead, flags: { usedSensitive: true } }), 'reply.sensitive_docs');
  assert.equal(classify({ kind: 'reply', lead: emailLead }), 'reply.email');
});

test('Pierce\'s skills are in every prompt, with the no-calls rule on top', () => {
  const p = buildSystemPrompt({ lead: { status: 'engaged', source: 'listing_email' }, listing: null, mode: 'reply' });
  assert.match(p, /Writing Style Profile/);
  assert.match(p, /Elite CRE Sales Skill/);
  assert.match(p, /You CANNOT make phone calls/);
  assert.ok(p.indexOf('You CANNOT make phone calls') < p.indexOf('Elite CRE Sales Skill'), 'code rules come before the skills');
  assert.match(config.email.signatureHtml, /DRE #02247759/);
  assert.equal(config.email.sendMode, 'send');
});

test('Pierce, Nov 2: texts while they are talking; once quiet past day 7, email only; if they text back, the conversation resumes by text', async () => {
  assert.equal(config.nurture.sms, false, 'long-term touches are email only by default');
  const lead = await db.insertLead({ phone: BUYER, email: 'jane@example.com', first_name: 'Jane', source: 'listing_email', status: 'nurture', listing_id: 1,
    property_name: 'Lighthouse Resort', created_at: day(-20), last_outbound_at: day(-13), followup_count: 3 });
  setNow(day(1, 0.1)); await tick();
  assert.equal(toBuyer().length, 0, 'nurture touch did not text');
  assert.equal(mockMailbox.length, 1, 'nurture touch went by email');

  setNow(day(2)); await sms(BUYER, 'actually yes, still looking. what is occupancy?');
  await replyTick();
  assert.equal(toBuyer().length, 1, 'they texted, so the bot answers by text');
  const back = await db.getLead(lead.id);
  assert.equal(back.status, 'engaged');
  assert.equal(back.followup_count, 0, 'cadence restarts');

  setNow(day(3, 0.1)); await tick();
  assert.equal(toBuyer().length, 2, 'quiet again: day-1 follow-up is a text, part of the active conversation');
});
