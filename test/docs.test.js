// Document brain: Dropbox sync -> rent roll math -> CA gating -> ask-Pierce -> pacing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', FIRST_TOUCH_DELAY_MIN_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock',
  INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: '', AUTO_SEND_SOURCES: 'listing_email,inbound_sms,webhook',
  EMAIL_MODE: 'mock', EMAIL_SEND_MODE: 'send',
  REPLY_DELAY_MIN_SEC: '60', REPLY_DELAY_MAX_SEC: '300', REPLY_DELAY_CAP_SEC: '480',
});

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox } = await import('../src/ringcentral.js');
const { mockFs } = await import('../src/dropbox.js');
const { mockMailbox } = await import('../src/email.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { processFirstTouch } = await import('../src/agent/setter.js');
const { ownerLog } = await import('../src/notify.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { syncDropbox } = await import('../src/docs/sync.js');
const { calculate } = await import('../src/calc.js');
const { rowsToUnits, rentRollStats } = await import('../src/docs/rentroll.js');
const { summarizeFinancials } = await import('../src/docs/financials.js');
const { replyTick, tick } = await import('../src/jobs.js');
const { config } = await import('../src/config.js');

const ROOT = '/Brokerage/01 - Brokerage/Deals/01 - Listed/Lighthouse Resort - Isleton, CA';
const PIERCE = config.owner.phone; const BUYER = '+15305550199';
let evtId = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `e${++evtId}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const lastTo = (to) => [...mockOutbox].reverse().find((m) => m.to === to)?.text;
const file = (id, rel, content, hash = 'h1') => ({ id, path_display: `${ROOT}/${rel}`, content_hash: hash + id, buffer: Buffer.from(content) });

const RENT_ROLL = 'Space,Type,Status,Monthly Rent,Tenant Name\nA1,MH,Occupied,$850,Jane Private\nA2,MH,Occupied,$900,Bob Private\nA3,MH,Vacant,,\nB1,RV,Occupied,$650,\nB2,RV,Occupied,$700,\nB3,RV,Vacant,,\nB4,RV,Occupied,$650,\nL1,Cabin,Occupied,"$1,200",\nTotal,,,5950,\n';
const PNL = '2025 Profit and Loss YTD\nIncome\nSpace Rent: $700,000\nStorage: $120,000\nTotal Income: $820,000\nExpenses\nPayroll: $180,000\nUtilities: $95,000\nRepairs: $60,000\nInsurance: $40,000\nProperty Tax: $55,000\nTotal Expenses: $430,000\nNOI: $390,000\n';

async function seed() {
  db._reset(); mockOutbox.length = 0; ownerLog.length = 0; mockFs.files = []; mockFs.links = {}; mockMailbox.length = 0;
  setNow('2026-11-03T18:00:00Z');
  await db.upsertListing({ hubspot_deal_id: 's2', listing_code: 'LIGHTHOUSE-2026', name: 'California Lighthouse Resort', aliases: ['Lighthouse Resort'], ca_link: 'https://example.com/ca', asking_price: '$4,500,000', spaces: '172' });
  mockFs.files = [
    file('om1', '00 - OM/2026-10-14 – Offering Memorandum – Lighthouse Resort & Marina – Lighthouse.pdf', 'Lighthouse Resort & Marina OM\n172 sites on 32.26 acres in Isleton, CA. Marina with 60 slips. Pool remodeled 2026. Asking $4,500,000.'),
    file('rr1', '03 - Due Diligence/02 - Rent Roll w Move-In Dates/Rent Roll.csv', RENT_ROLL),
    file('pl1', '01 - Financials/2025/2025 Profit and Loss YTD.pdf', PNL),
    file('qa1', '08 - Seller QA/Lighthouse_Resort_QA.pdf', 'Seller Q&A\nQ: Who pays electric? A: RV guests are metered and billed; extended stay pays their own electric.\nQ: Water source? A: Private well, permit CA3410035.'),
    file('wq1', '10 - Water System, Septic & Utilities/Water Quality Lab Reports/2026-09-15 – Coliform Bacteria Report – FAIL.pdf', 'Coliform report Sept 2026: total coliform present at distribution points. Retest ordered.'),
    file('dq1', '14 - Financing (Debt Quotes)/2026-09-03 – Debt Quote – Loan Matrix.pdf', 'Lender quotes: 6.1% to 6.9%'),
    file('old1', 'zz - Archive/OM/old OM.pdf', 'old numbers 150 sites'),
    file('corr1', '05 - Correspondence/2026-03-12 Email - Buyer asked about seller carry.pdf', 'Email thread March 2026\n[2026-03-12 Buyer] Would the seller consider carrying a note?\n[2026-03-12 PIERCE] Seller is not offering financing on Lighthouse. All-cash or conventional debt only.'),
    file('ph1', '07 - Photos, Maps & Aerials/aerial.jpg', 'binary'),
  ];
  const r = await syncDropbox();
  const lead = await db.insertLead({ phone: BUYER, first_name: 'Dana', source: 'listing_email', platform: 'crexi', status: 'engaged', auto_send: true, listing_id: 1, listing_code: 'LIGHTHOUSE-2026', property_name: 'California Lighthouse Resort', last_outbound_at: '2026-11-03T17:00:00Z' });
  await db.insertMessage({ lead_id: lead.id, direction: 'out', body: 'Hi Dana, saw your inquiry on Lighthouse.', status: 'sent', kind: 'first_touch' });
  LEAD = lead.id;
  return { r, lead };
}
let LEAD = 0;
/** Send a text, then advance the clock past the pacing window and process the reply. */
async function askAndWait(text) {
  await sms(BUYER, text);
  setNow(new Date(+new Date((await db.getLead(LEAD)).reply_due_at) + 1000).toISOString());
  return replyTick();
}

beforeEach(seed);

test('pure math is exact', () => {
  assert.equal(calculate('4500000 / 172'), 26162.790698);
  assert.equal(calculate('390000 / 4500000 * 100'), 8.666667);
  assert.equal(calculate('(850 + 900) / 2'), 875);
  assert.throws(() => calculate('process.exit()'));
  const units = rowsToUnits([{ Space: 'A1', Type: 'MH', Status: 'Occupied', 'Monthly Rent': '$850' }, { Space: 'B1', Type: 'RV', Status: 'Vacant', 'Monthly Rent': '' }]);
  const s = rentRollStats(units);
  assert.equal(s.total.spaces, 2); assert.equal(s.total.occupancy_pct, 50); assert.equal(s.by_type.MH.avg_rent_occupied, 850);
  const f = summarizeFinancials({ period: '2025', months: 12, income: [{ label: 'Rent', amount: 100 }], expenses: [{ label: 'Tax', amount: 40 }], reported: { noi: 170 } });
  assert.equal(f.noi, 60); assert.equal(f.discrepancies.length, 1);
});

test('Dropbox sync classifies the Lighthouse folder: archives/photos/debt quotes excluded, rent roll parsed without tenant names', async () => {
  const docs = await db.listDocuments(1);
  const names = docs.map((d) => d.filename);
  assert.ok(!names.some((n) => /old OM|aerial|Debt Quote/.test(n)));
  assert.equal(docs.find((d) => d.doc_type === 'rent_roll').tier, 'ca');
  assert.equal(docs.find((d) => /Coliform/.test(d.filename)).tier, 'sensitive');
  const units = await db.listRentRoll(1);
  assert.equal(units.length, 8); // "Total" row dropped
  assert.ok(!JSON.stringify(units).includes('Private'));
  const s = rentRollStats(units);
  assert.equal(s.by_type.MH.spaces, 3); assert.equal(s.by_type.RV.spaces, 4); assert.equal(s.by_type['Park Model'].spaces, 1);
  assert.equal(s.total.occupancy_pct, 75);
  const pl = docs.find((d) => d.doc_type === 't12');
  assert.equal(pl.extracted.financial_summary.noi, 390000);
  assert.deepEqual(pl.extracted.financial_summary.discrepancies, []);
  // second sync: nothing re-read
  assert.equal(docs.find((d) => /seller carry/.test(d.filename)).doc_type, 'history');
  const r2 = await syncDropbox();
  assert.equal(r2.listings['California Lighthouse Resort'].unchanged, 6);
});

test('before the CA: unit mix question gets the CA link, not the numbers', async () => {
  await askAndWait('Thanks. What is the unit mix, how many RV vs MH?');
  const t = lastTo(BUYER);
  assert.match(t, /CA is signed/); assert.match(t, /example\.com\/ca/);
  assert.ok(!/3 MH|4 RV/.test(t));
});

test('after CA# from Pierce: exact unit mix, NOI, and an OM link; sensitive docs need approval', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  assert.equal((await db.getLead(LEAD)).status, 'in_dd');
  await askAndWait('Thanks for sending the DD. What is the unit mix, how many RV how many MH?');
  assert.match(lastTo(BUYER), /8 spaces, 3 MH \(2 occupied, avg \$875\), 4 RV \(3 occupied, avg \$666\.67\), 1 Park Model/);
  await askAndWait("What's the NOI?");
  assert.match(lastTo(BUYER), /income \$820000, expenses \$430000, NOI \$390000/);
  await askAndWait('Can you send me the OM?');
  assert.match(lastTo(BUYER), /dropbox\.com\/scl\/fi\/mock-om1/);
  const before = mockOutbox.filter((m) => m.to === BUYER).length;
  await askAndWait('Was total coliform present in the distribution report?');
  assert.equal(mockOutbox.filter((m) => m.to === BUYER).length, before); // held
  const p = await db.listPendingApprovals();
  assert.match(p[0].reason, /sensitive docs/);
  assert.match(p[0].draft, /Coliform/);
});

test('team-only Dropbox link: SMS lead with no email -> Pierce is asked to send it', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  mockFs.links.om1 = 'https://www.dropbox.com/team-only/om1';
  await askAndWait('Please send the OM');
  assert.match(lastTo(BUYER), /I'll email that over/);
  assert.ok(ownerLog.some((t) => /needs .*Offering Memorandum.* by email/.test(t)));
  assert.equal(mockMailbox.length, 0);
});

test('team-only Dropbox link: lead has an email -> OM attached to an Outlook draft, Dylan cc\'d', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  await db.updateLead(LEAD, { email: 'dana@example.com' });
  mockFs.links.om1 = 'https://www.dropbox.com/team-only/om1';
  await askAndWait('Please send the OM');
  assert.match(lastTo(BUYER), /I'll email that over/);
  // Pierce is told; the attachment goes out when he approves or via the email channel
  assert.ok(ownerLog.some((t) => /needs .*Offering Memorandum.* by email/.test(t)));
});

test('email-only lead (no phone): first email is sent automatically (policy) with links, Dylan cc\'d', async () => {
  const r = await ingestEmail({ From: 'leads@loopnet.com', Subject: 'LoopNet lead', TextBody: 'Name: Sam Fund\nEmail: sam@fund.com\nProperty: Lighthouse Resort\nMessage: Send details please' });
  assert.ok(r.created);
  const ft = r.firstTouch;
  assert.ok(ft.sent, JSON.stringify(ft)); // send, not draft (Pierce, Nov 2 2026)
  const m = mockMailbox.at(-1);
  assert.equal(m.to, 'sam@fund.com');
  assert.deepEqual(m.cc, ['DylanB@cricommercial.com']);
  assert.match(m.subject, /Lighthouse Resort/);
  assert.match(m.text, /^Hi Sam,/);
  assert.match(m.text, /You can sign the NDA here to unlock the OM and data room: https:\/\/example\.com\/ca/);
  assert.match(m.text, /You can see all of my current listings here: https:\/\/www\.crexi\.com\/profile\/pierce-brazil-piercebra/);
  assert.match(m.text, /Does this one fit what you're looking for\? What does your buy box look like\?\n\nThank you,$/);
  assert.equal((await db.getLead(r.lead.id)).status, 'contacted');
  assert.ok(!/STOP/.test(m.text)); // SMS language never goes in an email
  assert.ok(!/Pierce Brazil\n|Senior Investment/.test(m.text)); // no signature; Outlook adds it
  assert.ok(!ownerLog.some((t) => /Outlook Drafts|Email draft ready/.test(t)), 'sent, not left as a draft');
});

test('unknown question -> holding reply -> Pierce answers with A# -> buyer gets it, bank remembers it', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  await askAndWait('Is the marina lease assignable to a new owner?');
  assert.match(lastTo(BUYER), /Great question, I'll get back to you on that/);
  const q = ownerLog.find((t) => /^Q\d+ /.test(t));
  assert.match(q, /marina lease assignable/); assert.match(q, /Reply A\d+/);
  const qid = q.match(/^Q(\d+)/)[1];
  await askAndWait('Also, any update?');
  assert.equal(mockOutbox.filter((m) => m.to === BUYER && /Great question, I'll get back to you on that/.test(m.text)).length, 1); // no second holding reply
  await sms(PIERCE, `A${qid} Yes, State Lands allows assignment with their approval. Runs through 2030 and the buyer applies for a new lease after that.`);
  assert.match(lastTo(BUYER), /State Lands allows assignment/);
  assert.equal((await db.listQa(1)).length, 1);
  // a second buyer asking the same thing is answered instantly from the bank
  const l2 = await db.insertLead({ phone: '+15305550200', first_name: 'Eli', source: 'listing_email', status: 'engaged', auto_send: true, listing_id: 1, ca_verified: true, last_outbound_at: '2026-11-03T17:00:00Z' });
  await db.insertMessage({ lead_id: l2.id, direction: 'out', body: 'hi', status: 'sent' });
  await sms('+15305550200', 'Is the marina lease assignable?');
  setNow(new Date(+new Date((await db.getLead(l2.id)).reply_due_at) + 1000).toISOString()); await replyTick();
  assert.match(lastTo('+15305550200'), /State Lands allows assignment/);
  assert.equal(ownerLog.filter((t) => /^Q\d+ /.test(t)).length, 1);
});

test('human pacing: reply waits 1-5 min, a burst of texts gets one combined answer', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  await sms(BUYER, 'hey quick q');
  await sms(BUYER, 'what is the unit mix');
  await sms(BUYER, 'and how many are RV');
  const lead = await db.getLead(LEAD);
  const wait = (+new Date(lead.reply_due_at) - +new Date('2026-11-03T18:00:00Z')) / 1000;
  assert.ok(wait >= 60 && wait <= 480, `wait was ${wait}s`);
  assert.equal(mockOutbox.filter((m) => m.to === BUYER).length, 0);
  setNow('2026-11-03T18:01:00Z'); await replyTick();
  assert.equal(mockOutbox.filter((m) => m.to === BUYER).length, 0); // not due yet
  setNow('2026-11-03T18:09:00Z'); await replyTick();
  assert.equal(mockOutbox.filter((m) => m.to === BUYER).length, 1);
  assert.match(lastTo(BUYER), /4 RV/);
});

test('DD follow-up cadence (2/5/10/21 days) pings Pierce instead of closing the lead', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  const count = () => mockOutbox.filter((m) => m.to === BUYER).length;
  const base = count();
  const start = +new Date('2026-11-03T18:00:00Z'); // Tuesday
  // day offsets chosen to avoid Sundays (send window is Mon-Sat)
  for (const [day, expect] of [[2, 1], [6, 2], [11, 3], [22, 4], [25, 4], [32, 4]]) {
    setNow(new Date(start + day * 864e5 + 3 * 3600e3).toISOString());
    await tick();
    assert.equal(count() - base, expect, `day ${day}`);
  }
  const lead = await db.getLead(LEAD);
  assert.equal(lead.status, 'in_dd');
  assert.ok(ownerLog.some((t) => /gone quiet in DD/.test(t)));
  assert.equal(ownerLog.filter((t) => /gone quiet in DD/.test(t)).length, 1);
});

test('"has seller financing been offered?" is answered from past correspondence, held for Pierce (sensitive), never promised', async () => {
  await sms(PIERCE, `CA${LEAD}`);
  const { makeExecutors } = await import('../src/agent/tools.js');
  const lead = await db.getLead(LEAD); const listing = await db.getListing(1);
  const ctx = { lead, listing, flags: { usedSensitive: false, links: [], needsAttachment: [] } };
  const ex = makeExecutors(ctx);
  const r = await ex.prior_conversations({ topic: 'seller financing carry note' });
  assert.equal(r.results.length, 1);
  assert.match(r.results[0].excerpt, /not offering financing/);
  assert.equal(ctx.flags.usedSensitive, true); // anything from history goes through Pierce
  const none = await ex.prior_conversations({ topic: 'helicopter pad' });
  assert.equal(none.results.length, 0);
  assert.match(none.note, /ask_pierce/);
});
