// Nov 2 2026 bug fixes: first-touch double sends and stuck/parked leads, alert-number replies, scheduled sends under
// PAUSE / emergency stop, CSV first emails, per-listing CAs, HubSpot writes past Offer Out, deal reuse, follow-up gates,
// A# failures, expired approvals, ask_pierce dedupe, nurture while email is off.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
  NODE_ENV: 'test', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock',
  EMAIL_MODE: 'mock', EMAIL_SEND_MODE: 'send', INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: 'fake', HUBSPOT_OWNER_ID: '2145826500',
  REPLY_DELAY_MAX_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0',
});

// ---- fake HubSpot: deals with stages, configurable deal search results, every PATCH recorded ----
const hs = { deals: {}, notes: [], patches: [], dealSearch: [], c: 0 };
globalThis.fetch = async (url, o = {}) => {
  const u = new URL(url); const b = o.body ? JSON.parse(o.body) : null; const m = o.method;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.pathname === '/crm/v3/objects/deals/search') return ok({ results: hs.dealSearch, total: hs.dealSearch.length });
  if (u.pathname.endsWith('/search')) return ok({ results: [], total: 0 });
  if (u.pathname === '/crm/v3/objects/contacts' && m === 'POST') return ok({ id: `c${++hs.c}` });
  if (u.pathname === '/crm/v3/objects/deals' && m === 'POST') { const id = `d${Object.keys(hs.deals).length + 1}`; hs.deals[id] = { ...b.properties }; return ok({ id }); }
  const dm = u.pathname.match(/deals\/(\w+)$/);
  if (dm && m === 'GET') return ok({ id: dm[1], properties: hs.deals[dm[1]] || {} });
  if (dm && m === 'PATCH') { hs.patches.push({ id: dm[1], ...b.properties }); Object.assign(hs.deals[dm[1]] ||= {}, b.properties); return ok({}); }
  if (u.pathname === '/crm/v3/objects/notes') { hs.notes.push(b.properties.hs_note_body); return ok({ id: 'n' }); }
  if (u.pathname === '/crm/v3/objects/tasks') return ok({ id: 't1' });
  if (u.pathname.match(/contacts\/\w+/)) return ok({ id: 'c1', properties: {} });
  throw new Error(`unmocked ${m} ${u.pathname}`);
};

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox, mockSmsFailures } = await import('../src/ringcentral.js');
const { mockMailbox } = await import('../src/email.js');
const { ownerLog } = await import('../src/notify.js');
const { mockLlm } = await import('../src/llm.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { importCsv } = await import('../src/intake/csv.js');
const { tick, firstTouchTick, replyTick, expireTick } = await import('../src/jobs.js');
const { scheduleSend, applyDecision, sameTopic, smsUndeliverable, processFirstTouch } = await import('../src/agent/setter.js');
const { makeExecutors } = await import('../src/agent/tools.js');
const { _setPoliciesForTest, classify } = await import('../src/policy.js');
const hubspot = await import('../src/hubspot.js');
const { config } = await import('../src/config.js');

const T0 = +new Date('2026-11-03T18:00:00Z'); // Tue 10:00 PST
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const day = (d, h = 0) => new Date(T0 + d * 864e5 + h * 3600e3).toISOString();
const S = config.hubspot.stages;
const PIERCE = config.owner.phone;
const BUYER = '+15305550101';
let evt = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `x${++evt}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const toBuyer = (p = BUYER) => mockOutbox.filter((m) => m.to === p);
const crexi = ({ email = true, phone = true, property = 'Lighthouse Resort', msg = 'Is this still available?' } = {}) => ({
  From: 'notifications@crexi.com', Subject: 'New lead',
  TextBody: `Name: Jane Buyer\n${email ? 'Email: jane@example.com\n' : ''}${phone ? 'Phone: (530) 555-0101\n' : ''}Property: ${property}\nMessage: ${msg}`,
});
const leadNow = () => db.findLeadByPhone(BUYER);
const basePolicies = () => ({ ...JSON.parse(readFileSync(new URL('../playbook/policies.json', import.meta.url), 'utf8')), test_mode: false });
let LH; let HAC;

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; mockMailbox.length = 0; ownerLog.length = 0; mockSmsFailures.clear(); mockLlm.failPolish = false;
  Object.assign(hs, { deals: {}, notes: [], patches: [], dealSearch: [], c: 0 });
  Object.assign(config, { firstTouchDelay: { minSec: 0, maxSec: 0 }, textAfterEmail: { minSec: 0, maxSec: 0 }, pace: { minSec: 0, maxSec: 0 }, minGapSec: 0 });
  config.email.mode = 'mock'; config.email.sendMode = 'send';
  _setPoliciesForTest(basePolicies());
  setNow(at(0));
  LH = await db.upsertListing({ hubspot_deal_id: 'h1', name: 'Lighthouse Resort', ca_link: 'https://example.com/ca' }); // no listing_code
  HAC = await db.upsertListing({ hubspot_deal_id: 'h3', listing_code: 'HAC-2026', name: 'Boon Chan - Hacienda Mobile Park', ca_link: 'https://example.com/ca3' });
});

test('fix 1: tick() and firstTouchTick() at the same moment give a lead ONE first text and ONE HubSpot deal', async () => {
  config.firstTouchDelay = { minSec: 60, maxSec: 60 };
  await ingestEmail(crexi({ email: false }));
  assert.equal(toBuyer().length, 0);
  setNow(at(61));
  await Promise.all([tick(), firstTouchTick(), firstTouchTick()]);
  assert.equal(toBuyer().length, 1, 'one first text');
  assert.equal(Object.keys(hs.deals).length, 1, 'one buyer deal');
  assert.equal((await leadNow()).status, 'contacted');
});

test('fix 1 (review): intake, the job passes and a stale copy racing on a reopened lead give ONE first text and ONE new deal', async () => {
  await ingestEmail(crexi({ email: false })); // Lighthouse: first text + deal
  assert.equal(toBuyer().length, 1);
  const stale = await db.updateLead((await leadNow()).id, { status: 'no_response' });
  setNow(day(10));
  const deals = Object.keys(hs.deals).length;
  await Promise.all([ingestEmail(crexi({ email: false, property: 'Hacienda Mobile Park' })), firstTouchTick(), tick(), firstTouchTick()]);
  await processFirstTouch({ ...stale, status: 'new', next_action_at: null }); // a caller holding an old snapshot
  assert.equal(toBuyer().length, 2, 'one first text for the new listing');
  assert.match(toBuyer()[1].text, /Hacienda/);
  assert.equal(Object.keys(hs.deals).length, deals + 1, 'one buyer deal for the new listing');
});

test('fix 2: first text to a number that cannot take SMS -> wrong_number, Pierce told once, never retried', async () => {
  assert.ok(smsUndeliverable('Phone number is a landline and cannot receive SMS'));
  assert.ok(!smsUndeliverable('RingCentral 503 Service Unavailable'));
  mockSmsFailures.set(BUYER, 'Phone number is a landline and cannot receive SMS');
  await ingestEmail(crexi({ email: false }));
  assert.equal((await leadNow()).status, 'wrong_number');
  for (let i = 1; i <= 3; i++) { setNow(at(20 * i)); await firstTouchTick(); }
  setNow(day(1, 1)); await firstTouchTick();
  assert.equal(ownerLog.filter((t) => /can't receive texts/.test(t)).length, 1, 'one alert');
  assert.ok(!ownerLog.some((t) => /Send FAILED/.test(t)), 'no per-attempt "Send FAILED" spam');
  assert.equal(toBuyer().length, 0);
});

test('fix 2: other send failures park the lead 24h, retry up to 3 times, then close it; Pierce told once', async () => {
  mockSmsFailures.set(BUYER, 'RingCentral 503 Service Unavailable');
  await ingestEmail(crexi({ email: false }));
  let lead = await leadNow();
  assert.equal(lead.status, 'new');
  assert.equal(lead.next_action_at, day(1), 'parked 24h');
  assert.equal(lead.raw.first_touch_retry.count, 1);
  for (let i = 1; i <= 5; i++) { setNow(at(20 * i)); await firstTouchTick(); }
  assert.equal((await leadNow()).raw.first_touch_retry.count, 1, 'not retried every 20s');
  setNow(day(1, 0.1)); await firstTouchTick();
  assert.equal((await leadNow()).raw.first_touch_retry.count, 2);
  setNow(day(2, 0.2)); await firstTouchTick();
  lead = await leadNow();
  assert.equal(lead.status, 'no_response', 'given up after 3 tries');
  setNow(day(3, 0.3)); await firstTouchTick();
  assert.equal(ownerLog.filter((t) => /didn't go out/.test(t)).length, 1, 'Pierce told once per failure type');
  assert.ok(!ownerLog.some((t) => /Send FAILED/.test(t)));
});

test('fix 2: emergency stop parks the first text without using up a try', async () => {
  _setPoliciesForTest({ ...basePolicies(), emergency_stop: true });
  await ingestEmail(crexi({ email: false }));
  const lead = await leadNow();
  assert.equal(lead.status, 'new');
  assert.equal(lead.raw.first_touch_retry.count, 0);
  assert.equal(lead.next_action_at, day(1));
  _setPoliciesForTest(basePolicies());
  setNow(day(1, 0.1)); await firstTouchTick();
  assert.equal(toBuyer().length, 1);
  assert.equal((await leadNow()).status, 'contacted');
});

test('fix 3: a text from the Crexi alert number that is not an alert goes to Pierce, never to the bot or back to Crexi', async () => {
  const CREXI = '+14243223884';
  const r = await sms(CREXI, 'Your weekly CREXi digest is ready. Log in to view your listing activity.');
  assert.deepEqual(r, { skipped: 'unparsed_alert' });
  assert.equal(toBuyer(CREXI).length, 0, 'no reply to Crexi');
  assert.equal(await db.findLeadByPhone(CREXI), null, 'no lead for the platform number');
  assert.equal(ownerLog.filter((t) => /^Unparsed Crexi alert from \+14243223884/.test(t) && t.includes('weekly CREXi digest')).length, 1);
});

test('fix 4: email-only leads while email is off are parked, newer leads still go out, and they are emailed once email is on', async () => {
  config.email.mode = 'off';
  for (let i = 0; i < 11; i++) await db.insertLead({ source: 'listing_email', status: 'no_phone', email: `e${i}@x.com`, listing_id: LH.id, property_name: 'Lighthouse Resort', next_action_at: at(-60) });
  config.firstTouchDelay = { minSec: 30, maxSec: 30 };
  await ingestEmail(crexi({ email: false }));
  setNow(at(31)); await firstTouchTick(); await firstTouchTick();
  assert.equal(toBuyer().length, 1, 'newer text lead is not starved');
  const parked = (await db.listLeadsForFirstTouch(50));
  assert.equal(parked.length, 0, 'no email-only lead is due again right away');
  config.email.mode = 'mock';
  setNow(day(1, 0.1)); await firstTouchTick(); await firstTouchTick();
  assert.equal(mockMailbox.length, 11, 'all picked up once email is on');
});

test('fix 5: PAUSE and the emergency stop hold scheduled texts (left scheduled); they go once lifted', async () => {
  await ingestEmail(crexi({ email: false }));
  const lead = await leadNow();
  const before = toBuyer().length;
  await scheduleSend(lead, 'Queued one', 'reply', {}, { delaySec: 60 });
  setNow(at(61));
  await sms(PIERCE, 'PAUSE');
  await replyTick();
  assert.equal(toBuyer().length, before, 'held while paused');
  assert.equal((await db.listDueScheduled()).length, 1, 'still scheduled');
  await sms(PIERCE, 'RESUME');
  await replyTick();
  assert.equal(toBuyer().at(-1).text, 'Queued one');

  await scheduleSend(await leadNow(), 'Queued two', 'reply', {}, { delaySec: 60 });
  setNow(at(200));
  _setPoliciesForTest({ ...basePolicies(), emergency_stop: true });
  await replyTick();
  assert.equal(toBuyer().at(-1).text, 'Queued one', 'held under emergency stop');
  assert.equal((await db.listDueScheduled()).length, 1);
  _setPoliciesForTest(basePolicies());
  await replyTick();
  assert.equal(toBuyer().at(-1).text, 'Queued two');
});

test('fix 6: an uploaded CSV lead gets NO automatic first email; both channels wait for Pierce (first_touch.csv)', async () => {
  const lead = { source: 'csv', listing_id: LH.id, email: 'bob@x.com', phone: '+19495550102' };
  assert.equal(classify({ kind: 'first_touch', lead, channel: 'email' }), 'first_touch.csv');
  assert.equal(classify({ kind: 'first_touch', lead, channel: 'sms' }), 'first_touch.csv');
  assert.equal(classify({ kind: 'first_touch', lead: { ...lead, phone: null } }), 'first_touch.csv');
  await importCsv(Buffer.from('First Name,Last Name,Email,Phone Number,Property Name\nBob,Smith,bob@x.com,949-555-0102,Lighthouse Resort\n'));
  await tick();
  assert.equal(mockMailbox.length, 0, 'no email went out on its own');
  assert.equal(toBuyer('+19495550102').length, 0);
  const pending = await db.listPendingApprovals();
  assert.deepEqual(pending.map((a) => [a.policy, a.on_send._channel]).sort(), [['first_touch.csv', 'email'], ['first_touch.csv', 'sms']]);
});

test('fix 7: a CA-verified buyer of listing A who inquires on listing B is not CA-verified for B', async () => {
  await ingestEmail(crexi({ email: false }));
  let lead = await leadNow();
  await sms(PIERCE, `CA${lead.id}`);
  assert.equal((await leadNow()).ca_verified, true);
  await ingestEmail(crexi({ email: false, property: 'Hacienda Mobile Park' }));
  lead = await leadNow();
  assert.equal(lead.listing_id, HAC.id);
  assert.equal(lead.ca_verified, false, 'a CA covers one listing');
  const ex = makeExecutors({ lead, listing: HAC, flags: { usedSensitive: false, links: [], needsAttachment: [] } });
  assert.equal((await ex.rent_roll_stats()).locked, true, 'listing B rent roll stays locked');
  assert.ok((await db.listAuditSince(at(-10))).some((a) => a.event === 'ca_reset' && a.lead_id === lead.id));
  assert.ok(hs.notes.some((n) => /CA on file covered Lighthouse Resort, not Hacienda Mobile Park/.test(n)));
});

test('fix 8: Next step is never written to a deal at Offer Out, Under Contract, Closed Won or Closed Lost', async () => {
  await ingestEmail(crexi({ email: false }));
  const lead = await leadNow();
  const dealId = Object.keys(hs.deals)[0];
  for (const stage of [S.offerOut, S.underContract, S.won, S.lost]) {
    hs.deals[dealId].dealstage = stage; hs.patches.length = 0;
    assert.equal(await hubspot.setNextStep(lead.id, `step at ${stage}`), false);
    assert.equal(hs.patches.length, 0, `no PATCH at stage ${stage}`);
  }
  hs.deals[dealId].dealstage = S.qualified;
  await hubspot.setNextStep(lead.id, 'Bot replying now');
  assert.equal(hs.deals[dealId].hs_next_step, 'Bot replying now', 'earlier stages still get it');
});

test('fix 9: the text says "Just sent you an email" only when the email really went out', async () => {
  config.email.sendMode = 'draft'; // a draft has not reached the buyer
  await ingestEmail(crexi());
  let lead = await leadNow();
  assert.equal(mockMailbox.length, 1);
  assert.equal(lead.first_email_at ?? null, null, 'no first_email_at for a draft');
  assert.match(lead.raw.intro_email, /^drafted/);
  assert.ok(!/Just sent you an email/.test(toBuyer()[0].text), toBuyer()[0].text);

  db._reset(); mockOutbox.length = 0; mockMailbox.length = 0;
  LH = await db.upsertListing({ hubspot_deal_id: 'h1', name: 'Lighthouse Resort', ca_link: 'https://example.com/ca' });
  config.email.sendMode = 'send';
  const p = basePolicies(); p.policies['first_touch.email'].mode = 'approve'; _setPoliciesForTest(p); // email held for Pierce
  await ingestEmail(crexi());
  lead = await leadNow();
  assert.equal(mockMailbox.length, 0);
  assert.equal(lead.raw.intro_email, 'waiting on Pierce');
  assert.ok(!/Just sent you an email/.test(toBuyer()[0].text));

  db._reset(); mockOutbox.length = 0;
  LH = await db.upsertListing({ hubspot_deal_id: 'h1', name: 'Lighthouse Resort', ca_link: 'https://example.com/ca' });
  _setPoliciesForTest(basePolicies());
  await ingestEmail(crexi());
  lead = await leadNow();
  assert.ok(lead.first_email_at);
  assert.equal(lead.raw.intro_email, 'sent');
  assert.match(toBuyer()[0].text, /Just sent you an email/);
});

test('fix 9 (review): a lead reopened on another listing gets THAT listing\'s intro email before the text says so', async () => {
  await ingestEmail(crexi()); // Lighthouse: email + text
  assert.equal(mockMailbox.length, 1);
  await db.updateLead((await leadNow()).id, { status: 'no_response', raw: { ...(await leadNow()).raw, first_touch_retry: { count: 2, notified: ['failed'] } } });
  setNow(day(10));
  const r = await ingestEmail(crexi({ property: 'Hacienda Mobile Park' }));
  assert.ok(r.reopened);
  assert.equal(mockMailbox.length, 2, 'the Hacienda intro email went out');
  assert.match(mockMailbox[1].subject + mockMailbox[1].text, /Hacienda/);
  const lead = await leadNow();
  assert.equal(lead.raw.intro_email, 'sent');
  assert.equal(lead.raw.first_touch_retry, undefined, 'old retry state cleared');
  assert.match(toBuyer().at(-1).text, /Just sent you an email.*Hacienda/);

  // and when the new listing's email does NOT go out, the text doesn't claim it
  await db.updateLead(lead.id, { status: 'no_response' });
  const p = basePolicies(); p.policies['first_touch.email'].mode = 'approve'; _setPoliciesForTest(p);
  setNow(day(20));
  await ingestEmail(crexi({ property: 'Lighthouse Resort' }));
  assert.equal(mockMailbox.length, 2);
  assert.ok(!/Just sent you an email/.test(toBuyer().at(-1).text), toBuyer().at(-1).text);
});

test('fix 10: a listing without listing_code never reuses the buyer\'s deal for a different property', async () => {
  const lead = await db.insertLead({ source: 'listing_email', status: 'new', first_name: 'Jane', last_name: 'Buyer', phone: BUYER, listing_id: LH.id, property_name: 'Lighthouse Resort' });
  hs.dealSearch = [{ id: 'dOther', properties: { dealname: 'Jane Buyer – Walnut Estates - Kelseyville, CA', dealstage: S.qualified } }];
  const id = await hubspot.ensureBuyerDeal(lead, LH);
  assert.notEqual(id, 'dOther');
  assert.match(hs.deals[id].dealname, /Lighthouse Resort/);

  const lead2 = await db.insertLead({ source: 'listing_email', status: 'new', first_name: 'Al', phone: '+15305550199', listing_id: LH.id, property_name: 'Lighthouse Resort' });
  hs.dealSearch = [{ id: 'dOther', properties: { dealname: 'Al – Walnut Estates' } }, { id: 'dMine', properties: { dealname: 'Al - Lighthouse Resort' } }];
  assert.equal(await hubspot.ensureBuyerDeal(lead2, LH), 'dMine', 'a deal named for this listing is reused');
});

test('fix 11: a follow-up drawn from past correspondence waits for Pierce\'s Y, like a reply would', async () => {
  const doc = await db.insertDocument({ listing_id: LH.id, filename: '2026-03-12 Email - Buyer asked about seller carry.pdf', tier: 'sensitive', doc_type: 'history', status: 'processed', dropbox_id: 'h1' });
  await db.insertChunks([{ listing_id: LH.id, document_id: doc.id, tier: 'sensitive', content: 'Email thread March 2026\n[2026-03-12 PIERCE] Seller is not offering financing on Lighthouse. All-cash or conventional debt only.' }]);
  await ingestEmail(crexi());
  setNow(day(1, 0.1)); await tick(); // day 1: plain text follow-up
  const sentBefore = toBuyer().length; const mailBefore = mockMailbox.length;
  setNow(day(3, 0.2)); await tick(); // day 3 value touch uses prior_conversations
  assert.equal(toBuyer().length, sentBefore);
  assert.equal(mockMailbox.length, mailBefore, 'nothing went out on its own');
  const a = (await db.listPendingApprovals()).find((x) => x.kind === 'followup');
  assert.ok(a, 'held for Pierce');
  assert.equal(a.policy, 'reply.sensitive_docs');
  assert.equal(classify({ kind: 'followup', lead: { status: 'contacted' }, flags: { usedSensitive: true } }), 'reply.sensitive_docs');
  assert.equal(classify({ kind: 'followup', lead: { status: 'contacted' }, flags: {} }), 'followup.pre_ca');
});

test('fix 12: if wording Pierce\'s A# fails, the question stays open, nothing is saved, and he is told', async () => {
  await ingestEmail(crexi({ email: false }));
  const lead = await leadNow();
  const q = await db.createOwnerQuestion({ lead_id: lead.id, listing_id: LH.id, question: 'Is there a pool?' });
  const before = toBuyer().length;
  mockLlm.failPolish = true;
  await sms(PIERCE, `A${q.id} yes, heated`);
  assert.equal((await db.getOwnerQuestion(q.id)).status, 'open');
  assert.equal((await db.listQa(LH.id)).length, 0);
  assert.equal(toBuyer().length, before);
  assert.ok(ownerLog.some((t) => new RegExp(`Your A${q.id} didn't go out`).test(t)));
  assert.ok(!ownerLog.some((t) => /isn't open/.test(t)));
  mockLlm.failPolish = false;
  await sms(PIERCE, `A${q.id} yes, heated`);
  assert.equal((await db.getOwnerQuestion(q.id)).status, 'answered');
  assert.equal(toBuyer().at(-1).text, 'Confirmed: yes, heated');
});

test('fix 13: an expired first-touch approval moves the lead on (like N#) instead of leaving it awaiting_approval', async () => {
  await ingestEmail(crexi({ email: false, property: 'Some Other Agent Park' })); // unmatched: first text waits for Y
  assert.equal((await leadNow()).status, 'awaiting_approval');
  setNow(day(2, 1));
  assert.equal(await expireTick(), 1);
  assert.equal((await leadNow()).status, 'human');
});

test('fix 14: the same question again opens no second Q# and sends no second holding reply; a new topic does', async () => {
  const lead = await db.insertLead({ source: 'listing_email', status: 'engaged', first_name: 'Jane', phone: BUYER, listing_id: LH.id, property_name: 'Lighthouse Resort', last_inbound_at: at(0) });
  const hold = "Great question, I'll get back to you on that.";
  await applyDecision(lead, { action: 'ask_pierce', question_for_pierce: 'Is the well water tested monthly?', reply_text: hold });
  assert.equal((await db.listOpenOwnerQuestions(lead.id)).length, 1);
  assert.equal(toBuyer().length, 1);
  const r = await applyDecision(await db.getLead(lead.id), { action: 'ask_pierce', question_for_pierce: 'is the well water tested every month??', reply_text: hold });
  assert.ok(r.deduped);
  assert.equal((await db.listOpenOwnerQuestions(lead.id)).length, 1, 'no second Q#');
  assert.equal(toBuyer().length, 1, 'no second holding reply');
  assert.equal(ownerLog.filter((t) => /^Q\d+ /.test(t)).length, 1, 'Pierce asked once');
  await applyDecision(await db.getLead(lead.id), { action: 'ask_pierce', question_for_pierce: 'Are pets allowed in the RV sites?', reply_text: hold });
  assert.equal((await db.listOpenOwnerQuestions(lead.id)).length, 2, 'a different topic is a new question');
  assert.ok(sameTopic('Is the well water tested monthly?', 'well water tests monthly'));
  assert.ok(!sameTopic('Is the well water tested monthly?', 'Are pets allowed?'));
});

test('fix 14 (review): different questions that share words or names are NOT deduped; each gets its own Q#', async () => {
  const pairs = [
    ['Is the park on city water?', 'Is the park on city sewer?'],
    ['What is the lot rent?', 'When was the last lot rent increase?'],
    ['How many RV sites are there?', 'Do the RV sites have full hookups?'],
    ['Is there a pool?', 'Is the pool heated?'],
    ['How many park-owned homes are there?', 'How old are the park-owned homes?'],
    ['What are the property taxes?', 'What are the property taxes, insurance and roof age?'],
  ];
  for (const [a, b] of pairs) { assert.ok(!sameTopic(a, b), `${a} / ${b}`); assert.ok(!sameTopic(b, a), `${b} / ${a}`); }
  const names = ['Lighthouse Resort', 'Jane'];
  assert.ok(!sameTopic('Buyer asks: is the Lighthouse Resort water system city or well?', 'Buyer asks: what are the Lighthouse Resort property taxes?', names));
  assert.ok(sameTopic('What are the property taxes?', 'what are the property taxes at Lighthouse Resort??', names));

  const lead = await db.insertLead({ source: 'listing_email', status: 'engaged', first_name: 'Jane', phone: BUYER, listing_id: LH.id, property_name: 'Lighthouse Resort', last_inbound_at: at(0) });
  const hold = "Great question, I'll get back to you on that.";
  await applyDecision(lead, { action: 'ask_pierce', question_for_pierce: 'How many RV sites are there?', reply_text: hold });
  const r = await applyDecision(await db.getLead(lead.id), { action: 'ask_pierce', question_for_pierce: 'Do the RV sites have full hookups?', reply_text: 'On hookups, ' + hold });
  assert.ok(!r.deduped);
  assert.equal((await db.listOpenOwnerQuestions(lead.id)).length, 2, 'the hookups question reached Pierce');
  assert.equal(ownerLog.filter((t) => /^Q\d+ /.test(t)).length, 2);

  // the same question on a DIFFERENT listing is a new question (a listing-A Q# can't swallow it)
  await db.updateLead(lead.id, { listing_id: HAC.id, property_name: 'Hacienda Mobile Park' });
  const r2 = await applyDecision(await db.getLead(lead.id), { action: 'ask_pierce', question_for_pierce: 'How many RV sites are there?', reply_text: hold });
  assert.ok(!r2.deduped);
  assert.equal((await db.listOpenOwnerQuestions(lead.id)).length, 3);

  // a real repeat in new words: no new Q#, no holding reply, but Pierce still sees the buyer's wording
  const before = toBuyer().length;
  const r3 = await applyDecision(await db.getLead(lead.id), { action: 'ask_pierce', question_for_pierce: 'how many RV sites are there at Hacienda Mobile Park?', reply_text: hold });
  assert.ok(r3.deduped);
  assert.equal(toBuyer().length, before);
  assert.ok(ownerLog.some((t) => t.startsWith(`Asked again (Q${r3.deduped})`) && t.includes('at Hacienda Mobile Park')));
});

test('fix 15: email off: a quiet lead WITH an email goes to nurture (not closed) and is emailed once email is on', async () => {
  config.email.mode = 'off';
  await ingestEmail(crexi());
  assert.equal(mockMailbox.length, 0);
  setNow(day(1, 0.1)); await tick();
  setNow(day(3, 0.2)); await tick();
  setNow(day(7, 0.3)); await tick();
  assert.equal(toBuyer().length, 4, 'first text + days 1/3/7 by text');
  setNow(day(9, 0.5)); await tick();
  let lead = await leadNow();
  assert.equal(lead.status, 'nurture', 'kept for the long-term email list');
  assert.equal(lead.next_action_at, new Date(+new Date(day(9, 0.5)) + 14 * 864e5).toISOString());
  setNow(day(16, 0.5)); await tick();
  assert.equal((await leadNow()).status, 'nurture', 'still kept while email is off');
  config.email.mode = 'mock';
  setNow(day(7 + 14, 1)); await tick();
  lead = await leadNow();
  assert.equal(lead.status, 'nurture');
  assert.equal(mockMailbox.length, 1, 'nurture email once email is on');
  assert.match(mockMailbox[0].text, /are you still looking for MH or RV parks\?/);
});

test('Pierce, Nov 2: a text from a number that is not a lead (a seller, a contact) is never answered by the bot; Pierce gets it, B# hands it over', async () => {
  const { handleInboundSms } = await import('../src/agent/setter.js');
  const { mockOutbox } = await import('../src/ringcentral.js');
  const { ownerLog } = await import('../src/notify.js');
  const { db } = await import('../src/db/index.js');
  const SELLER = '+19164596179';
  const before = mockOutbox.filter((m) => m.to === SELLER).length;
  ownerLog.length = 0;
  const r = await handleInboundSms(SELLER, "Yes it's HMHP Inc", 'rc-seller-1');
  assert.equal(r.forwarded, 'unknown_number');
  const lead = await db.findLeadByPhone(SELLER);
  assert.equal(lead.status, 'human', 'created muted');
  await handleInboundSms(SELLER, 'I am not understanding', 'rc-seller-2');
  assert.equal(mockOutbox.filter((m) => m.to === SELLER).length, before, 'the bot never texted them');
  assert.ok(ownerLog.some((t) => /not a lead, L\d+\): "Yes it's HMHP Inc"\. The bot did NOT reply\. If it's a buyer, text B\d+/.test(t)));
  assert.ok(ownerLog.some((t) => /replied \(your thread, bot muted\): "I am not understanding"/.test(t)), 'follow-ups also go to Pierce');
});
