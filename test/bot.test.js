// End-to-end tests with in-memory DB, mock SMS, mock LLM, and a fake HubSpot API.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', FIRST_TOUCH_DELAY_MIN_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock',
  INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: 'fake', BOOKING_LINK: '',
  AUTO_SEND_SOURCES: 'listing_email,inbound_sms,webhook', REPLY_DELAY_MAX_SEC: '0', DROPBOX_MODE: 'off',
});

// ---- fake HubSpot ----
const hsState = { deals: {}, contacts: 0, notes: [] };
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null; const m = opts.method;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.pathname === '/crm/v3/objects/contacts/search') return ok({ results: [] });
  if (u.pathname === '/crm/v3/objects/contacts' && m === 'POST') return ok({ id: `c${++hsState.contacts}` });
  if (u.pathname === '/crm/v3/objects/deals/search') return ok({ results: [] });
  if (u.pathname === '/crm/v3/objects/deals' && m === 'POST') { const id = `d${Object.keys(hsState.deals).length + 1}`; hsState.deals[id] = { ...body.properties }; return ok({ id }); }
  const dm = u.pathname.match(/^\/crm\/v3\/objects\/deals\/(\w+)$/);
  if (dm && m === 'GET') return ok({ id: dm[1], properties: hsState.deals[dm[1]] });
  if (dm && m === 'PATCH') { Object.assign(hsState.deals[dm[1]], body.properties); return ok({ id: dm[1] }); }
  if (u.pathname === '/crm/v3/objects/notes') { hsState.notes.push(body.properties.hs_note_body); return ok({ id: 'n' }); }
  throw new Error(`unmocked ${m} ${u.pathname}`);
};

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox } = await import('../src/ringcentral.js');
const { ownerLog } = await import('../src/notify.js');
const g = await import('../src/guardrails.js');
const { decideStageMove } = await import('../src/hubspot.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { importCsv, parseCsv } = await import('../src/intake/csv.js');
const { tick } = await import('../src/jobs.js');
const { config } = await import('../src/config.js');

const TUE_10AM = '2026-11-03T18:00:00Z'; // 10:00 PST
const TUE_11PM = '2026-11-04T07:00:00Z'; // 23:00 PST
const S = config.hubspot.stages;
let evtId = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `e${++evtId}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const lastTo = (to) => [...mockOutbox].reverse().find((m) => m.to === to)?.text;
const crexiEmail = (over = {}) => ({
  From: 'notifications@crexi.com', Subject: 'New lead on Hidden Harbor Marina & RV Park',
  TextBody: 'You have a new lead on Crexi.\nName: Jane Buyer\nEmail: jane@example.com\nPhone: (530) 555-0101\nProperty: Hidden Harbor Marina & RV Park\nMessage: Is the RV park still available?',
  ...over,
});

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; ownerLog.length = 0; hsState.deals = {}; hsState.notes = []; setNow(TUE_10AM);
  await db.upsertListing({ hubspot_deal_id: 's1', listing_code: 'HARBOR-2026', name: 'Hidden Harbor Marina & RV Park', ca_link: 'https://example.com/ca' });
});

test('guardrails', () => {
  assert.equal(g.normalizePhone('(949) 335-5921'), '+19493355921');
  assert.equal(g.normalizePhone('1-949-335-5921'), '+19493355921');
  assert.equal(g.normalizePhone('555'), null);
  assert.equal(g.optOutIntent('STOP'), 'keyword');
  assert.equal(g.optOutIntent('please remove me from your list'), 'phrase');
  assert.equal(g.optOutIntent('wrong number'), 'wrong_number');
  assert.equal(g.optOutIntent("Can't stop thinking about this park"), null);
  assert.ok(g.needsHuman('Would the seller carry paper?'));
  assert.ok(g.needsHuman("What's the lowest they'd take"));
  assert.ok(!g.needsHuman('How many spaces?'));
  assert.ok(g.inWindow(config.sendWindow, new Date(TUE_10AM)));
  assert.ok(!g.inWindow(config.sendWindow, new Date(TUE_11PM)));
  assert.ok(!g.inWindow(config.sendWindow, new Date('2026-11-08T18:00:00Z'))); // Sunday
});

test('HubSpot stage rules never move human-owned deals or go backward', () => {
  assert.equal(decideStageMove(S.newBuyer, 'booked').stage, S.qualified);
  assert.equal(decideStageMove(S.qualified, 'engaged'), null); // no backward
  assert.equal(decideStageMove(S.offerOut, 'opted_out'), null); // Pierce owns Offer Out+
  assert.equal(decideStageMove(S.qualified, 'no_response'), null); // qualified buyers aren't auto-killed
  assert.equal(decideStageMove(S.newBuyer, 'no_response').lostReason, 'unresponsive');
  assert.equal(decideStageMove(S.qualified, 'opted_out').stage, S.lost);
  assert.equal(decideStageMove(S.lost, 'engaged').stage, S.newBuyer); // came back
});

test('Crexi email -> instant first text -> HubSpot deal in New Buyer', async () => {
  const r = await ingestEmail(crexiEmail());
  assert.ok(r.created);
  assert.ok(r.firstTouch.sent);
  const text = lastTo('+15305550101');
  // Pierce's voice (Nov 1 2026): as Pierce, no AI announcement, no STOP line, one qualifying question
  assert.match(text, /^Hey Jane, this is Pierce over at CRI Brokerage! Saw your inquiry on Hidden Harbor Marina & RV Park on Crexi\./);
  assert.match(text, /You can sign the NDA here to unlock the OM: https:\/\/example\.com\/ca/);
  assert.match(text, /What's the best email to send you the details\?$/); // one question, at the end
  assert.ok(!/STOP|opt out|\bAI\b|assistant/i.test(text), text);
  const lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'contacted');
  assert.equal(lead.listing_code, 'HARBOR-2026');
  const deal = hsState.deals[lead.hubspot_deals['HARBOR-2026']];
  assert.equal(deal.dealstage, S.newBuyer);
  assert.equal(deal.listing_code, 'HARBOR-2026');
  assert.match(deal.dealname, /Jane Buyer – Hidden Harbor/);
});

test('email from an unknown sender is ignored', async () => {
  assert.deepEqual(await ingestEmail({ From: 'x@y.com', Subject: 'Lunch?', TextBody: 'hey' }), { ignored: 'unknown_platform' });
});

test('full conversation: qualify -> book -> deal moves to Qualified, Pierce alerted', async () => {
  await ingestEmail(crexiEmail());
  await sms('+15305550101', 'Me and a partner, paying cash');
  assert.match(lastTo('+15305550101'), /quick 15-min call/);
  let lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'qualified');
  await sms('(530) 555-0101', 'Tuesday at 10am works');
  lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'booked');
  assert.ok(ownerLog.some((t) => t.startsWith('BOOKED:')));
  assert.equal(hsState.deals[lead.hubspot_deals['HARBOR-2026']].dealstage, S.qualified);
  assert.ok(hsState.notes.some((n) => n.includes('Call booked')));
});

test('STOP opts out, closes the deal, and nothing else is ever sent', async () => {
  await ingestEmail(crexiEmail());
  const before = mockOutbox.length;
  await sms('+15305550101', 'STOP');
  assert.equal(mockOutbox.length, before); // carrier confirms keyword STOP, we stay silent
  const lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'opted_out');
  const deal = hsState.deals[lead.hubspot_deals['HARBOR-2026']];
  assert.equal(deal.dealstage, S.lost);
  assert.equal(deal.lost_reason_category, 'other');
  await sms('+15305550101', 'hello?');
  setNow('2026-11-06T18:00:00Z'); await tick();
  assert.equal(mockOutbox.filter((m) => m.to === '+15305550101').length, 1);
  // re-importing the same person doesn't restart them
  assert.deepEqual(await ingestEmail(crexiEmail()), { skipped: 'opted_out' });
});

test('price/terms question goes to Pierce for approval; Y sends it', async () => {
  await ingestEmail(crexiEmail());
  const sentBefore = mockOutbox.filter((m) => m.to === '+15305550101').length;
  await sms('+15305550101', 'Would the seller take a lower offer?');
  assert.equal(mockOutbox.filter((m) => m.to === '+15305550101').length, sentBefore); // held
  const pending = await db.listPendingApprovals();
  assert.equal(pending.length, 1);
  assert.ok(ownerLog.some((t) => t.includes(`Y${pending[0].id} send`)));
  let lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'escalated');
  await sms(config.owner.phone, `E${pending[0].id} Good question. Pierce will call you this afternoon to walk through it.`);
  assert.equal(lastTo('+15305550101'), 'Good question. Pierce will call you this afternoon to walk through it.');
  // bot stays muted on escalated threads; replies get forwarded to Pierce
  await sms('+15305550101', 'ok thanks');
  assert.ok(ownerLog.at(-1).includes('bot muted'));
});

test('quiet hours: first text waits for the morning window', async () => {
  setNow(TUE_11PM);
  const r = await ingestEmail(crexiEmail());
  assert.equal(r.firstTouch.deferred, 'outside_window');
  assert.equal(mockOutbox.length, 0);
  setNow('2026-11-04T16:05:00Z'); // Wed 8:05am PST
  await tick();
  assert.match(lastTo('+15305550101'), /^Hey Jane/);
});

test('follow-up cadence: day 1, day 3, day 7, then closed as no_response', async () => {
  await ingestEmail(crexiEmail());
  const count = () => mockOutbox.filter((m) => m.to === '+15305550101').length;
  setNow('2026-11-04T18:30:00Z'); await tick(); assert.equal(count(), 2);
  setNow('2026-11-05T18:30:00Z'); await tick(); assert.equal(count(), 2); // only 1 day since nudge
  setNow('2026-11-06T19:00:00Z'); await tick(); assert.equal(count(), 3);
  setNow('2026-11-10T19:30:00Z'); await tick(); assert.equal(count(), 4);
  setNow('2026-11-12T20:00:00Z'); await tick();
  const lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'no_response');
  assert.equal(hsState.deals[lead.hubspot_deals['HARBOR-2026']].lost_reason_category, 'unresponsive');
});

test('CSV import: maps Crexi-style headers, dedupes, queues for approval, paces sends', async () => {
  const csv = '﻿First Name,Last Name,Email,Phone Number,Company,Property Name\n'
    + 'Bob,Smith,bob@x.com,949-555-0102,"Smith Holdings, LLC",Hidden Harbor Marina & RV Park\n'
    + 'Bob,Smith,bob@x.com,949-555-0102,"Smith Holdings, LLC",Hidden Harbor Marina & RV Park\n'
    + 'Amy,"O""Neil",amy@x.com,,AO Capital,Hidden Harbor\n'
    + 'Cara,Lee,cara@x.com,(714) 555-0103,,\n';
  assert.equal(parseCsv(csv)[0].Company, 'Smith Holdings, LLC');
  const s = await importCsv(Buffer.from(csv), { defaultProperty: 'Some Other Park' });
  assert.deepEqual([s.total, s.created, s.duplicates, s.no_phone], [4, 3, 1, 1]);
  assert.equal(ownerLog.length, 0); // no per-row spam
  await tick();
  const pending = await db.listPendingApprovals();
  assert.equal(pending.length, 2); // csv leads need approval by default
  assert.equal(mockOutbox.filter((m) => m.to !== config.owner.phone).length, 0);
  await sms(config.owner.phone, 'YA');
  assert.match(lastTo('+19495550102'), /Following up on your interest in Hidden Harbor/);
  assert.match(lastTo('+17145550103'), /Some Other Park/);
});

test('duplicate webhook delivery is processed once; PAUSE holds everything', async () => {
  await ingestEmail(crexiEmail());
  const evt = { body: { id: 'same', type: 'SMS', direction: 'Inbound', from: { phoneNumber: '+15305550101' }, subject: 'cash buyer' } };
  await handleRingCentralEvent(evt);
  assert.deepEqual(await handleRingCentralEvent(evt), { duplicate: true });
  await sms(config.owner.phone, 'PAUSE');
  const before = mockOutbox.filter((m) => m.to === '+15305550101').length;
  await sms('+15305550101', 'what day works for you?');
  assert.equal(mockOutbox.filter((m) => m.to === '+15305550101').length, before);
  assert.equal((await db.listPendingApprovals()).length, 1);
});

test('RVParkStore lead (real email format) matches the listing and names the right platform', async () => {
  await db.upsertListing({ hubspot_deal_id: 's2', listing_code: 'LIGHTHOUSE-2026', name: 'California Lighthouse Resort' });
  const r = await ingestEmail({
    From: 'leads@rvparkstore.com',
    Subject: 'Someone is Interested in Your Listing',
    TextBody: `Someone is Interested in Your Listing
Test Buyer (test.buyer@example.com) contacted you for Lighthouse Resort

Test Buyer Wrote:

I am interested in Lighthouse Resort. Please contact me for more information. End buyer ready to move forward.

Contact Information:

Name\tTest Buyer
Email\ttest.buyer@example.com
Phone\t555-201-0199
Your Listing:

Lighthouse Resort
Isleton, CA
$4,500,000 172 Lots
Selling an RV park, RV, or RV lot? Advertise on RvParkStore.com for maximum exposure`,
  });
  assert.ok(r.created && r.firstTouch.sent);
  const lead = await db.findLeadByPhone('+15552010199');
  assert.equal(lead.platform, 'rvparkstore');
  assert.equal(lead.listing_code, 'LIGHTHOUSE-2026');
  assert.equal(lead.first_name, 'Test');
  assert.match(lastTo('+15552010199'), /Saw your inquiry on Lighthouse Resort on RVParkStore\./); // the name the buyer saw
  assert.match(hsState.deals[lead.hubspot_deals['LIGHTHOUSE-2026']].dealname, /Test Buyer – California Lighthouse Resort/);
});

test('LoopNet and website-form leads; forwarded email still detected by body', async () => {
  await ingestEmail(crexiEmail({ From: 'noreply@loopnet.com', Subject: 'LoopNet Lead', TextBody: crexiEmail().TextBody.replace('Crexi', 'LoopNet') }));
  assert.match(lastTo('+15305550101'), / on LoopNet\./);
  await ingestEmail({ From: 'pbrazil@cribrokerage.com', Subject: 'Fwd: New form submission', TextBody: 'Forwarded from HubSpot\nName: Web Lead\nEmail: web@example.com\nPhone: 555-201-0200\nProperty: Hidden Harbor' });
  const t = lastTo('+15552010200');
  assert.match(t, /Saw your inquiry on Hidden Harbor\. You can sign the NDA/); // no platform named; the buyer's own wording
});
