// Nov 2 2026 audit fixes: forged webhooks, broker-internal and PII files in the document mirror, and a half-entered
// Microsoft key that must not stop the bot from booting.
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock', EMAIL_MODE: '',
  INGEST_SECRET: 'test-secret', OWNER_PHONE: '+19495550000', PUBLIC_URL: 'https://bot.example', HUBSPOT_TOKEN: '',
  MS_TENANT_ID: 'tenant', MS_CLIENT_ID: 'client', MS_CLIENT_SECRET: '',
});

const { config, validateConfig, configWarnings } = await import('../src/config.js');
const { webhookAuthorized, webhookAddress, webhookKey } = await import('../src/ringcentral.js');
const { classifyFile, blocksDataRoom } = await import('../src/docs/classify.js');
const { mailCheck } = await import('../src/email.js');

const req = (query = {}, headers = {}) => ({ query, get: (h) => headers[h] });

test('webhook: a POST without the secret key is refused, so nobody can text commands "as Pierce"', () => {
  assert.equal(webhookAuthorized(req()), false);
  assert.equal(webhookAuthorized(req({ k: 'wrong'.padEnd(32, 'x') })), false);
  assert.equal(webhookAuthorized(req({ k: webhookKey() })), true);
  assert.match(webhookAddress(), /^https:\/\/bot\.example\/webhooks\/ringcentral\?k=[0-9a-f]{32}$/);
  assert.ok(!webhookAddress().includes('test-secret'), 'the INGEST_SECRET itself never appears in the URL');
  config.rc.verificationToken = 'tok';
  try {
    assert.equal(webhookAuthorized(req({ k: webhookKey() })), false, 'header required when RC_VERIFICATION_TOKEN is set');
    assert.equal(webhookAuthorized(req({ k: webhookKey() }, { 'Verification-Token': 'tok' })), true);
  } finally { config.rc.verificationToken = ''; }
});

test('a half-entered Microsoft key leaves email OFF with a warning instead of stopping the whole bot', async () => {
  assert.equal(config.email.mode, 'off');
  assert.ok(!validateConfig().some((m) => /^MS_/.test(m)), 'boot is not blocked');
  assert.match(configWarnings().join(' '), /email is OFF: MS_CLIENT_SECRET not set/);
  const m = await mailCheck();
  assert.equal(m.ok, false, 'the self-test shows email off as a problem, not green');
});

test('document rules: broker-internal, lead lists, a buyer\'s proof of funds, financing and tenant-named files are never loaded', () => {
  const ex = [
    '01 - BROKER INTERNAL/Lighthouse - Data Room Index & DD Status - CRI INTERNAL.pdf',
    '01 - BROKER INTERNAL/07 - Seller Documents (Raw Import - Marco, Sept 2026)/Extended Stay Contracts/D06.pdf',
    '01 - BROKER INTERNAL/RingIO_Lighthouse_Leads.csv',
    '05 - Correspondence/Hidden Harbor - Buyer POF (Wes Johnson, Finger Lakes) - 2026-10-19.pdf',
    '03 - Due Diligence/09 - Lender & Financing/Success Capital - SBA 504 Loan Proposal Summary.pdf',
    '03 - Due Diligence/08 - Seller Questionnaire & Answers/Seller Call Sheet - Questions.md',
    '02 - DD Folder/09 - Insurance/GL/2025-06-27 – Insurance Correspondence – James River.pdf',
    '02 - DD Folder/02 - Rent Roll & Occupancy/Membership Roster/2026-08 – Membership Roster – Active Members (Type, Dues, Frequency).pdf',
    '02 - DD Folder/03 - Leases/Extended Stay Agreements (Executed)/Row D/Extended Stay Agreement – Site D06.pdf',
    '07 - Underwriting & Marketing/Outreach/2808 Patterson - Skip Trace Request.xlsx',
    '07 - Underwriting & Marketing/Valuation/BOV.xlsx',
    'UW/NorCal MHP Portfolio – Underwriting Package – 2026.xlsx',
  ];
  for (const p of ex) assert.equal(classifyFile(p).tier, 'exclude', p);
  for (const p of ex.slice(0, 7)) assert.ok(blocksDataRoom(p), `data room blocked by ${p}`);
  const keep = {
    '07 - Underwriting & Marketing/OM/2808 Patterson Rd - Offering Memorandum.pdf': 'ca',
    '02 - DD Folder/02 - Rent Roll & Occupancy/2026-08 – Membership Roster – Active Members REDACTED – Lighthouse.pdf': 'ca',
    '02 - DD Folder/04 - Rules, Permits & Licenses/Short-Term Cabin Agreement/Form Agreement – Short-Term Cabin Rental Agreement (Blank Template).pdf': 'ca',
    '02 - DD Folder/01 - Financials/2025/2025 Profit and Loss YTD.pdf': 'ca',
    '08 - Seller QA/Seller QA email thread.pdf': 'sensitive',
  };
  for (const [p, tier] of Object.entries(keep)) assert.equal(classifyFile(p).tier, tier, p);
});

test('email history: past threads are matched to listings without Graph $search (403 under RBAC)', async () => {
  const { matchMessagesToListings } = await import('../src/docs/history.js');
  const listings = [
    { id: 3, name: 'Lighthouse Resort', aliases: [] },
    { id: 16, name: 'Boon Chan - Hacienda Mobile Park', aliases: ['Mobile Hacienda Park'] },
    { id: 9, name: 'NorCal Portfolio', aliases: [] },
  ];
  const msgs = [
    { id: 'a', conversationId: 'c1', subject: 'RE: Lighthouse Resort - rent roll', body: { content: 'see attached' } },
    { id: 'b', conversationId: 'c2', subject: 'Question', body: { content: 'Is Mobile Hacienda Park still available?' } },
    { id: 'c', conversationId: 'c3', subject: 'Lunch?', body: { content: 'lighthouses are cool; resort weekend' } },
    { id: 'd', conversationId: 'c4', subject: 'Hacienda Mobile Park numbers', body: { content: '' } },
  ];
  const m = matchMessagesToListings(msgs, listings);
  assert.deepEqual((m.get(3) || []).map((x) => x.id), ['a']);
  assert.deepEqual((m.get(16) || []).map((x) => x.id).sort(), ['b', 'd'], 'alias and seller-stripped deal name both match');
  assert.equal(m.get(9), undefined);
});

test('inbox poller: a denied read is logged and texted to Pierce once, never swallowed', async () => {
  const { pollInboxForLeads } = await import('../src/intake/mailbox.js');
  const email = await import('../src/email.js');
  const { ownerLog } = await import('../src/notify.js');
  const prev = { mode: config.email.mode, read: config.email.readMailboxes };
  Object.assign(config.email, { mode: 'mock', readMailboxes: ['someone-else@example.com'] }); // not allowlisted -> refused like a 403
  ownerLog.length = 0;
  try {
    const a = await pollInboxForLeads();
    const b = await pollInboxForLeads();
    assert.ok(a.errors?.length && b.errors?.length);
    assert.equal(ownerLog.filter((t) => /Lead emails are NOT being read/.test(t)).length, 1, 'one text, not one per minute');
  } finally { Object.assign(config.email, { mode: prev.mode, readMailboxes: prev.read }); }
  void email;
});
