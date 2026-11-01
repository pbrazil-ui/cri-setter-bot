// Policy engine (Levels 1/2/3), emergency stop, test mode, approval expiry, audit trail, Morning Brief.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'off', EMAIL_MODE: 'mock',
  INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: '', REPLY_DELAY_MAX_SEC: '0',
});

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox } = await import('../src/ringcentral.js');
const { mockMailbox } = await import('../src/email.js');
const { ownerLog } = await import('../src/notify.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { _setPoliciesForTest, classify } = await import('../src/policy.js');
const { expireTick, briefTick } = await import('../src/jobs.js');
const { buildBrief, renderSms } = await import('../src/brief.js');
const { config } = await import('../src/config.js');

const PIERCE = config.owner.phone;
let evtId = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `e${++evtId}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const toLead = (phone) => mockOutbox.filter((m) => m.to === phone);
const crexiEmail = (phone, name = 'Jane Buyer') => ({ From: 'notifications@crexi.com', Subject: 'New lead', TextBody: `Name: ${name}\nEmail: ${name.replace(/\s+/g, '.').toLowerCase()}@example.com\nPhone: ${phone}\nProperty: Hidden Harbor Marina & RV Park\nMessage: info please` });
const { readFileSync } = await import('node:fs');
const basePolicies = () => ({ ...JSON.parse(readFileSync(new URL('../playbook/policies.json', import.meta.url), 'utf8')), test_mode: false });

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; mockMailbox.length = 0; ownerLog.length = 0; setNow('2026-11-03T18:00:00Z');
  _setPoliciesForTest(basePolicies());
  await db.upsertListing({ hubspot_deal_id: 's1', listing_code: 'HARBOR-2026', name: 'Hidden Harbor Marina & RV Park', ca_link: 'https://example.com/ca' });
});

test('classify maps deliveries to policy keys', () => {
  const smsLead = { phone: '+1', source: 'listing_email', status: 'engaged' };
  assert.equal(classify({ kind: 'first_touch', lead: smsLead }), 'first_touch.listing_email');
  assert.equal(classify({ kind: 'first_touch', lead: { email: 'x@y.com', source: 'listing_email' } }), 'first_touch.email');
  assert.equal(classify({ kind: 'followup', lead: { ...smsLead, status: 'in_dd' } }), 'followup.in_dd');
  assert.equal(classify({ kind: 'reply', lead: smsLead, human: true }), 'escalate.price_terms_legal');
  assert.equal(classify({ kind: 'reply', lead: smsLead, flags: { usedSensitive: true } }), 'reply.sensitive_docs');
  assert.equal(classify({ kind: 'reply', lead: smsLead, flags: { usedCaDocs: true } }), 'reply.ca_docs');
  assert.equal(classify({ kind: 'reply', lead: smsLead, decision: { action: 'ask_pierce' } }), 'reply.holding');
  assert.equal(classify({ kind: 'reply', lead: smsLead }), 'reply.public_facts');
  assert.equal(classify({ kind: 'approved', lead: smsLead }), null);
});

test('Level 2: fresh inquiry auto-sends; flipping the policy to approve holds it', async () => {
  await ingestEmail(crexiEmail('530-555-0101'));
  assert.equal(toLead('+15305550101').length, 1);
  const p = basePolicies(); p.policies['first_touch.listing_email'].mode = 'approve'; _setPoliciesForTest(p);
  await ingestEmail(crexiEmail('530-555-0102', 'Bob Buyer'));
  assert.equal(toLead('+15305550102').length, 0);
  const pending = await db.listPendingApprovals();
  assert.equal(pending.length, 1); assert.equal(pending[0].policy, 'first_touch.listing_email');
});

test('test_mode: nothing external goes out, everything becomes an approval you can watch', async () => {
  const p = basePolicies(); p.test_mode = true; _setPoliciesForTest(p);
  await ingestEmail(crexiEmail('530-555-0101'));
  assert.equal(toLead('+15305550101').length, 0);
  const a = (await db.listPendingApprovals())[0];
  assert.equal(a.reason, 'test mode');
  await sms(PIERCE, `Y${a.id}`); // Pierce can still push one through by hand
  assert.equal(toLead('+15305550101').length, 1);
});

test('emergency_stop blocks every external send, including approved ones, and is audited', async () => {
  await ingestEmail(crexiEmail('530-555-0101'));
  const p = basePolicies(); p.emergency_stop = true; _setPoliciesForTest(p);
  await sms('+15305550101', 'cash buyer, what day works?');
  assert.equal(toLead('+15305550101').length, 1); // only the first touch from before the stop
  const log = await db.listAuditSince('2026-01-01');
  assert.ok(log.some((e) => e.event === 'policy_block'));
  assert.equal((await db.listPendingApprovals()).length, 0); // blocked, not queued
});

test('hourly auto-send budget turns excess sends into approvals', async () => {
  const p = basePolicies(); p.limits.max_auto_sends_per_hour = 2; _setPoliciesForTest(p);
  const results = [];
  for (let i = 1; i <= 4; i++) results.push(await ingestEmail(crexiEmail(`530-555-01${String(i).padStart(2, '0')}`, `Buyer ${i}`)));
  assert.deepEqual(results.map((r) => (r.firstTouch.sent ? 'sent' : r.firstTouch.approval ? 'held' : '?')), ['sent', 'sent', 'held', 'held']);
  assert.equal((await db.listAuditSince('2026-01-01')).filter((e) => e.event === 'sent').length, 2);
  const pending = await db.listPendingApprovals();
  assert.equal(pending.length, 2); assert.equal(pending[0].reason, 'hourly auto-send budget reached');
});

test('approvals expire after the configured window so stale drafts never go out', async () => {
  const p = basePolicies(); p.policies['first_touch.listing_email'].mode = 'approve'; p.limits.approval_expires_hours = 48; _setPoliciesForTest(p);
  await ingestEmail(crexiEmail('530-555-0101'));
  const a = (await db.listPendingApprovals())[0];
  setNow('2026-11-06T18:00:01Z');
  assert.equal(await expireTick(), 1);
  assert.equal((await db.getApproval(a.id)).status, 'expired');
  await sms(PIERCE, `Y${a.id}`);
  assert.equal(toLead('+15305550101').length, 0);
  assert.match(ownerLog.at(-1), /isn't pending/);
});

test('audit trail records the whole lifecycle with actors', async () => {
  await ingestEmail(crexiEmail('530-555-0101'));
  await sms('+15305550101', 'Would the seller take a lower offer?');
  const a = (await db.listPendingApprovals())[0];
  await sms(PIERCE, `E${a.id} Let me have Pierce call you on that.`);
  const events = (await db.listAuditSince('2026-01-01')).map((e) => `${e.actor}:${e.event}`);
  for (const want of ['bot:sent', 'bot:received', 'bot:approval_created', 'pierce:edited', 'bot:status']) assert.ok(events.includes(want), `${want} missing from ${events}`);
  const edited = (await db.listAuditSince('2026-01-01')).find((e) => e.event === 'edited');
  assert.ok(edited.detail.original && edited.detail.final); // feeds the writing-style feedback loop
});

test('Morning Broker Brief: fires once a day after 7:30 local, summarizes done / moving / needs-you', async () => {
  await ingestEmail(crexiEmail('530-555-0101'));
  await sms('+15305550101', 'cash buyer');
  await sms('+15305550101', 'Tuesday 10am works');
  await ingestEmail(crexiEmail('530-555-0102', 'Bob Buyer'));
  await sms('+15305550102', 'Would the seller take a lower offer?');
  ownerLog.length = 0;
  setNow('2026-11-04T15:20:00Z'); // 7:20am PST: too early
  assert.equal(await briefTick(), null);
  setNow('2026-11-04T15:31:00Z'); // 7:31am
  const b = await briefTick();
  assert.ok(b);
  const text = ownerLog.find((t) => t.startsWith('Broker Brief'));
  assert.match(text, /Did: \d+ sent, 3 replies in/);
  assert.match(text, /Booked: L\d+ Jane Buyer/);
  assert.match(text, /Needs you: 1 drafts \(Y\d+\)/);
  assert.equal(mockMailbox.at(-1)?.to, config.owner.email);
  assert.match(mockMailbox.at(-1).subject, /Morning Broker Brief/);
  setNow('2026-11-04T18:00:00Z');
  assert.equal(await briefTick(), null); // not twice
  // renderSms stays short enough for a couple of SMS segments on a quiet day
  db._reset();
  assert.ok(renderSms(await buildBrief()).length < 320);
});
