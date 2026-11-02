// Pierce's Nov 1 2026 rules: email-then-text first contact in his voice, human pacing, all listed deals,
// under-contract pivot, seller names never shown, LoopNet favorites, "are you a bot?" goes to Pierce.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock',
  EMAIL_MODE: 'mock', EMAIL_SEND_MODE: 'draft', INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: '',
  REPLY_DELAY_MAX_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0',
});

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox } = await import('../src/ringcentral.js');
const { mockMailbox } = await import('../src/email.js');
const { mockFs } = await import('../src/dropbox.js');
const { ownerLog } = await import('../src/notify.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { firstTouchTick, replyTick } = await import('../src/jobs.js');
const { firstTouchText } = await import('../src/agent/setter.js');
const { publicListingName, mostRestrictive } = await import('../src/listings.js');
const { listingStatusFor } = await import('../src/hubspot.js');
const { syncDropbox } = await import('../src/docs/sync.js');
const { asksIfBot, needsHuman } = await import('../src/guardrails.js');
const { config } = await import('../src/config.js');

const T0 = '2026-11-03T18:00:00Z'; // Tue 10:00 PST
const at = (sec) => new Date(+new Date(T0) + sec * 1000).toISOString();
const PIERCE = config.owner.phone;
let evtId = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `p${++evtId}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const toBuyer = (phone) => mockOutbox.filter((m) => m.to === phone);
const lead = (over = '') => ({ From: 'notifications@crexi.com', Subject: 'New lead', TextBody: `Name: Jane Buyer\nEmail: jane@example.com\nPhone: (530) 555-0101\nProperty: Lighthouse Resort\nMessage: Is this still available?${over}` });
const zeroTimers = () => Object.assign(config, {
  firstTouchDelay: { minSec: 0, maxSec: 0 }, textAfterEmail: { minSec: 0, maxSec: 0 }, pace: { minSec: 0, maxSec: 0 }, minGapSec: 0,
});

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; mockMailbox.length = 0; ownerLog.length = 0; mockFs.files = []; mockFs.links = {};
  setNow(T0); zeroTimers();
  const l = await db.upsertListing({ hubspot_deal_id: 'h1', name: 'Lighthouse Resort', ca_link: 'https://example.com/ca', hub_url: 'https://cri.example/lighthouse', summary: '172 sites on the Delta in Isleton.' });
  await db.insertDocument({ listing_id: l.id, filename: 'Lighthouse Resort Flyer.pdf', tier: 'public', doc_type: 'om', status: 'processed', dropbox_id: 'fly1' });
  await db.insertDocument({ listing_id: l.id, filename: 'Offering Memorandum.pdf', tier: 'ca', doc_type: 'om', status: 'processed', dropbox_id: 'om1' });
  await db.upsertListing({ hubspot_deal_id: 'h2', name: 'Walnut Estates - Kelseyville, CA', status: 'in_escrow', ca_link: 'https://example.com/ca2' });
  await db.upsertListing({ hubspot_deal_id: 'h3', name: 'Boon Chan - Hacienda Mobile Park', ca_link: 'https://example.com/ca3' });
});

test('first contact: email with links at 1-2 min, then a text 4-6 min later pointing to it, in Pierce\'s voice', async () => {
  Object.assign(config, { firstTouchDelay: { minSec: 60, maxSec: 120 }, textAfterEmail: { minSec: 240, maxSec: 390 } });
  const r = await ingestEmail(lead());
  assert.equal(r.firstTouch.deferred, 'pacing'); // nothing goes out the instant the inquiry lands
  assert.equal(mockMailbox.length + mockOutbox.length, 0);

  setNow(at(59)); await firstTouchTick();
  assert.equal(mockMailbox.length, 0, 'not before 1 minute');
  setNow(at(121)); await firstTouchTick();
  assert.equal(mockMailbox.length, 1, 'email by 2 minutes');
  const m = mockMailbox[0];
  assert.match(m.text, /^Hi Jane,\n\nThanks for reaching out on Lighthouse Resort on Crexi\./);
  assert.match(m.text, /172 sites on the Delta/);
  assert.match(m.text, /Listing page: https:\/\/cri\.example\/lighthouse/);
  assert.match(m.text, /Lighthouse Resort Flyer: https:\/\/www\.dropbox\.com\/scl\/fi\/mock-fly1/); // public doc linked proactively
  assert.ok(!/mock-om1/.test(m.text), 'CA-gated OM is never linked before the CA');
  assert.match(m.text, /You can sign the NDA here to unlock the OM and data room: https:\/\/example\.com\/ca\b/);
  assert.match(m.text, /You can see all of my current listings here: https:\/\/www\.crexi\.com\/profile\/pierce-brazil-piercebra/);
  assert.match(m.text, /What does your buy box look like\?\n\nThank you,$/);
  assert.equal(toBuyer('+15305550101').length, 0, 'text waits for the email to land');

  setNow(at(121 + 239)); await firstTouchTick();
  assert.equal(toBuyer('+15305550101').length, 0, 'not before 4 minutes after the email');
  setNow(at(121 + 391)); await firstTouchTick();
  const texts = toBuyer('+15305550101');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "Hey Jane, this is Pierce over at CRI Brokerage! Just sent you an email with the info on Lighthouse Resort, so check your inbox when you get a chance. Happy to hop on a quick call if helpful. Are you buying on your own or with a group?");
  assert.equal((await db.findLeadByPhone('+15305550101')).status, 'contacted');
});

test('no message ever says STOP, opt out, AI or assistant; STOP still opts out in code', async () => {
  await ingestEmail(lead());
  for (const t of [...mockOutbox.map((x) => x.text), ...mockMailbox.map((x) => x.text)]) assert.ok(!/STOP|opt.?out|\bAI\b|assistant|bot\b/i.test(t), t);
  await sms('+15305550101', 'STOP');
  assert.ok(await db.isOptedOut('+15305550101'));
});

test('text-only lead outside the send window: email-free lead texts at 8am; an email lead still gets the email at night', async () => {
  setNow('2026-11-04T07:00:00Z'); // 11pm PST
  const r = await ingestEmail(lead());
  assert.equal(mockMailbox.length, 1, 'email goes any hour');
  assert.equal(r.firstTouch.deferred, 'outside_window');
  assert.equal(toBuyer('+15305550101').length, 0, 'no texts at 11pm');
  setNow('2026-11-04T16:05:00Z'); await firstTouchTick();
  assert.match(toBuyer('+15305550101')[0].text, /Just sent you an email/);
});

test('under contract (Walnut Estates): no documents, says so, asks what they want, and tells Pierce the criteria', async () => {
  await ingestEmail({ From: 'notifications@crexi.com', Subject: 'New lead', TextBody: 'Name: Al Buyer\nEmail: al@example.com\nPhone: 530-555-0177\nProperty: Walnut Estates\nMessage: send the OM' });
  const email = mockMailbox.at(-1).text;
  assert.match(email, /on Walnut Estates\. It's under contract right now, but I have other listings that may fit\./);
  assert.match(email, /pierce-brazil-piercebra/);
  assert.ok(!/example\.com\/ca2/.test(email), 'no CA link for a deal under contract');
  assert.equal(toBuyer('+15305550177')[0].text, 'Hey Al, this is Pierce over at CRI Brokerage! Thanks for your inquiry on Walnut Estates. That one is under contract, but I have other listings that may fit: https://www.crexi.com/profile/pierce-brazil-piercebra What does your buy box look like?');
  await sms('+15305550177', 'can you send the rent roll?');
  await replyTick();
  assert.match(toBuyer('+15305550177').at(-1).text, /under contract, but I have other listings/);
  await sms('+15305550177', 'looking for 50+ spaces in NorCal under $3M');
  await replyTick();
  assert.ok(ownerLog.some((t) => /^MATCH .*Al Buyer.*Walnut Estates \(under contract\)\. Looking for: looking for 50\+ spaces/.test(t)));
});

test('document tools refuse an under-contract listing even with a verified CA', async () => {
  const { makeExecutors } = await import('../src/agent/tools.js');
  const walnut = (await db.listListings()).find((l) => l.name.startsWith('Walnut'));
  const ex = makeExecutors({ lead: { ca_verified: true }, listing: walnut, flags: { links: [], needsAttachment: [] } });
  for (const k of ['search_documents', 'rent_roll_stats', 'financial_summary', 'list_documents', 'get_document_link', 'prior_conversations']) assert.equal((await ex[k]({ query: 'x', document_id: 1, topic: 'x' })).unavailable, true, k);
});

test('seller names never reach a buyer: public listing names from Pierce\'s real HubSpot deal names', () => {
  const cases = {
    'Boon Chan - Hacienda Mobile Park': 'Hacienda Mobile Park',
    'Arlington Heights MHP - Logan Taylor': 'Arlington Heights MHP',
    'Casey Schroader - Smith River RV Park': 'Smith River RV Park',
    'George Bean - Star Mobile Estates': 'Star Mobile Estates',
    'Duane Brazil - New Orchard Estates': 'New Orchard Estates',
    'Mary & Louis Navarro | Pinederosa Park, Hezphibah GA': 'Pinederosa Park, Hezphibah GA',
    'Mountain View MHC (Relisting)': 'Mountain View MHC',
    'Walnut Estates - Kelseyville, CA': 'Walnut Estates - Kelseyville, CA',
    'Lighthouse Resort': 'Lighthouse Resort',
    'Arden - Asheville MHP Portfolio​ (Mills Gap & Casteel Park)': 'Arden - Asheville MHP Portfolio (Mills Gap & Casteel Park)',
    'Tierra Buena MHP - Yuba City, CA': 'Tierra Buena MHP - Yuba City, CA',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(publicListingName(raw), want, raw);
});

test('lead with no property name on a seller-named deal: text uses the public name', async () => {
  const hacienda = (await db.listListings()).find((l) => l.name.includes('Hacienda'));
  const t = firstTouchText({ first_name: 'Kim', source: 'listing_email', phone: '+1', platform: 'loopnet' }, hacienda, { channel: 'sms' });
  assert.match(t, /Saw your inquiry on Hacienda Mobile Park on LoopNet\./);
  assert.ok(!/Boon|Chan/.test(t));
});

test('listing status: HubSpot stage when listing_status is blank, most restrictive source wins', () => {
  const st = config.hubspot.sellerStages;
  assert.equal(listingStatusFor({ dealstage: st.listed }), 'active');
  assert.equal(listingStatusFor({ dealstage: st.underContract }), 'in_escrow');
  assert.equal(listingStatusFor({ dealstage: st.closedWon }), 'closed');
  assert.equal(listingStatusFor({ dealstage: '1730621130' }), null); // BOV is not a listing
  assert.equal(listingStatusFor({ dealstage: st.listed, listing_status: 'sold' }), 'closed');
  assert.equal(mostRestrictive('active', 'in_escrow'), 'in_escrow');
  assert.equal(mostRestrictive('closed', 'active', null), 'closed');
  assert.equal(mostRestrictive(null, undefined), 'active');
});

test('Dropbox: 02 - Under Contract folder marks the listing under contract; a 01 - Listed folder HubSpot lacks becomes a listing', async () => {
  const LISTED = '/Brokerage/01 - Brokerage/Deals/01 - Listed';
  const UC = '/Brokerage/01 - Brokerage/Deals/02 - Under Contract';
  mockFs.files = [
    { id: 'f1', path_display: `${UC}/Lighthouse Resort - Isleton, CA/00 - OM/OM.pdf`, content_hash: 'a', buffer: Buffer.from('OM') },
    { id: 'f2', path_display: `${LISTED}/DCAR - Dry Creek Almond Ranch - Snelling, CA/Flyer.pdf`, content_hash: 'b', buffer: Buffer.from('Flyer: almond ranch') },
  ];
  const r = await syncDropbox();
  const ls = await db.listListings();
  assert.equal(ls.find((l) => l.name === 'Lighthouse Resort').status, 'in_escrow');
  const dcar = ls.find((l) => /Dry Creek/.test(l.name));
  assert.ok(dcar, JSON.stringify(r));
  assert.equal(dcar.status, 'active');
  assert.equal(dcar.city, 'Snelling, CA');
  assert.deepEqual(r.created_from_dropbox, ['DCAR - Dry Creek Almond Ranch - Snelling, CA']);
});

test('"is this a bot?" never gets an automatic answer: it goes to Pierce', async () => {
  assert.ok(asksIfBot('is this a bot?'));
  assert.ok(asksIfBot('Am I talking to a real person'));
  assert.ok(asksIfBot('are you AI'));
  assert.ok(!asksIfBot('how many RV sites are there'));
  assert.ok(needsHuman('are you a real person?'));
  await ingestEmail(lead());
  const before = toBuyer('+15305550101').length;
  await sms('+15305550101', 'is this a bot?');
  await replyTick();
  assert.equal(toBuyer('+15305550101').length, before, 'no reply sent');
  assert.ok(ownerLog.some((t) => /ESCALATED .*Jane Buyer/.test(t)));
});

test('LoopNet "saved your listing": email goes out, the text waits for Pierce\'s Y', async () => {
  const r = await ingestEmail({ From: 'notifications@loopnet.com', Subject: 'Someone favorited your listing', TextBody: 'Pat Investor added your listing to their favorites.\nName: Pat Investor\nEmail: pat@example.com\nPhone: 916-555-0142\nListing: Lighthouse Resort' });
  assert.equal(r.lead.source, 'favorite');
  assert.match(mockMailbox.at(-1).text, /^Hi Pat,\n\nSaw you saved Lighthouse Resort on LoopNet, so I wanted to send over the details\./);
  assert.equal(toBuyer('+19165550142').length, 0);
  const a = (await db.listPendingApprovals()).find((x) => x.policy === 'first_touch.favorite');
  assert.ok(a);
  assert.match(a.draft, /^Hey Pat, this is Pierce over at CRI Brokerage! Saw you saved Lighthouse Resort on LoopNet and sent you an email/);
  await sms(PIERCE, `Y${a.id}`);
  assert.equal(toBuyer('+19165550142').length, 1);
});

test('human pacing: Pierce\'s A# answer waits a random beat; two texts are never seconds apart', async () => {
  Object.assign(config, { pace: { minSec: 40, maxSec: 180 }, minGapSec: 45 });
  await ingestEmail({ ...lead(), TextBody: lead().TextBody.replace('Email: jane@example.com\n', '') }); // text-only lead
  await sms('+15305550101', 'what is the water source?');
  await replyTick();
  const q = (await db.listOpenOwnerQuestions((await db.findLeadByPhone('+15305550101')).id))[0];
  assert.ok(q, 'question went to Pierce');
  // the holding reply came right after the first text, so it was held back, not fired seconds later
  assert.equal(toBuyer('+15305550101').length, 1);
  setNow(at(44)); await replyTick();
  assert.equal(toBuyer('+15305550101').length, 1, 'holding reply not within 45s of the last text');
  setNow(at(200)); await replyTick();
  assert.match(toBuyer('+15305550101').at(-1).text, /Great question, I'll get back to you on that/);
  const n = toBuyer('+15305550101').length;
  setNow(at(600));
  await sms(PIERCE, `A${q.id} Private well, permitted.`);
  assert.equal(toBuyer('+15305550101').length, n, 'not instant');
  setNow(at(600 + 39)); await replyTick();
  assert.equal(toBuyer('+15305550101').length, n, 'not before 40s');
  setNow(at(600 + 181)); await replyTick();
  assert.equal(toBuyer('+15305550101').length, n + 1, 'out by 3 min');
  assert.match(toBuyer('+15305550101').at(-1).text, /Private well/);
});

test('lead emails are read straight from the inbox: platform senders only, each once', async () => {
  const { mockInbox } = await import('../src/email.js');
  const { inboxTick } = await import('../src/jobs.js');
  const { isPlatformSender } = await import('../src/intake/mailbox.js');
  assert.ok(isPlatformSender('notifications@crexi.com'));
  assert.ok(isPlatformSender('leads@mail.loopnet.com'));
  assert.ok(!isPlatformSender('buyer@gmail.com'));
  assert.ok(!isPlatformSender('crexi.com@evil.example'));
  mockInbox.length = 0;
  mockInbox.push(
    { id: 'old', receivedDateTime: at(-7200), from: { emailAddress: { address: 'notifications@crexi.com' } }, subject: 'New lead', body: { contentType: 'text', content: 'Name: Old Lead\nPhone: 530-555-0999\nProperty: Lighthouse Resort' } },
    { id: 'm1', receivedDateTime: at(-60), from: { emailAddress: { address: 'notifications@crexi.com' } }, subject: 'New lead', body: { contentType: 'html', content: '<p>Name: Ray Buyer<br>Phone: 530-555-0123<br>Property: Lighthouse Resort<br>Message: still available?</p>' } },
    { id: 'm2', receivedDateTime: at(-30), from: { emailAddress: { address: 'someone@gmail.com' } }, subject: 'Re: Crexi lead on Lighthouse', body: { contentType: 'text', content: 'Name: Not A Lead\nPhone: 530-555-0456\nProperty: Lighthouse Resort' } },
  );
  const r = await inboxTick();
  assert.deepEqual(r, { seen: 2, leads: 1, replies: 0, ignored: 1 }); // the 2-hour-old one is before the 1-hour lookback; gmail sender isn't a lead on file
  assert.ok(await db.findLeadByPhone('+15305550123'));
  assert.equal(await db.findLeadByPhone('+15305550456'), null);
  assert.equal(await db.findLeadByPhone('+15305550999'), null);
  const again = await inboxTick();
  assert.equal(again.leads, 0, 'never processed twice');
});

test('self-test reports every connection without sending anything (mock modes)', async () => {
  const { selftest } = await import('../src/selftest.js');
  const before = mockOutbox.length + mockMailbox.length;
  const r = await selftest();
  assert.equal(r.checks.database.ok, true);
  assert.deepEqual(r.checks.database.listings, { active: 2, in_escrow: 1 });
  assert.equal(r.checks.ringcentral.mode, 'mock');
  assert.equal(r.checks.hubspot.ok, false); // no token in tests: reported, not thrown
  assert.ok('test_mode' in r.autonomy);
  assert.equal(mockOutbox.length + mockMailbox.length, before, 'sends nothing');
});

test('policies.json: test_mode is off (Pierce, Nov 1 2026) but Level 3 items still need his Y', async () => {
  const { readFileSync } = await import('node:fs');
  const p = JSON.parse(readFileSync(new URL('../playbook/policies.json', import.meta.url), 'utf8'));
  assert.equal(p.test_mode, false);
  for (const k of ['escalate.price_terms_legal', 'escalate.frustrated_or_sensitive', 'reply.sensitive_docs', 'first_touch.csv', 'first_touch.favorite']) assert.equal(p.policies[k].mode, 'approve', k);
});
