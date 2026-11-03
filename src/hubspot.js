// HubSpot sync: contacts, one Buyers-pipeline deal per buyer per listing, notes, and listing import.
// Every function is a no-op when HUBSPOT_TOKEN is not set. Failures are logged, never thrown,
// so a HubSpot outage never stops a lead from getting a text back.
import { config } from './config.js';
import { mostRestrictive, publicListingName } from './listings.js';
import { db } from './db/index.js';
import { now } from './clock.js';
import { notifyOwner } from './notify.js';

const hs = config.hubspot;
const S = hs.stages;
const enabled = () => !!hs.token;

export const hubspotLog = []; // for tests / debugging
// Pierce (Nov 2 2026): never delete. No DELETE, no archive, no merge, ever.
export function assertHubspotAllowed(method, path) {
  if (String(method).toUpperCase() === 'DELETE' || /\/(archive|merge|gdpr-delete)\b/i.test(path)) throw new Error(`Refused: the bot never deletes HubSpot records (${method} ${path})`);
}
async function api(method, path, body) {
  assertHubspotAllowed(method, path);
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${hs.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const e = new Error(`HubSpot ${method} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`); e.status = res.status; e.path = path; throw e; }
  return res.status === 204 ? null : res.json();
}
// A 401/403 means the HubSpot service key lacks a scope: tell Pierce once per object type, then just log.
const scopeAlerted = new Set();
async function scopeAlert(e) {
  if (![401, 403].includes(e.status)) return;
  const obj = String(e.path || '').match(/objects\/(\w+)/)?.[1] || 'api';
  if (scopeAlerted.has(obj)) return;
  scopeAlerted.add(obj);
  await notifyOwner(`HubSpot refused the bot's ${obj} request (${e.status}). The "CRI Setter Bot" service key is missing a scope for ${obj}${obj === 'notes' || obj === 'tasks' ? ` (look for crm.objects.${obj}.write in the key's scope list)` : ''}. Leads still get answered; HubSpot logging for ${obj} is paused until it's added.`);
}
/**
 * A lead the contact guard found to be a seller in HubSpot (src/contactguard.js): the bot writes nothing to HubSpot for
 * it, by any path (no contact fill-in, no buyer deal, no note, no task, no stage move). Cleared only when Pierce's B#
 * finds no seller any more (contact_guard.cleared_at).
 */
export const isSellerLead = (lead) => lead?.raw?.contact_guard?.reason === 'seller' && !lead.raw.contact_guard.cleared_at;
// Test leads (Pierce's own cell playing a buyer, owner TEST command) and sellers never touch HubSpot. The stored lead is
// read so a caller's stale copy can't miss a seller flag set a moment ago.
const skipTest = (fn) => async (x, ...rest) => {
  const lead = x && typeof x === 'object' ? ((x.id && (await db.getLead(x.id))) || x) : await db.getLead(x);
  if (lead?.raw?.test || isSellerLead(lead)) return null;
  return fn(x, ...rest);
};
const safe = (fn) => async (...args) => {
  if (!enabled()) return null;
  try { return await fn(...args); } catch (e) { console.error('[hubspot]', e.message); await scopeAlert(e); return null; }
};

// ---------- stage logic (pure, unit-tested) ----------
const RANK = { [S.newBuyer]: 0, [S.qualified]: 1, [S.offerOut]: 2, [S.underContract]: 3, [S.won]: 4, [S.lost]: -1 };
const HUMAN_STAGES = new Set([S.offerOut, S.underContract, S.won]);
// field writes (e.g. Next step) also stay off Closed Lost deals; stage moves follow decideStageMove
const NO_FIELD_WRITES = new Set([...HUMAN_STAGES, S.lost]);

/** Offer Out / Under Contract / Closed Won: Pierce owns the deal (non-negotiable 8). */
export const isHumanStage = (stage) => HUMAN_STAGES.has(stage);

// ---------- contact awareness (read-only lookups for src/contactguard.js) ----------
// These THROW on errors (unlike the safe() writers below): the contact guard must know a lookup failed so it can fail
// closed. They return null when HubSpot is off (no HUBSPOT_TOKEN), which the guard treats as "nothing known".
export const CONTACT_GUARD_PROPS = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'createdate', 'notes_last_contacted',
  'notes_next_activity_date', 'engagements_last_meeting_booked', 'hs_latest_meeting_activity'];
// HubSpot's search API allows a few requests per second per portal: one short wait and retry on a 429, so a burst of
// first touches doesn't read as an outage
async function lookup(method, path, body) {
  try { return await api(method, path, body); } catch (e) {
    if (e.status !== 429) throw e;
    await new Promise((r) => setTimeout(r, 1100));
    return api(method, path, body);
  }
}
export const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

/**
 * Every HubSpot contact for this phone or email, duplicates included. Phones are stored in any format ("(916) 459-6179",
 * "+19164596179", "916.459.6179"), so the search asks for tokens ending in the last 7 and the last 4 digits on phone AND
 * mobilephone, and the results are kept only when the last 10 digits match exactly. Email: exact match.
 */
export async function findContactsFor({ phone, email } = {}) {
  if (!enabled()) return null;
  const d = last10(phone);
  const mail = email ? String(email).trim().toLowerCase() : null;
  const groups = [];
  if (d) {
    for (const prop of ['phone', 'mobilephone']) {
      groups.push({ filters: [{ propertyName: prop, operator: 'CONTAINS_TOKEN', value: `*${d.slice(-7)}` }] });
      groups.push({ filters: [{ propertyName: prop, operator: 'CONTAINS_TOKEN', value: `*${d.slice(-4)}` }] });
    }
  }
  if (mail) groups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: mail }] });
  if (!groups.length) return [];
  const out = new Map();
  let after; let pages = 0;
  do {
    const page = await lookup('POST', '/crm/v3/objects/contacts/search', { filterGroups: groups, properties: CONTACT_GUARD_PROPS, limit: 100, ...(after ? { after } : {}) });
    for (const c of page?.results || []) {
      const p = c.properties || {};
      const phoneHit = d && [p.phone, p.mobilephone].some((x) => last10(x) === d);
      const mailHit = mail && String(p.email || '').trim().toLowerCase() === mail;
      if (phoneHit || mailHit) out.set(String(c.id), { id: String(c.id), properties: p, matched: phoneHit ? 'phone' : 'email' });
    }
    after = page?.paging?.next?.after;
  } while (after && ++pages < 5);
  return [...out.values()];
}

/** Every deal (any pipeline) associated with one contact: { id, name, pipeline, stage }. Read-only. */
export async function dealsForContact(contactId) {
  if (!enabled()) return null;
  const page = await lookup('POST', '/crm/v3/objects/deals/search', {
    filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: String(contactId) }] }],
    properties: ['dealname', 'dealstage', 'pipeline'], limit: 100,
  });
  return (page?.results || []).map((x) => ({ id: String(x.id), name: x.properties?.dealname || '', pipeline: x.properties?.pipeline || null, stage: x.properties?.dealstage || null }));
}

/**
 * Due times (hs_timestamp) of the bot's own call tasks, by task id. For tasks made before createTask recorded
 * raw.bot_task_due: their due time is the contact's "next activity date", which the guard must not read as Pierce's.
 * A task that no longer exists (404) is skipped. Read-only; throws on other errors.
 */
export async function taskDueTimes(ids) {
  if (!enabled()) return null;
  const out = [];
  for (const id of ids) {
    try {
      const t = await lookup('GET', `/crm/v3/objects/tasks/${id}?properties=hs_timestamp`);
      if (t?.properties?.hs_timestamp) out.push(String(t.properties.hs_timestamp));
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return out;
}

/** Stage of each of the bot's own buyer deals for this lead. A deal that no longer exists (404) is skipped. */
export async function leadDealStages(lead) {
  if (!enabled() || lead?.raw?.test) return [];
  const out = [];
  for (const id of Object.values(lead?.hubspot_deals || {}).filter(Boolean)) {
    try {
      const d = await lookup('GET', `/crm/v3/objects/deals/${id}?properties=dealstage,dealname`);
      out.push({ id: String(id), name: d?.properties?.dealname || '', stage: d?.properties?.dealstage || null });
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return out;
}

const dealIdFor = async (lead) => {
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  return lead.hubspot_deals?.[dealKey(lead, listing)] || null;
};

/**
 * A HubSpot task for Pierce (the bot can't call). Deduped per lead by `key`. Returns the task id, or null if HubSpot
 * is off or the call failed (the caller then texts Pierce instead, so the reminder is never lost).
 */
export const createTask = safe(skipTest(async (leadId, { key, subject, body, dueAt, type = 'CALL', priority = 'HIGH' }) => {
  const lead = await db.getLead(leadId);
  if (lead.hubspot_tasks?.[key]) return lead.hubspot_tasks[key];
  const contactId = lead.hubspot_contact_id || (await upsertContact(lead));
  const dealId = await dealIdFor(lead);
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  const owner = listing?.owner_id || hs.ownerId; // the call goes to whoever owns the listing (Pierce or Dylan)
  const associations = [];
  if (contactId) associations.push({ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] });
  if (dealId) associations.push({ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] });
  const t = await api('POST', '/crm/v3/objects/tasks', {
    properties: {
      hs_timestamp: dueAt, hs_task_subject: subject, hs_task_body: body, hs_task_status: 'NOT_STARTED',
      hs_task_priority: priority, hs_task_type: type, ...(owner ? { hubspot_owner_id: owner } : {}),
    },
    associations,
  });
  // the task's due time sets the contact's "next activity date": the contact guard must not read the bot's own
  // reminders as a meeting Pierce booked, so their due times are kept on the lead
  const fresh = (await db.getLead(leadId)) || lead;
  const due = [...(fresh.raw?.bot_task_due || []), dueAt].slice(-20);
  await db.updateLead(leadId, { hubspot_tasks: { ...(fresh.hubspot_tasks || {}), [key]: t.id }, raw: { ...(fresh.raw || {}), bot_task_due: due } });
  hubspotLog.push({ op: 'task', leadId, key, subject });
  return t.id;
}));

/** The deal's "Next step" field: every lead always shows what happens next and when. */
export const setNextStep = safe(skipTest(async (leadId, text) => {
  const lead = await db.getLead(leadId);
  const dealId = lead && (await dealIdFor(lead));
  if (dealId) {
    // non-negotiable 8: never write to a deal at/after Offer Out, or a closed one
    const stage = (await api('GET', `/crm/v3/objects/deals/${dealId}?properties=dealstage`))?.properties?.dealstage;
    if (NO_FIELD_WRITES.has(stage)) { hubspotLog.push({ op: 'next_step_skipped', leadId, dealId, stage }); return false; }
    await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { hs_next_step: text.slice(0, 250) } });
  }
  hubspotLog.push({ op: 'next_step', leadId, text });
  return true;
}));

/** Read-only: token works for contacts and deals, and both pipelines are reachable. */
/**
 * Read-only check of the HubSpot service key (HUBSPOT_TOKEN, a Bearer token). Contacts + deals read are required.
 * Notes and tasks are probed by READ only (a write can't be tested without creating a record); a 403 there means the
 * key likely needs crm.objects.notes / crm.objects.tasks scopes for the bot's logging and call tasks.
 */
export async function hubspotCheck() {
  if (!enabled()) return { ok: false, problems: ['HUBSPOT_TOKEN (the HubSpot service key) not set'] };
  const one = (pipeline) => api('POST', '/crm/v3/objects/deals/search', { filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipeline }] }], limit: 1 });
  const [buyers, sellers] = await Promise.all([one(hs.buyersPipeline), one(hs.sellersPipeline)]);
  await api('GET', '/crm/v3/objects/contacts?limit=1');
  const problems = []; const warnings = [];
  if (!sellers.total) problems.push(`Sellers pipeline ${hs.sellersPipeline} has no deals visible to this service key`);
  for (const obj of ['notes', 'tasks']) {
    try { await api('GET', `/crm/v3/objects/${obj}?limit=1`); } catch (e) {
      if ([401, 403].includes(e.status)) warnings.push(`service key can't read ${obj} (${e.status}): add crm.objects.${obj}.read/.write if the key offers them, or ${obj === 'tasks' ? 'call tasks fall back to texts' : 'notes are skipped'}`);
      else throw e;
    }
  }
  return { ok: !problems.length, buyers_deals: buyers.total, sellers_deals: sellers.total, problems, warnings };
}

/** Map bot lead status -> { stage, lostReason } the bot wants the deal in. */
export function targetStageFor(status) {
  switch (status) {
    case 'new': case 'awaiting_approval': case 'contacted': case 'engaged': case 'escalated': case 'human':
      return { stage: S.newBuyer };
    case 'qualified': case 'booked': case 'in_dd':
      return { stage: S.qualified };
    case 'disqualified': return { stage: S.lost, lostReason: 'not_a_fit', detail: 'Setter bot: not a buyer / not interested' };
    case 'no_response': return { stage: S.lost, lostReason: 'unresponsive', detail: 'Setter bot: no reply after full follow-up cadence' };
    case 'nurture': return { stage: S.lost, lostReason: 'unresponsive', detail: 'Setter bot: no reply after day 7; on the long-term email list for new listings' };
    case 'opted_out': return { stage: S.lost, lostReason: 'other', detail: 'Setter bot: lead opted out of texts' };
    case 'wrong_number': return { stage: S.lost, lostReason: 'duplicate', detail: 'Setter bot: wrong number' };
    default: return null;
  }
}

/**
 * Decide whether the bot may move a deal. Rules:
 *  - never touch Offer Out / Under Contract / Closed Won (Pierce owns those)
 *  - only move forward, except: re-open a Closed Lost deal when the lead re-engages
 *  - only auto Closed-Lost from New Buyer (a Qualified buyer going quiet stays put), except opt-outs
 */
export function decideStageMove(currentStage, status) {
  const target = targetStageFor(status);
  if (!target || !currentStage || currentStage === target.stage) return null;
  if (HUMAN_STAGES.has(currentStage)) return null;
  if (target.stage === S.lost) {
    if (currentStage === S.newBuyer || status === 'opted_out' || status === 'wrong_number') return target;
    return null;
  }
  if (currentStage === S.lost) return target; // lead came back
  return (RANK[target.stage] ?? -1) > (RANK[currentStage] ?? -1) ? target : null;
}

// ---------- contacts ----------
export const upsertContact = safe(skipTest(async (lead) => {
  if (lead.hubspot_contact_id) return lead.hubspot_contact_id;
  const filters = [];
  if (lead.email) filters.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: lead.email }] });
  if (lead.phone) filters.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: lead.phone }] }, { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: lead.phone }] });
  let id = null;
  if (filters.length) {
    const found = await api('POST', '/crm/v3/objects/contacts/search', { filterGroups: filters, properties: ['email'], limit: 1 });
    id = found?.results?.[0]?.id ?? null;
  }
  const props = Object.fromEntries(Object.entries({
    firstname: lead.first_name, lastname: lead.last_name, email: lead.email, phone: lead.phone, company: lead.company,
  }).filter(([, v]) => v));
  if (id) {
    // only fill blanks: don't overwrite what Pierce already cleaned up
    const cur = await api('GET', `/crm/v3/objects/contacts/${id}?properties=${Object.keys(props).join(',')}`);
    const fill = Object.fromEntries(Object.entries(props).filter(([k]) => !cur?.properties?.[k]));
    if (Object.keys(fill).length) await api('PATCH', `/crm/v3/objects/contacts/${id}`, { properties: fill });
  } else {
    id = (await api('POST', '/crm/v3/objects/contacts', { properties: props })).id;
  }
  await db.updateLead(lead.id, { hubspot_contact_id: id });
  hubspotLog.push({ op: 'contact', leadId: lead.id, id });
  return id;
}));

// ---------- buyer deals ----------
const dealKey = (lead, listing) => listing?.listing_code || listing?.hubspot_deal_id || lead.property_name || 'general';

// concurrent calls for one buyer + listing (intake, the first-touch pass, a status sync) share one lookup/create:
// one buyer deal, never two
const dealInFlight = new Map();
export const ensureBuyerDeal = safe(skipTest(async (lead, listing) => {
  if (!hs.createDeals) return null;
  const k = `${lead.id}|${dealKey(lead, listing)}`;
  if (!dealInFlight.has(k)) dealInFlight.set(k, ensureBuyerDealOnce(lead, listing).finally(() => dealInFlight.delete(k)));
  return dealInFlight.get(k);
}));

async function ensureBuyerDealOnce(lead, listing) {
  const key = dealKey(lead, listing);
  const existing = (await db.getLead(lead.id))?.hubspot_deals?.[key] || lead.hubspot_deals?.[key]; // the caller's copy may be stale
  if (existing) return existing;
  const contactId = await upsertContact(lead);
  if (!contactId) return null;

  // reuse a deal Pierce (or another workflow) already made for this buyer + listing
  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: hs.buyersPipeline },
    { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
  ];
  if (listing?.listing_code) filters.push({ propertyName: 'listing_code', operator: 'EQ', value: listing.listing_code });
  const found = await api('POST', '/crm/v3/objects/deals/search', { filterGroups: [{ filters }], properties: ['dealname', 'dealstage'], limit: listing?.listing_code ? 1 : 20 });
  // with a listing_code the search is already per listing; without one, only a deal NAMED for this property is reused
  // (never the buyer's deal for a different park)
  const names = [listing?.name, listing && publicListingName(listing.name), lead.property_name].filter(Boolean).map((n) => n.toLowerCase().trim());
  const forThisListing = (d) => listing?.listing_code || (names.length && names.some((n) => String(d.properties?.dealname || '').toLowerCase().includes(n)));
  let dealId = (found?.results || []).find(forThisListing)?.id;

  if (!dealId) {
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company || lead.phone || lead.email;
    const props = {
      dealname: `${who} – ${listing?.name || lead.property_name || 'Buyer inquiry'}`,
      pipeline: hs.buyersPipeline,
      dealstage: S.newBuyer,
      ...(listing?.listing_code ? { listing_code: listing.listing_code } : {}),
      ...(listing?.owner_id || hs.ownerId ? { hubspot_owner_id: listing?.owner_id || hs.ownerId } : {}), // Dylan's listing -> Dylan's buyer deal
      ...(hs.platformProperty && lead.platform ? { [hs.platformProperty]: lead.platform } : {}),
    };
    const created = await api('POST', '/crm/v3/objects/deals', {
      properties: props,
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
    });
    dealId = created.id;
    hubspotLog.push({ op: 'deal_create', leadId: lead.id, dealId, props });
  }
  const fresh = await db.getLead(lead.id);
  await db.updateLead(lead.id, { hubspot_deals: { ...(fresh.hubspot_deals || {}), [key]: dealId } });
  return dealId;
}

/**
 * Call after any lead status change. Moves the buyer deal per decideStageMove.
 * create: false only moves a deal that already exists (the contact guard stepping back never opens a deal).
 */
export const syncDealStage = safe(skipTest(async (leadId, { create = true } = {}) => {
  const lead = await db.getLead(leadId);
  if (!lead) return null;
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  const dealId = lead.hubspot_deals?.[dealKey(lead, listing)] || (create ? await ensureBuyerDeal(lead, listing) : null);
  if (!dealId) return null;
  const deal = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=dealstage`);
  const move = decideStageMove(deal?.properties?.dealstage, lead.status);
  if (!move) return null;
  const properties = { dealstage: move.stage };
  if (move.lostReason) Object.assign(properties, { lost_reason_category: move.lostReason, closed_lost_reason: move.detail });
  await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties });
  hubspotLog.push({ op: 'deal_stage', leadId, dealId, ...properties });
  return properties;
}));

/** Timeline note on the contact (and the deal if one exists). */
export const addNote = safe(skipTest(async (leadId, body) => {
  const lead = await db.getLead(leadId);
  const contactId = lead?.hubspot_contact_id || (await upsertContact(lead));
  if (!contactId) return null;
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  const dealId = lead.hubspot_deals?.[dealKey(lead, listing)];
  const associations = [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }];
  if (dealId) associations.push({ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] });
  await api('POST', '/crm/v3/objects/notes', { properties: { hs_timestamp: now().toISOString(), hs_note_body: `[Setter bot] ${body}` }, associations });
  hubspotLog.push({ op: 'note', leadId, body });
  return true;
}));

/**
 * Bot status for a Sellers-pipeline deal. listing_status wins when set; otherwise the stage decides
 * (most of Pierce's deals have no listing_status). BOV / Closed Lost are not listings -> null.
 */
export function listingStatusFor(p) {
  const st = hs.sellerStages;
  if (p.listing_status === 'sold') return 'closed';
  if (p.listing_status === 'under_contract') return 'in_escrow';
  if (p.listing_status === 'on_market' || p.listing_status === 'off_market') return 'active';
  if (p.dealstage === st.listed) return 'active';
  if (p.dealstage === st.underContract) return 'in_escrow';
  if (p.dealstage === st.closedWon) return 'closed';
  return null;
}

/** Pull listings (Listed, Under Contract, Closed Won) from the Sellers pipeline into the local listings table. */
export const syncListingsFromHubSpot = safe(async () => {
  const props = ['dealname', 'dealstage', 'hubspot_owner_id', 'listing_code', 'listing_status', 'crexi_listing_url', 'ca_link', 'om_link', 'listing_hub_url'];
  const st = hs.sellerStages;
  const existing = new Map((await db.listListings()).map((l) => [l.hubspot_deal_id, l]));
  let after; let count = 0;
  do {
    const page = await api('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [
        // only Pierce's and Dylan's listings (other agents' deals in the portal are never imported)
        { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: hs.sellersPipeline }, { propertyName: 'hubspot_owner_id', operator: 'IN', values: hs.listingOwners }, { propertyName: 'dealstage', operator: 'IN', values: [st.listed, st.underContract, st.closedWon] }] },
        { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: hs.sellersPipeline }, { propertyName: 'hubspot_owner_id', operator: 'IN', values: hs.listingOwners }, { propertyName: 'listing_status', operator: 'IN', values: ['on_market', 'off_market', 'under_contract', 'sold'] }] },
      ],
      properties: props, limit: 100, after,
    });
    for (const d of page.results || []) {
      const p = d.properties;
      const hsStatus = listingStatusFor(p);
      if (!hsStatus || !hs.listingOwners.includes(String(p.hubspot_owner_id))) continue; // belt and braces
      const prev = existing.get(d.id);
      // a folder in Dropbox "02 - Under Contract" keeps it under contract even if HubSpot still says Listed
      const status = mostRestrictive(hsStatus, prev?.facts?.dropbox_stage === 'under_contract' ? 'in_escrow' : null);
      await db.upsertListing({
        hubspot_deal_id: d.id, listing_code: p.listing_code || null, name: p.dealname, // no code -> buyer deals key on hubspot_deal_id
        status, owner_id: String(p.hubspot_owner_id),
        // HubSpot wins when it has a value; a link set by hand in the bot's DB is kept while HubSpot's field is blank
        crexi_url: p.crexi_listing_url || prev?.crexi_url || null, ca_link: p.ca_link || prev?.ca_link || null, hub_url: p.listing_hub_url || prev?.hub_url || null,
        om_link: p.om_link || prev?.om_link || null,
      });
      count++;
    }
    after = page.paging?.next?.after;
  } while (after);
  return count;
});
