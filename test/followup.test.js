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
const hs = { deals: {}, notes: [], tasks: [], searches: [], c: 0 };
globalThis.fetch = async (url, o = {}) => {
  const u = new URL(url); const b = o.body ? JSON.parse(o.body) : null; const m = o.method;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.pathname.endsWith('/search')) { hs.searches.push({ path: u.pathname, body: b }); return ok({ results: [], total: 0 }); }
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
  Object.assign(hs, { deals: {}, notes: [], tasks: [], searches: [], c: 0 });
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

test('Pierce, Nov 2: only his two mailboxes, never Dylan\'s or anyone else\'s; nothing is ever deleted', async () => {
  const { assertGraphAllowed } = await import('../src/email.js');
  const { assertHubspotAllowed } = await import('../src/hubspot.js');
  const { assertDropboxAllowed } = await import('../src/dropbox.js');
  assert.doesNotThrow(() => assertGraphAllowed('GET', '/users/pbrazil%40cribrokerage.com/mailFolders/inbox/messages'));
  assert.doesNotThrow(() => assertGraphAllowed('POST', '/users/pbrazil@cricommercial.com/sendMail'));
  for (const other of ['dylanb@cricommercial.com', 'duane@cricommercial.com', 'anyone@cribrokerage.com']) assert.throws(() => assertGraphAllowed('GET', `/users/${encodeURIComponent(other)}/messages`), /not one of Pierce's/, other);
  assert.throws(() => assertGraphAllowed('DELETE', '/users/pbrazil@cribrokerage.com/messages/abc'), /never deletes/);
  assert.throws(() => assertGraphAllowed('POST', '/users/pbrazil@cribrokerage.com/messages/abc/move'), /never deletes or moves/);
  assert.throws(() => assertGraphAllowed('POST', '/users/pbrazil@cribrokerage.com/messages/abc/permanentDelete'), /never deletes/);
  assert.throws(() => assertHubspotAllowed('DELETE', '/crm/v3/objects/contacts/1'), /never deletes/);
  assert.throws(() => assertHubspotAllowed('POST', '/crm/v3/objects/contacts/merge'), /never deletes/);
  assert.doesNotThrow(() => assertHubspotAllowed('PATCH', '/crm/v3/objects/deals/1'));
  for (const ep of ['files/delete_v2', 'files/permanently_delete', 'files/move_v2', 'sharing/revoke_shared_link']) assert.throws(() => assertDropboxAllowed(ep), /never deletes/, ep);
  assert.doesNotThrow(() => assertDropboxAllowed('sharing/create_shared_link_with_settings'));
  assert.deepEqual(config.email.readMailboxes, ['pbrazil@cribrokerage.com'], 'one inbox, two addresses: read once');
  assert.deepEqual(config.email.leadCc, ['DylanB@cricommercial.com'], 'Dylan cc\'d on lead emails only (Pierce, Nov 2 2026); never read');
});

test('Dylan\'s listing leads: a forwarded platform email from Dylan becomes a lead; other mail from him does not', async () => {
  mockInbox.push(
    { id: 'fw1', receivedDateTime: day(0, -0.1), from: { emailAddress: { address: 'DylanB@cricommercial.com' } }, subject: 'FW: New lead on Smith River RV Park', body: { contentType: 'text', content: '---------- Forwarded message ---------\nFrom: Crexi <notifications@crexi.com>\nName: Sam Buyer\nPhone: 540-555-0111\nProperty: Smith River RV Park\nMessage: still available?' } },
    { id: 'dy2', receivedDateTime: day(0, -0.05), from: { emailAddress: { address: 'DylanB@cricommercial.com' } }, subject: 'lunch? also saw a crexi listing', body: { contentType: 'text', content: 'Name: Not Lead\nPhone: 540-555-0999' } },
  );
  const r = await inboxTick();
  assert.equal(r.leads, 1);
  assert.ok(await db.findLeadByPhone('+15405550111'));
  assert.equal(await db.findLeadByPhone('+15405550999'), null);
});

test('only Pierce\'s and Dylan\'s listings come in from HubSpot; a lead matching none of them waits for Pierce', async () => {
  const { listingStatusFor } = await import('../src/hubspot.js');
  assert.deepEqual(config.hubspot.listingOwners, ['2145826500', '683980338']);
  assert.equal(listingStatusFor({ dealstage: config.hubspot.sellerStages.listed }), 'active');
  await ingestEmail({ From: 'notifications@crexi.com', Subject: 'New lead', TextBody: 'Name: Gail Buyer\nPhone: 706-555-0100\nProperty: Pinederosa Park\nMessage: info?' }); // Nolan's listing
  assert.equal(mockOutbox.filter((m) => m.to === '+17065550100').length, 0, 'not contacted automatically');
  const a = (await db.listPendingApprovals()).find((x) => x.policy === 'first_touch.unmatched');
  assert.ok(a, 'Pierce decides');
});

test('HubSpot listing import asks only for Pierce\'s and Dylan\'s deals', async () => {
  const { syncListingsFromHubSpot } = await import('../src/hubspot.js');
  await syncListingsFromHubSpot();
  const q = hs.searches.find((x) => x.path === '/crm/v3/objects/deals/search' && x.body.properties?.includes('hubspot_owner_id'));
  assert.ok(q, 'listing search sent');
  for (const g of q.body.filterGroups) {
    const f = g.filters.find((x) => x.propertyName === 'hubspot_owner_id');
    assert.deepEqual(f, { propertyName: 'hubspot_owner_id', operator: 'IN', values: ['2145826500', '683980338'] });
  }
});

test('Pierce and Dylan both get the lead email: if Dylan also forwards it, the buyer is contacted once', async () => {
  const body = 'Name: Kim Buyer\nEmail: kim@example.com\nPhone: 540-555-0122\nProperty: Lighthouse Resort\nMessage: info please';
  mockInbox.push(
    { id: 'orig', receivedDateTime: day(0, -0.2), from: { emailAddress: { address: 'notifications@crexi.com' } }, subject: 'New lead', body: { contentType: 'text', content: body } },
    { id: 'fwd', receivedDateTime: day(0, -0.1), from: { emailAddress: { address: 'dylanb@cricommercial.com' } }, subject: 'Fwd: New lead', body: { contentType: 'text', content: `From: Crexi <notifications@crexi.com>\n${body}` } },
  );
  await inboxTick();
  assert.equal(mockOutbox.filter((m) => m.to === '+15405550122').length, 1, 'one first text');
  assert.equal(mockMailbox.filter((m) => m.to === 'kim@example.com').length, 1, 'one first email');
  assert.deepEqual(mockMailbox.at(-1).cc, ['DylanB@cricommercial.com'], 'Dylan cc\'d on the lead email');
});

test('no code path calls Graph outside the mailbox guard', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = ['src/email.js', 'src/docs/history.js', 'src/selftest.js', 'src/intake/mailbox.js'];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const raw = [...src.matchAll(/graph\.microsoft\.com\/v1\.0\/users/g)].length;
    const guarded = f === 'src/email.js' ? 0 : [...src.matchAll(/assertGraphAllowed\(/g)].length;
    assert.ok(raw <= guarded, `${f}: ${raw} raw Graph user URLs, ${guarded} guarded`);
  }
  assert.ok(readdirSync(new URL('../src', import.meta.url)).length > 0);
});

test('Render deploy overlap: only the instance holding the lease runs the loops; it hands over on shutdown', async () => {
  assert.equal(await db.claimLease('old', 60), true);
  assert.equal(await db.claimLease('new', 60), false, 'new instance waits while the old one holds it');
  assert.equal(await db.claimLease('old', 60), true, 'holder renews');
  await db.releaseLease('old'); // SIGTERM on the old instance
  assert.equal(await db.claimLease('new', 60), true, 'new instance takes over at once');
  setNow(day(0, 1)); // a crashed holder's lease simply expires
  assert.equal(await db.claimLease('third', 60), true);
});

test('Supabase client is created lazily: importing without keys does not crash, the config check reports them', async () => {
  const mod = await import('../src/db/supabase.js');
  assert.ok(mod.db.getSetting, 'imports cleanly without SUPABASE_* set');
  await assert.rejects(() => mod.db.getSetting('x'), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
});

test('HubSpot 403 (service key missing a scope): Pierce is told once per object, leads keep flowing', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => (new URL(url).pathname === '/crm/v3/objects/notes'
    ? { ok: false, status: 403, json: async () => ({}), text: async () => 'MISSING_SCOPES' } : realFetch(url, o));
  try {
    await ingestEmail(crexi());
    await sms(BUYER, 'cash buyer');
    await replyTick();
    const alerts = ownerLog.filter((t) => /HubSpot refused the bot's notes request \(403\)/.test(t));
    assert.equal(alerts.length, 1, 'one alert, not one per note');
    assert.match(alerts[0], /crm\.objects\.notes\.write/);
    assert.ok(toBuyer().length >= 2, 'buyer still answered');
  } finally { globalThis.fetch = realFetch; }
});

test('Dropbox no-argument calls send the JSON body null (an empty body is rejected), and 5xx is retried once', async () => {
  const { dropboxCheck } = await import('../src/dropbox.js');
  const { config: cfg } = await import('../src/config.js');
  const realFetch = globalThis.fetch; const calls = [];
  let failedOnce = false;
  globalThis.fetch = async (url, o = {}) => {
    const u = new URL(url); calls.push({ path: u.pathname, body: o.body, ct: o.headers?.['Content-Type'] });
    const ok = (j) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.pathname === '/oauth2/token') return ok({ access_token: 't', expires_in: 14400 });
    if (u.pathname === '/2/users/get_current_account') {
      if (!failedOnce) { failedOnce = true; return { ok: false, status: 500, headers: { get: () => '0' }, text: async () => 'unexpected error occurred' }; }
      return ok({ email: 'pbrazil@cricommercial.com', root_info: { root_namespace_id: '12987598657' } });
    }
    if (u.pathname === '/2/files/list_folder') return ok({ entries: [{ '.tag': 'folder', name: 'Lighthouse Resort - Isleton, CA' }], has_more: false });
    return realFetch(url, o);
  };
  const saved = { ...cfg.dropbox };
  Object.assign(cfg.dropbox, { mode: 'live', appKey: 'k', appSecret: 's', refreshToken: 'r' });
  try {
    const r = await dropboxCheck('/Brokerage/01 - Brokerage/Deals/01 - Listed');
    assert.equal(r.ok, true, JSON.stringify(r));
    const acct = calls.filter((c) => c.path === '/2/users/get_current_account');
    assert.equal(acct.length >= 2, true, 'retried after the 500');
    for (const c of acct) { assert.equal(c.body, 'null'); assert.equal(c.ct, 'application/json'); }
    assert.equal(r.root_namespace, '12987598657');
  } finally { globalThis.fetch = realFetch; Object.assign(cfg.dropbox, saved); }
});

test('lead emails are read from every folder (Superhuman "Done" / Outlook rules can move them out of the Inbox)', async () => {
  const { listInboxSince } = await import('../src/email.js');
  const realFetch = globalThis.fetch; const urls = [];
  globalThis.fetch = async (url, o) => {
    const u = new URL(url); urls.push(u.pathname);
    if (u.hostname === 'login.microsoftonline.com') return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    if (u.hostname === 'graph.microsoft.com') return { ok: true, status: 200, json: async () => ({ value: [] }) };
    return realFetch(url, o);
  };
  const saved = { ...config.email };
  Object.assign(config.email, { mode: 'live', tenantId: 't', clientId: 'c', clientSecret: 's' });
  try {
    await listInboxSince('2026-11-02T00:00:00Z', 50, 'pbrazil@cribrokerage.com');
    assert.ok(urls.includes('/v1.0/users/pbrazil%40cribrokerage.com/messages'), urls.join(' '));
    assert.ok(!urls.some((p) => p.includes('/mailFolders/inbox/messages')));
  } finally { globalThis.fetch = realFetch; Object.assign(config.email, saved); }
});
