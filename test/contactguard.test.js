// Contact awareness (Pierce, Nov 2 2026): "don't text people in communication like Matthew, he booked a call, got to be
// smarter, Jacob is in HubSpot as seller." Before the bot sends anything it wrote itself, it checks HubSpot (seller,
// meeting, last contacted, deal past Offer Out) and RingCentral (Pierce texting them himself). Fake HubSpot via fetch,
// fake RingCentral message store via mockRcMessageStore. No real services.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  NODE_ENV: 'test', POLICY_TEST_MODE: '0', DB_MODE: 'memory', SMS_MODE: 'mock', LLM_MODE: 'mock', DROPBOX_MODE: 'mock',
  EMAIL_MODE: 'mock', EMAIL_SEND_MODE: 'send', INGEST_SECRET: 'test', OWNER_PHONE: '+19495550000', HUBSPOT_TOKEN: 'fake', HUBSPOT_OWNER_ID: '2145826500',
  REPLY_DELAY_MAX_SEC: '0', FIRST_TOUCH_DELAY_MAX_SEC: '0', TEXT_AFTER_EMAIL_MAX_SEC: '0', PACE_MAX_SEC: '0', MIN_GAP_SEC: '0',
});

const SELLERS = '1100540605';
const BUYERS = '1100542670';
// ---- fake HubSpot: contacts searchable like HubSpot (phone tokens, CONTAINS_TOKEN "*digits", email EQ), deals with
// contact associations, every write recorded. fail: every request answers 503.
const hs = { contacts: {}, deals: {}, tasks: {}, writes: [], notes: [], fail: null, c: 0, d: 0 };
const tokens = (v) => String(v || '').toLowerCase().split(/[\s()\-.,+/]+/).filter(Boolean);
const groupMatches = (props, filters) => filters.every((f) => {
  const v = props[f.propertyName];
  if (f.operator === 'EQ') return String(v || '').toLowerCase() === String(f.value).toLowerCase();
  if (f.operator === 'CONTAINS_TOKEN') { const want = String(f.value).replace(/^\*/, ''); return tokens(v).some((t) => t.endsWith(want)); }
  return false;
});
globalThis.fetch = async (url, o = {}) => {
  const u = new URL(url); const b = o.body ? JSON.parse(o.body) : null; const m = o.method;
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (hs.fail) return { ok: false, status: 503, json: async () => ({}), text: async () => hs.fail };
  if (m !== 'GET' && !u.pathname.endsWith('/search')) hs.writes.push({ m, path: u.pathname, body: b });
  if (u.pathname === '/crm/v3/objects/contacts/search') {
    const results = Object.entries(hs.contacts).filter(([, c]) => b.filterGroups.some((g) => groupMatches(c, g.filters))).map(([id, c]) => ({ id, properties: { ...c } }));
    return ok({ results, total: results.length });
  }
  if (u.pathname === '/crm/v3/objects/deals/search') {
    const f = Object.fromEntries(b.filterGroups[0].filters.map((x) => [x.propertyName, x.value]));
    const results = Object.entries(hs.deals).filter(([, d]) => (!f['associations.contact'] || d._contacts.includes(f['associations.contact']))
      && (!f.pipeline || d.pipeline === f.pipeline) && (!f.listing_code || d.listing_code === f.listing_code))
      .map(([id, { _contacts, ...p }]) => ({ id, properties: p }));
    return ok({ results, total: results.length });
  }
  if (u.pathname === '/crm/v3/objects/contacts' && m === 'POST') { const id = `c${++hs.c}`; hs.contacts[id] = { ...b.properties }; return ok({ id }); }
  const cm = u.pathname.match(/^\/crm\/v3\/objects\/contacts\/(\w[\w-]*)$/);
  if (cm && m === 'GET') return ok({ id: cm[1], properties: { ...(hs.contacts[cm[1]] || {}) } });
  if (cm && m === 'PATCH') { Object.assign(hs.contacts[cm[1]] ||= {}, b.properties); return ok({}); }
  if (u.pathname === '/crm/v3/objects/deals' && m === 'POST') {
    const id = `d${++hs.d}`; hs.deals[id] = { ...b.properties, _contacts: (b.associations || []).map((a) => a.to.id) }; return ok({ id });
  }
  const dm = u.pathname.match(/^\/crm\/v3\/objects\/deals\/(\w[\w-]*)$/);
  if (dm && m === 'GET') { const { _contacts, ...p } = hs.deals[dm[1]] || {}; return ok({ id: dm[1], properties: p }); }
  if (dm && m === 'PATCH') { Object.assign(hs.deals[dm[1]], b.properties); return ok({}); }
  if (u.pathname === '/crm/v3/objects/notes') { hs.notes.push({ body: b.properties.hs_note_body, to: b.associations.map((a) => a.to.id) }); return ok({ id: 'n' }); }
  if (u.pathname === '/crm/v3/objects/tasks') {
    // like HubSpot: an open task sets its contact's "next activity date" to the task's due time
    for (const a of b.associations || []) if (hs.contacts[a.to.id]) hs.contacts[a.to.id].notes_next_activity_date = b.properties.hs_timestamp;
    const id = `t${hs.writes.length}`; hs.tasks[id] = { ...b.properties }; return ok({ id });
  }
  const tm = u.pathname.match(/^\/crm\/v3\/objects\/tasks\/(\w[\w-]*)$/);
  if (tm && m === 'GET') return hs.tasks[tm[1]] ? ok({ id: tm[1], properties: { ...hs.tasks[tm[1]] } }) : { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  throw new Error(`unmocked ${m} ${u.pathname}`);
};

const { setNow } = await import('../src/clock.js');
const { db } = await import('../src/db/index.js');
const { mockOutbox, mockRcMessageStore, mockRcStore } = await import('../src/ringcentral.js');
const { mockMailbox } = await import('../src/email.js');
const { ownerLog } = await import('../src/notify.js');
const { handleRingCentralEvent } = await import('../src/webhook.js');
const { ingestEmail } = await import('../src/intake/email.js');
const { tick, replyTick } = await import('../src/jobs.js');
const { handleOwnerCommand } = await import('../src/agent/owner.js');
const { scheduleSend, sendDueScheduled } = await import('../src/agent/setter.js');
const { _resetContactGuard, checkBeforeSend } = await import('../src/contactguard.js');
const { config } = await import('../src/config.js');

const T0 = +new Date('2026-11-03T18:00:00Z'); // Tue 10:00 PST
const at = (min) => new Date(T0 + min * 60e3).toISOString();
const day = (d, h = 0) => new Date(T0 + d * 864e5 + h * 3600e3).toISOString();
const S = config.hubspot.stages;
const PIERCE = config.owner.phone;
let evt = 0;
const sms = (from, text) => handleRingCentralEvent({ body: { id: `cg${++evt}`, type: 'SMS', direction: 'Inbound', from: { phoneNumber: from }, subject: text } });
const to = (p) => mockOutbox.filter((x) => x.to === p);
const crexi = ({ name = 'Jane Buyer', phone = '(530) 555-0101', email = 'jane@example.com', property = 'Lighthouse Resort' } = {}) => ({
  From: 'notifications@crexi.com', Subject: 'New lead',
  TextBody: `Name: ${name}\n${email ? `Email: ${email}\n` : ''}${phone ? `Phone: ${phone}\n` : ''}Property: ${property}\nMessage: Is this still available?`,
});
const stepped = () => ownerLog.filter((t) => t.startsWith('Bot stepped back'));
const guardAudit = async (leadId) => (await db.listAuditSince('2000-01-01')).filter((a) => a.event === 'contact_guard' && a.lead_id === leadId);

beforeEach(async () => {
  db._reset(); mockOutbox.length = 0; mockMailbox.length = 0; ownerLog.length = 0;
  mockRcMessageStore.length = 0; Object.assign(mockRcStore, { error: null, recordSends: false });
  Object.assign(hs, { contacts: {}, deals: {}, tasks: {}, writes: [], notes: [], fail: null, c: 0, d: 0 });
  _resetContactGuard();
  setNow(at(0));
  await db.upsertListing({ hubspot_deal_id: 'h1', listing_code: 'LH-2026', name: 'Lighthouse Resort', city: 'Isleton, CA', ca_link: 'https://example.com/ca' });
});

test('Jacob: a seller in HubSpot (duplicate contact on a Sellers deal, phone stored "(916) 459-6179") gets no first touch, is muted, Pierce told once, nothing written to HubSpot', async () => {
  const JACOB = '+19164596179';
  hs.contacts['c-j1'] = { firstname: 'Jacob', phone: '(916) 459-6179', notes_last_contacted: '2026-10-30T20:00:00Z', notes_next_activity_date: '2026-11-04T17:00:00Z' };
  hs.contacts['c-j2'] = { firstname: 'Jacob', mobilephone: '916.459.6179' }; // the duplicate that holds the listing
  hs.deals['s-1'] = { dealname: 'Jacob Smith - Foothill MHP', pipeline: SELLERS, dealstage: '1730621131', _contacts: ['c-j2'] };

  await ingestEmail(crexi({ name: 'Jacob Smith', phone: '(916) 459-6179', email: null }));
  let lead = await db.findLeadByPhone(JACOB);
  assert.equal(to(JACOB).length, 0, 'no text to the seller');
  assert.equal(mockMailbox.length, 0, 'no email to the seller');
  assert.equal(lead.status, 'human', 'muted');
  assert.equal(lead.raw.contact_guard.reason, 'seller');
  assert.deepEqual(hs.writes, [], 'no HubSpot write of any kind: no contact, no buyer deal, no note, no PATCH');
  assert.equal(stepped().length, 1);
  assert.match(stepped()[0], /^Bot stepped back from L\d+ Jacob Smith .*\+19164596179: seller in HubSpot \(Sellers deal "Jacob Smith - Foothill MHP"\)\. The bot never texts sellers/);
  const a = await guardAudit(lead.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.reason, 'seller');
  assert.ok(a[0].detail.evidence.some((e) => e.reason === 'seller' && e.contact_id === 'c-j2' && e.deals[0].id === 's-1'), 'evidence names the duplicate contact and its Sellers deal');
  assert.ok(a[0].detail.evidence.some((e) => e.reason === 'meeting_booked') && a[0].detail.evidence.some((e) => e.reason === 'pierce_in_touch'), 'every signal is recorded');

  // later passes and his own text: still nothing from the bot, still one heads-up to Pierce
  setNow(at(45)); await tick();
  await sms(JACOB, 'Hey Pierce, any offers yet?');
  setNow(day(1)); await tick();
  assert.equal(to(JACOB).length, 0, 'never texted');
  assert.equal(stepped().length, 1, 'Pierce told once');
  assert.ok(ownerLog.some((t) => /replied \(your thread, bot muted\): "Hey Pierce, any offers yet\?"/.test(t)), 'his text is forwarded');
  assert.deepEqual(hs.writes, []);

  // B# never hands a seller to the bot: it stays muted and Pierce is told why
  ownerLog.length = 0;
  await handleOwnerCommand(`B${lead.id}`);
  lead = await db.getLead(lead.id);
  assert.equal(lead.status, 'human');
  assert.match(ownerLog.at(-1), /is still yours: seller in HubSpot \(Sellers deal "Jacob Smith - Foothill MHP"\)\. The bot stays off\. If HubSpot is wrong/);
  await sms(JACOB, 'Hello?');
  assert.equal(to(JACOB).length, 0);
  assert.deepEqual(hs.writes, [], 'still nothing written to HubSpot');
});

test('Matthew: Pierce scheduled a call (HubSpot next activity) -> status booked, the bot stops replying and following up', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  assert.equal(to(BUYER).length, 1, 'clean contact: first text went');
  const cid = Object.keys(hs.contacts)[0];
  hs.contacts[cid].notes_next_activity_date = day(1, 4); // Pierce put a call on the calendar for tomorrow

  setNow(at(60));
  await sms(BUYER, 'Sounds good, talk tomorrow');
  let lead = await db.findLeadByPhone(BUYER);
  assert.equal(to(BUYER).length, 1, 'no reply');
  assert.equal(lead.status, 'booked');
  assert.equal(lead.raw.contact_guard.reason, 'meeting_booked');
  assert.equal(stepped().length, 1);
  assert.match(stepped()[0], /HubSpot shows something scheduled with them \(Nov 4\)\. B\d+ to hand it back\./);
  assert.ok(hs.notes.some((n) => /Setter bot stepped back: HubSpot shows something scheduled/.test(n.body)), 'a buyer (not a seller) gets the HubSpot note');

  setNow(at(90));
  await sms(BUYER, 'Also, is the seller flexible?');
  setNow(day(3)); await tick(); setNow(day(8)); await tick();
  assert.equal(to(BUYER).length, 1, 'booked: no replies, no follow-ups');
  assert.ok(ownerLog.some((t) => /replied \(your thread, bot muted\): "Also, is the seller flexible\?"/.test(t)));
  assert.equal(stepped().length, 1, 'told once');
});

test('notes_last_contacted 3 days ago (Pierce emailed them) -> no first touch for the new Crexi inquiry', async () => {
  hs.contacts['c-p'] = { firstname: 'Jane', phone: '(530) 555-0101', notes_last_contacted: day(-3) }; // his format, no email
  await ingestEmail(crexi());
  const lead = await db.findLeadByPhone('+15305550101');
  assert.equal(mockMailbox.length, 0, 'no intro email');
  assert.equal(to('+15305550101').length, 0, 'no text');
  assert.equal(lead.status, 'human');
  assert.equal(lead.raw.contact_guard.reason, 'pierce_in_touch');
  assert.equal(stepped().length, 1);
  assert.match(stepped()[0], /you were in touch Oct 31 \(HubSpot last contacted\)\. B\d+ to hand it back\./);
  assert.equal(lead.hubspot_contact_id, 'c-p', "Pierce's contact is used");
  assert.ok(!hs.writes.some((w) => w.path === '/crm/v3/objects/contacts' && w.m === 'POST'), 'no duplicate contact created');
  assert.ok(!hs.writes.some((w) => w.path.startsWith('/crm/v3/objects/deals')), 'stepping back before the first touch opens no buyer deal');
  assert.ok(hs.notes.some((n) => /^\[Setter bot\] Setter bot stepped back: you were in touch/.test(n.body) && n.to.includes('c-p')), 'note on his contact');
  setNow(at(45)); await tick();
  assert.equal(to('+15305550101').length + mockMailbox.length, 0, 'later passes send nothing either');
});

test('Pierce texted them from RingCentral yesterday (not a bot send) -> the bot does not reply; its own texts never count', async () => {
  const BUYER = '+15305550101';
  mockRcStore.recordSends = true; // the bot's own texts land in the RingCentral store too, as they do live
  await ingestEmail(crexi());
  assert.equal(to(BUYER).length, 1);
  assert.equal(mockRcMessageStore.filter((r) => r.to[0].phoneNumber === BUYER).length, 1, 'the bot text is in the store');

  // the bot's own text in the store is recognized: a reply still goes
  setNow(at(30));
  await sms(BUYER, 'Me and a partner, paying cash');
  assert.equal(to(BUYER).length, 2, 'bot replied: its own text is not "Pierce texting"');

  // Pierce texts them himself from the RingCentral app (never in the messages table)
  mockRcMessageStore.push({ id: 'rc-pierce-1', direction: 'Outbound', creationTime: day(1, -1), to: [{ phoneNumber: BUYER }], subject: 'Hey, Pierce here. Free for a call?' });
  setNow(day(1));
  await sms(BUYER, 'Sure what time?');
  const lead = await db.findLeadByPhone(BUYER);
  assert.equal(to(BUYER).length, 2, 'no bot reply');
  assert.equal(lead.status, 'human');
  assert.equal(lead.raw.contact_guard.reason, 'pierce_texting');
  assert.match(stepped()[0], /you texted them from RingCentral Nov 4\. B\d+ to hand it back\./);
  assert.deepEqual(lead.raw.contact_guard.evidence[0].rc_message_ids, ['rc-pierce-1']);
});

test('clean contact -> normal first touch and follow-ups; HubSpot activity from the bot itself (its emails, its call task) never counts', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  assert.equal(mockMailbox.length, 1, 'intro email');
  assert.equal(to(BUYER).length, 1, 'first text');
  const cid = Object.keys(hs.contacts)[0];
  hs.contacts[cid].notes_last_contacted = at(1); // HubSpot logged the bot's own email
  setNow(day(1, 0.1)); await tick();
  assert.equal(to(BUYER).length, 2, 'day 1 follow-up text');
  assert.ok(hs.contacts[cid].notes_next_activity_date, "the bot's no-reply call task set the next activity date");
  setNow(day(3, 0.2)); await tick();
  assert.equal(mockMailbox.length, 2, 'day 3 follow-up email still goes: the next activity is the bot\'s own task');
  assert.equal(stepped().length, 0);
  assert.equal(ownerLog.filter((t) => /Can't check/.test(t)).length, 0);
  assert.equal((await db.findLeadByPhone(BUYER)).status, 'contacted');
});

test('HubSpot down -> first touches deferred (fail closed), Pierce told once per outage, sent once it is back', async () => {
  hs.fail = 'service unavailable';
  await ingestEmail(crexi());
  await ingestEmail(crexi({ name: 'Bo Buyer', phone: '(530) 555-0102', email: 'bo@example.com' }));
  assert.equal(mockOutbox.filter((x) => x.to !== PIERCE).length, 0, 'no texts');
  assert.equal(mockMailbox.length, 0, 'no emails');
  const outageTexts = () => ownerLog.filter((t) => /^Can't check HubSpot\/RingCentral/.test(t));
  assert.equal(outageTexts().length, 1, 'one text for the outage, not one per lead');
  const a = await db.findLeadByPhone('+15305550101');
  assert.equal(a.status, 'new');
  assert.equal(a.next_action_at, at(30), 'retried in 30 minutes');
  setNow(at(10)); await tick();
  assert.equal(outageTexts().length, 1);

  hs.fail = null;
  setNow(at(31)); await tick();
  assert.equal(to('+15305550101').length, 1, 'first text once HubSpot is back');
  assert.equal(to('+15305550102').length, 1);
  assert.equal(mockMailbox.length, 2);
});

test('HubSpot down during a conversation: a platform buyer the bot already contacted still gets a reply; a lead from a CSV list does not', async () => {
  await ingestEmail(crexi());
  assert.equal(to('+15305550101').length, 1);
  const csvLead = await db.insertLead({ phone: '+15305550199', first_name: 'Cy', source: 'csv', status: 'contacted', last_outbound_at: at(0) });
  setNow(at(20));
  hs.fail = 'timeout';
  await sms('+15305550101', 'Me and a partner, paying cash');
  assert.equal(to('+15305550101').length, 2, 'reply allowed: Crexi inquiry already in conversation');
  await sms('+15305550199', 'what is the price?');
  assert.equal(to('+15305550199').length, 0, 'no reply while the check is down');
  const cy = await db.getLead(csvLead.id);
  assert.equal(cy.reply_due_at, at(25), 'reply retried in 5 minutes');
  assert.equal(ownerLog.filter((t) => /^Can't check/.test(t)).length, 1);
  hs.fail = null;
  setNow(at(26)); await replyTick();
  assert.ok(to('+15305550199').length >= 1 || (await db.listPendingApprovals()).some((p) => p.lead_id === csvLead.id), 'handled once HubSpot answers again');
});

test('B# hands a lead back after Pierce-in-touch / Pierce-texting signals; newer ones still count, Pierce told again', async () => {
  const BUYER = '+15305550101';
  hs.contacts['c-p'] = { email: 'jane@example.com', phone: '+15305550101', notes_last_contacted: day(-3) };
  await ingestEmail(crexi());
  let lead = await db.findLeadByPhone(BUYER);
  assert.equal(lead.status, 'human');
  assert.equal(to(BUYER).length, 0);

  ownerLog.length = 0;
  await handleOwnerCommand(`B${lead.id}`);
  lead = await db.getLead(lead.id);
  assert.ok(lead.raw.guard_override_at);
  assert.ok(ownerLog.some((t) => /^Bot is back on L\d+ .*: first email\/text going out now\./.test(t)));
  assert.equal(mockMailbox.length, 1, 'stepped back before the first touch: B# sends it now (last contacted 3 days ago is older than the B#)');
  assert.equal(to(BUYER).length, 1);
  assert.equal(lead.status, 'contacted');
  setNow(at(5));
  await sms(BUYER, 'Me and a partner, paying cash');
  assert.equal(to(BUYER).length, 2, 'and replies');

  // Pierce texts them himself after handing it back: that's new, the bot steps back again
  mockRcMessageStore.push({ id: 'rc-p2', direction: 'Outbound', creationTime: at(20), to: [{ phoneNumber: BUYER }], subject: 'Calling you in 5' });
  setNow(at(40));
  await sms(BUYER, 'ok');
  assert.equal(to(BUYER).length, 2, 'no reply after Pierce texted');
  lead = await db.getLead(lead.id);
  assert.equal(lead.status, 'human');
  assert.equal(lead.raw.contact_guard.reason, 'pierce_texting');
  assert.equal(stepped().length, 1, 'told again for the new step-back');
});

test('a buyer deal at Offer Out (Pierce owns it) -> no reply, and no note on that deal', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  const dealId = Object.keys(hs.deals)[0];
  hs.deals[dealId].dealstage = S.offerOut;
  hs.writes.length = 0; hs.notes.length = 0;
  setNow(at(30));
  await sms(BUYER, 'Any update on our offer?');
  const lead = await db.findLeadByPhone(BUYER);
  assert.equal(to(BUYER).length, 1, 'only the first text');
  assert.equal(lead.status, 'human');
  assert.equal(lead.raw.contact_guard.reason, 'deal_with_pierce');
  assert.equal(hs.notes.length, 0, 'no note on a deal past Offer Out');
  assert.ok(!hs.writes.some((w) => w.path.endsWith(`/deals/${dealId}`)), 'deal untouched');
  assert.match(stepped()[0], /is at Offer Out or later in HubSpot\. It stays yours\./);
  await handleOwnerCommand(`B${lead.id}`);
  assert.equal((await db.getLead(lead.id)).status, 'human', 'B# does not override a deal past Offer Out');
});

test('a reply queued for later is checked again when it goes: Pierce texted meanwhile -> cancelled', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  let lead = await db.findLeadByPhone(BUYER);
  await scheduleSend(lead, 'Happy to send the rent roll once the CA is in.', 'reply', {}, { delaySec: 600 });
  mockRcMessageStore.push({ id: 'rc-p3', direction: 'Outbound', creationTime: at(5), to: [{ phoneNumber: BUYER }], subject: 'Got your note, calling shortly' });
  setNow(at(11)); await sendDueScheduled();
  assert.equal(to(BUYER).length, 1, 'queued reply did not go');
  lead = await db.getLead(lead.id);
  assert.equal(lead.status, 'human');
  assert.ok(db._tables.messages.some((m) => m.status === 'cancelled' && m.lead_id === lead.id));
});

test('mock modes with no fakes configured: the guard allows (no HubSpot token, empty RingCentral store)', async () => {
  const saved = config.hubspot.token; config.hubspot.token = '';
  try {
    const lead = await db.insertLead({ phone: '+15305550123', source: 'listing_email', status: 'contacted' });
    assert.deepEqual(await checkBeforeSend(lead, 'first_touch'), { ok: true });
  } finally { config.hubspot.token = saved; }
});

test('RingCentral message store down -> no first text (fail closed), retried, Pierce told once', async () => {
  mockRcStore.error = 'RingCentral 503';
  await ingestEmail(crexi());
  const lead = await db.findLeadByPhone('+15305550101');
  assert.equal(to('+15305550101').length + mockMailbox.length, 0);
  assert.equal(lead.status, 'new');
  assert.equal(ownerLog.filter((t) => /^Can't check HubSpot\/RingCentral before the bot writes to leads \(RingCentral: RingCentral 503\)/.test(t)).length, 1);
  mockRcStore.error = null;
  setNow(at(31)); await tick();
  assert.equal(to('+15305550101').length, 1, 'sent once RingCentral answers');
});

// ---------------- review fixes ----------------

test('legacy lead: a call task the bot made before bot_task_due existed is not read as a meeting (due time read from HubSpot)', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  let lead = await db.findLeadByPhone(BUYER);
  const cid = Object.keys(hs.contacts)[0];
  // as a pre-deploy lead looks: a no_reply task id, no raw.bot_task_due; HubSpot's next activity = that task's due time
  hs.tasks['t-old'] = { hs_timestamp: day(1) };
  hs.contacts[cid].notes_next_activity_date = day(1);
  const { bot_task_due: _d, ...raw } = lead.raw || {};
  await db.updateLead(lead.id, { hubspot_tasks: { no_reply: 't-old' }, raw });
  _resetContactGuard();
  setNow(at(30));
  await sms(BUYER, 'what is the cap rate?');
  lead = await db.getLead(lead.id);
  assert.notEqual(lead.status, 'booked');
  assert.equal(lead.raw.contact_guard, undefined);
  assert.equal(stepped().length, 0);
  assert.ok(to(BUYER).length >= 2 || (await db.listPendingApprovals()).some((p) => p.lead_id === lead.id), 'the buyer is answered');

  // a next activity that is NOT the bot's task still counts
  hs.contacts[cid].notes_next_activity_date = day(2);
  _resetContactGuard();
  setNow(at(60));
  await sms(BUYER, 'and the occupancy?');
  assert.equal((await db.getLead(lead.id)).status, 'booked');
});

test('B# holds for a meeting still in the future (hs_latest_meeting_activity): no step-back loop', async () => {
  const BUYER = '+15305550101';
  hs.contacts['c-m'] = { firstname: 'Matthew', phone: '(530) 555-0101', hs_latest_meeting_activity: day(3) };
  await ingestEmail(crexi({ name: 'Matthew Buyer' }));
  let lead = await db.findLeadByPhone(BUYER);
  assert.equal(lead.status, 'booked');
  assert.ok(!hs.writes.some((w) => w.path.startsWith('/crm/v3/objects/deals')), 'no buyer deal opened by the step-back');
  setNow(at(5));
  await handleOwnerCommand(`B${lead.id}`);
  assert.ok(ownerLog.some((t) => /^Bot is back on .*first email\/text going out now/.test(t)));
  const sentAfterB = to(BUYER).length;
  assert.equal(sentAfterB, 1);
  setNow(at(60)); _resetContactGuard();
  await sms(BUYER, 'what is the cap rate?');
  lead = await db.getLead(lead.id);
  assert.equal(lead.raw.contact_guard.reason, 'meeting_booked', 'the old step-back record is kept');
  assert.equal(stepped().length, 1, 'no second step-back for the meeting he already knew about');
  assert.ok(to(BUYER).length > sentAfterB || (await db.listPendingApprovals()).some((p) => p.lead_id === lead.id), 'the bot answers');

  // a different meeting booked later is news again
  hs.contacts['c-m'].hs_latest_meeting_activity = day(5);
  setNow(at(120)); _resetContactGuard();
  assert.equal((await checkBeforeSend(await db.getLead(lead.id), 'reply')).reason, 'meeting_booked');
});

test('first-touch step-back for a scheduled next activity: status booked, no buyer deal created or qualified', async () => {
  hs.contacts['c-p'] = { firstname: 'Jane', phone: '530-555-0101', notes_next_activity_date: day(2) };
  await ingestEmail(crexi());
  const lead = await db.findLeadByPhone('+15305550101');
  assert.equal(lead.status, 'booked');
  assert.equal(to('+15305550101').length + mockMailbox.length, 0);
  assert.ok(!hs.writes.some((w) => w.path.startsWith('/crm/v3/objects/deals')), 'no deal POST/PATCH');
  assert.deepEqual(lead.hubspot_deals || {}, {});
});

test('buyer texts their email while HubSpot is down: intro email held (no first_email_at), sent once the check answers', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi({ email: null }));
  assert.equal(to(BUYER).length, 1);
  assert.equal(mockMailbox.length, 0);
  setNow(at(20));
  hs.fail = 'down';
  await sms(BUYER, 'sure, my email is jane@example.com');
  let lead = await db.findLeadByPhone(BUYER);
  assert.equal(lead.first_email_at ?? null, null, 'not marked emailed');
  assert.equal(lead.raw.intro_email, 'pending: contact check');
  assert.equal(mockMailbox.length, 0);
  hs.fail = null;
  setNow(at(80)); await tick();
  lead = await db.getLead(lead.id);
  assert.equal(mockMailbox.length, 1, 'intro email went once HubSpot answered');
  assert.equal(lead.raw.intro_email, 'sent');
  assert.ok(lead.first_email_at);
});

test('RingCentral outage: Pierce told once even when email-only leads check cleanly in between', async () => {
  mockRcStore.error = 'RC 503';
  const outageTexts = () => ownerLog.filter((t) => /^Can't check/.test(t));
  await ingestEmail(crexi());
  assert.equal(outageTexts().length, 1);
  await ingestEmail(crexi({ name: 'Em Mail', phone: null, email: 'em@example.com' })); // HubSpot only, no RingCentral call
  setNow(at(40)); await tick();
  assert.equal(outageTexts().length, 1, 'still one text for the one outage');
  assert.equal(to('+15305550101').length, 0, 'phone lead still waiting');
  mockRcStore.error = null;
  setNow(at(75)); await tick();
  assert.equal(to('+15305550101').length, 1);
  mockRcStore.error = 'RC 503 again';
  await ingestEmail(crexi({ name: 'Bo Buyer', phone: '(530) 555-0102', email: 'bo@example.com' }));
  assert.equal(outageTexts().length, 2, 'a new outage after RingCentral answered is news');
});

test('Jacob inquires again on another listing, and a no-phone seller inquires: nothing is written to HubSpot', async () => {
  const JACOB = '+19164596179';
  await db.upsertListing({ hubspot_deal_id: 'h2', listing_code: 'OG-2026', name: 'Oak Grove MHP', city: 'Chico, CA' });
  hs.contacts['c-j2'] = { firstname: 'Jacob', mobilephone: '916.459.6179', email: 'jacob@example.com' };
  hs.deals['s-1'] = { dealname: 'Jacob Smith - Foothill MHP', pipeline: SELLERS, dealstage: '1730621131', _contacts: ['c-j2'] };
  await ingestEmail(crexi({ name: 'Jacob Smith', phone: '(916) 459-6179', email: null }));
  assert.equal((await db.findLeadByPhone(JACOB)).raw.contact_guard.reason, 'seller');
  await ingestEmail(crexi({ name: 'Jacob Smith', phone: '(916) 459-6179', email: 'jacob@example.com', property: 'Oak Grove MHP' }));
  assert.deepEqual(hs.writes, [], 'no contact PATCH, no Buyers deal, no note on the seller');
  assert.equal(to(JACOB).length + mockMailbox.length, 0);

  // a seller known only by email (no phone in the inquiry)
  hs.contacts['c-s3'] = { firstname: 'Sal', email: 'sal@example.com' };
  hs.deals['s-3'] = { dealname: 'Sal - Pine MHP', pipeline: SELLERS, dealstage: '1730621131', _contacts: ['c-s3'] };
  await ingestEmail(crexi({ name: 'Sal Seller', phone: null, email: 'sal@example.com' }));
  const sal = await db.findLeadByEmail('sal@example.com');
  assert.equal(sal.status, 'human');
  assert.equal(sal.raw.contact_guard.reason, 'seller');
  assert.deepEqual(hs.writes, [], 'still nothing written');
  assert.equal(mockMailbox.length, 0);
  assert.ok(!ownerLog.some((t) => /no phone: .*Sal/.test(t)), 'only the step-back heads-up, not the "needs email follow-up" one');
});

test('seller fixed in HubSpot: B# lets the bot back in and HubSpot writes resume', async () => {
  hs.contacts['c-j2'] = { firstname: 'Jacob', mobilephone: '916.459.6179' };
  hs.deals['s-1'] = { dealname: 'Jacob Smith - Foothill MHP', pipeline: SELLERS, dealstage: '1730621131', _contacts: ['c-j2'] };
  await ingestEmail(crexi({ name: 'Jacob Smith', phone: '(916) 459-6179', email: null }));
  let lead = await db.findLeadByPhone('+19164596179');
  hs.fail = 'down';
  await handleOwnerCommand(`B${lead.id}`);
  assert.equal((await db.getLead(lead.id)).status, 'human', 'HubSpot down: a seller is not handed back unchecked');
  hs.fail = null;
  delete hs.deals['s-1']; // Pierce: wrong contact, fixed in HubSpot
  await handleOwnerCommand(`B${lead.id}`);
  lead = await db.getLead(lead.id);
  assert.ok(lead.raw.contact_guard.cleared_at);
  assert.equal(to('+19164596179').length, 1, 'first text went');
});

test("Pierce's A# answer to a booked lead is delivered after the pace delay (not cancelled as muted)", async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  const lead = await db.findLeadByPhone(BUYER);
  await db.updateLead(lead.id, { status: 'booked' });
  const q = await db.createOwnerQuestion({ lead_id: lead.id, listing_id: lead.listing_id ?? null, question: 'Is it city water?' });
  const saved = { ...config.pace }; Object.assign(config.pace, { minSec: 40, maxSec: 180 });
  try {
    setNow(at(30));
    await handleOwnerCommand(`A${q.id} City water`);
    assert.equal(to(BUYER).length, 1, 'queued, not sent yet');
    setNow(at(40)); await sendDueScheduled();
  } finally { Object.assign(config.pace, saved); }
  assert.equal(to(BUYER).length, 2, 'his answer reached the buyer');
  assert.ok(!db._tables.messages.some((m) => m.lead_id === lead.id && m.status === 'cancelled'));
});

test('a buyer who books at night still gets the booking confirmation in the morning', async () => {
  const BUYER = '+15305550101';
  await ingestEmail(crexi());
  setNow(new Date(T0 + 12.5 * 3600e3).toISOString()); // 22:30 PST
  await sms(BUYER, 'Tuesday 2pm works');
  let lead = await db.findLeadByPhone(BUYER);
  assert.equal(lead.status, 'booked');
  assert.equal(to(BUYER).length, 1, 'quiet hours: queued');
  setNow(new Date(T0 + 21 * 3600e3 + 10 * 60e3).toISOString()); // 07:10 PST
  await sendDueScheduled();
  assert.equal(to(BUYER).length, 2);
  assert.match(to(BUYER).at(-1).text, /I'll call you then/);
  lead = await db.getLead(lead.id);
  assert.equal(lead.status, 'booked');
});

test('Pierce texts 60s after a bot text (different id and body): seen as Pierce, not matched to the bot by time', async () => {
  const BUYER = '+15305550101';
  mockRcStore.recordSends = true;
  await ingestEmail(crexi());
  assert.equal(to(BUYER).length, 1);
  const botAt = +new Date(mockRcMessageStore[0].creationTime);
  mockRcMessageStore.push({ id: 'rc-p60', direction: 'Outbound', creationTime: new Date(botAt + 60e3).toISOString(), to: [{ phoneNumber: BUYER }], subject: "I'll call you in 5" });
  setNow(at(10));
  await sms(BUYER, 'ok sounds good');
  const lead = await db.findLeadByPhone(BUYER);
  assert.equal(to(BUYER).length, 1, 'no bot reply');
  assert.equal(lead.raw.contact_guard.reason, 'pierce_texting');
  assert.deepEqual(lead.raw.contact_guard.evidence[0].rc_message_ids, ['rc-p60']);
});
