// Pierce, Nov 2 2026: "share view only links on data room for listings". A Dropbox folder link has no gate of its own,
// so the bot gives it only to CA-verified buyers of that listing, and stops using it if the folder picks up files
// buyers must never see (contracts, financing, insurance, seller emails, archive).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock',
  EMAIL_MODE: 'mock', EMAIL_SEND_MODE: 'send', INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: '',
  REPLY_DELAY_MAX_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0',
});

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox } = await import('../src/ringcentral.js');
const { mockFs } = await import('../src/dropbox.js');
const { ownerLog } = await import('../src/notify.js');
const { deliver } = await import('../src/agent/setter.js');
const { buildSystemPrompt } = await import('../src/agent/prompt.js');
const { syncDropbox } = await import('../src/docs/sync.js');
const { dataRoomProblem, dataRoomFor } = await import('../src/dataroom.js');
const { config } = await import('../src/config.js');

const LISTED = '/Brokerage/01 - Brokerage/Deals/01 - Listed';
const FOLDER = `${LISTED}/Mobile Hacienda Park - Fontana`;
const ROOM = `${FOLDER}/03 - Due Diligence`;
const ROOM_URL = 'https://www.dropbox.com/scl/fo/abc123/xyz789?rlkey=k1&dl=0';
const OTHER_URL = 'https://www.dropbox.com/scl/fo/zzz999/qqq111?rlkey=k2&dl=0';
const BUYER = '+15305550101';
let hacienda; let other;

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; ownerLog.length = 0; mockFs.files = []; mockFs.links = {};
  setNow('2026-11-03T18:00:00Z'); // Tue 10:00 PST, inside the send window
  Object.assign(config, { minGapSec: 0, pace: { minSec: 0, maxSec: 0 } });
  hacienda = await db.upsertListing({ hubspot_deal_id: 'h16', name: 'Boon Chan - Hacienda Mobile Park', ca_link: 'https://example.com/ca', dropbox_path: FOLDER,
    facts: { data_room_url: ROOM_URL, data_room_path: ROOM } });
  other = await db.upsertListing({ hubspot_deal_id: 'h3', name: 'Lighthouse Resort', facts: { data_room_url: OTHER_URL, data_room_path: `${LISTED}/Lighthouse Resort - Isleton, CA/DD` } });
});

const buyer = (over = {}) => db.insertLead({ phone: BUYER, first_name: 'Jane', source: 'listing_email', status: 'engaged', listing_id: hacienda.id, property_name: 'Mobile Hacienda Park', ...over });
const sentToBuyer = () => mockOutbox.filter((m) => m.to === BUYER);

test('prompt: the data room link is shown only to a CA-verified buyer; its folder path never', () => {
  const pre = buildSystemPrompt({ lead: { status: 'engaged', ca_verified: false }, listing: hacienda, mode: 'reply' });
  assert.ok(!pre.includes('dropbox.com/scl/fo'), 'no link before the CA');
  assert.match(pre, /data_room: available once the CA is signed/);
  const post = buildSystemPrompt({ lead: { status: 'engaged', ca_verified: true }, listing: hacienda, mode: 'reply' });
  assert.ok(post.includes(ROOM_URL), 'verified buyer gets the link');
  for (const p of [pre, post]) assert.ok(!p.includes('03 - Due Diligence') && !p.includes('data_room_path'), 'folder path stays internal');
});

test('deliver: a data room link to a buyer without a verified CA waits for Pierce, and nothing goes out', async () => {
  const lead = await buyer({ ca_verified: false });
  const r = await deliver(lead, `Here's the data room: ${ROOM_URL}`, { kind: 'reply' });
  assert.ok(r.approval, JSON.stringify(r));
  assert.match(r.approval.reason, /CA is not verified/);
  assert.equal(sentToBuyer().length, 0);
});

test('deliver: CA-verified buyer gets their listing\'s data room; another listing\'s folder or a blocked room waits', async () => {
  const lead = await buyer({ ca_verified: true });
  const ok = await deliver(lead, `Here's the data room for Mobile Hacienda: ${ROOM_URL}.`, { kind: 'reply' });
  assert.ok(!ok.approval, JSON.stringify(ok));
  assert.equal(sentToBuyer().length, 1);
  const wrong = await deliver(lead, `Also see ${OTHER_URL}`, { kind: 'reply' });
  assert.match(wrong.approval?.reason || '', /not this listing's data room/);
  await db.updateListing(hacienda.id, { facts: { ...hacienda.facts, data_room_blocked: ['03 - Due Diligence/Insurance Policy.pdf'] } });
  const blocked = await deliver(lead, `Data room: ${ROOM_URL}`, { kind: 'reply' });
  assert.match(blocked.approval?.reason || '', /no cleared data room/);
  assert.equal(sentToBuyer().length, 1, 'only the first one went out');
});

test('dataRoomProblem: ignores per-file links and plain text; legacy /sh/ folder links count', () => {
  const lead = { ca_verified: false };
  assert.equal(dataRoomProblem('Here is the flyer: https://www.dropbox.com/scl/fi/f1/Flyer.pdf?rlkey=a', lead, hacienda), null);
  assert.equal(dataRoomProblem('Happy to send the data room once the CA is in.', lead, hacienda), null);
  assert.ok(dataRoomProblem('https://www.dropbox.com/sh/abc/def?dl=0', lead, hacienda));
});

test('doc sync: an insurance file or seller emails in the data room block its link and text Pierce once; clearing it un-blocks', async () => {
  const f = (id, rel) => ({ id, path_display: `${FOLDER}/${rel}`, content_hash: id, buffer: Buffer.from(`file ${rel}`) });
  const clean = [f('a', '03 - Due Diligence/Rent Roll.csv'), f('b', '03 - Due Diligence/Site Map.pdf'), f('c', '14 - Financing/Loan Docs.pdf')];
  mockFs.files = clean;
  await syncDropbox();
  assert.equal(dataRoomFor(await db.getListing(hacienda.id)), ROOM_URL, 'financing OUTSIDE the data room does not block it');
  assert.equal(ownerLog.filter((t) => /Data room/.test(t)).length, 0);

  mockFs.files = [...clean, f('d', '03 - Due Diligence/Insurance Policy 2026.pdf'), f('e', '03 - Due Diligence/Seller QA/email thread.pdf')];
  await syncDropbox();
  const blocked = await db.getListing(hacienda.id);
  assert.deepEqual(blocked.facts.data_room_blocked, ['03 - Due Diligence/Insurance Policy 2026.pdf', '03 - Due Diligence/Seller QA/email thread.pdf']);
  assert.equal(dataRoomFor(blocked), null);
  assert.equal(blocked.facts.data_room_url, ROOM_URL, 'the link itself is kept');
  await syncDropbox();
  assert.equal(ownerLog.filter((t) => /now has files buyers shouldn't see/.test(t)).length, 1, 'one text, not one per sync');

  mockFs.files = clean;
  await syncDropbox();
  assert.equal(dataRoomFor(await db.getListing(hacienda.id)), ROOM_URL);
  assert.ok(ownerLog.some((t) => /Data room for .+ is clear again/.test(t)), ownerLog.join('\n'));
});

test('rate limit (Pierce, Nov 2): a buyer who keeps writing keeps getting answers; unanswered messages are capped; a held reply goes to Pierce', async () => {
  const lead = await buyer({ ca_verified: false });
  const at = (min) => new Date(+new Date('2026-11-03T18:00:00Z') + min * 60e3).toISOString();
  // 8 back-and-forths in one day: every reply goes out
  for (let i = 0; i < 8; i++) {
    setNow(at(i * 10));
    await db.updateLead(lead.id, { last_inbound_at: at(i * 10) });
    const r = await deliver(await db.getLead(lead.id), `Answer ${i}`, { kind: 'reply' });
    assert.ok(r.sent || r.id || !r.approval, `reply ${i}: ${JSON.stringify(r)}`);
  }
  assert.equal(sentToBuyer().length, 8);
  // buyer goes quiet: after 3 unanswered, a follow-up is skipped and a reply becomes a draft for Pierce
  setNow(at(100)); await deliver(await db.getLead(lead.id), 'Extra 1', { kind: 'reply' });
  setNow(at(110)); await deliver(await db.getLead(lead.id), 'Extra 2', { kind: 'reply' });
  setNow(at(120));
  const f = await deliver(await db.getLead(lead.id), 'Checking in', { kind: 'followup' });
  assert.equal(f.skipped, 'rate_limit');
  const held = await deliver(await db.getLead(lead.id), 'One more', { kind: 'reply' });
  assert.match(held.approval?.reason || '', /rate limit/);
  assert.equal(sentToBuyer().length, 10);
});

test('intro email: Crexi DD vault link goes in (Crexi gates it with the CA); a Dropbox folder link never does', async () => {
  const { sendIntroEmail } = await import('../src/agent/setter.js');
  const { mockMailbox } = await import('../src/email.js');
  mockMailbox.length = 0;
  await db.updateListing(hacienda.id, { crexi_url: 'https://www.crexi.com/properties/1/x', facts: { ...hacienda.facts, dd_vault_url: 'https://www.crexi.com/properties/1/x?openDueDiligence=open' } });
  const lead = await buyer({ email: 'jane@example.com' });
  await sendIntroEmail(lead, await db.getListing(hacienda.id));
  const m = mockMailbox.at(-1);
  assert.ok(m, 'intro email went out');
  assert.match(m.text, /Due diligence vault: https:\/\/www\.crexi\.com\/properties\/1\/x\?openDueDiligence=open/);
  assert.ok(!m.text.includes('dropbox.com/scl/fo'), 'the Dropbox data room link is never in the first email');
  // a non-Crexi dd_vault_url (e.g. someone pastes a Dropbox folder there) is ignored
  await db.updateListing(hacienda.id, { facts: { ...hacienda.facts, dd_vault_url: ROOM_URL } });
  await sendIntroEmail(await db.getLead(lead.id), await db.getListing(hacienda.id));
  assert.ok(!mockMailbox.at(-1).text.includes('Due diligence vault'));
});
