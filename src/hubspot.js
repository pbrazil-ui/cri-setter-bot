// HubSpot sync: contacts, one Buyers-pipeline deal per buyer per listing, notes, and listing import.
// Every function is a no-op when HUBSPOT_TOKEN is not set. Failures are logged, never thrown,
// so a HubSpot outage never stops a lead from getting a text back.
import { config } from './config.js';
import { mostRestrictive } from './listings.js';
import { db } from './db/index.js';
import { now } from './clock.js';

const hs = config.hubspot;
const S = hs.stages;
const enabled = () => !!hs.token;

export const hubspotLog = []; // for tests / debugging
async function api(method, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${hs.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}
const safe = (fn) => async (...args) => {
  if (!enabled()) return null;
  try { return await fn(...args); } catch (e) { console.error('[hubspot]', e.message); return null; }
};

// ---------- stage logic (pure, unit-tested) ----------
const RANK = { [S.newBuyer]: 0, [S.qualified]: 1, [S.offerOut]: 2, [S.underContract]: 3, [S.won]: 4, [S.lost]: -1 };
const HUMAN_STAGES = new Set([S.offerOut, S.underContract, S.won]);

const dealIdFor = async (lead) => {
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  return lead.hubspot_deals?.[dealKey(lead, listing)] || null;
};

/**
 * A HubSpot task for Pierce (the bot can't call). Deduped per lead by `key`. Returns the task id, or null if HubSpot
 * is off or the call failed (the caller then texts Pierce instead, so the reminder is never lost).
 */
export const createTask = safe(async (leadId, { key, subject, body, dueAt, type = 'CALL', priority = 'HIGH' }) => {
  const lead = await db.getLead(leadId);
  if (lead.hubspot_tasks?.[key]) return lead.hubspot_tasks[key];
  const contactId = lead.hubspot_contact_id || (await upsertContact(lead));
  const dealId = await dealIdFor(lead);
  const associations = [];
  if (contactId) associations.push({ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] });
  if (dealId) associations.push({ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] });
  const t = await api('POST', '/crm/v3/objects/tasks', {
    properties: {
      hs_timestamp: dueAt, hs_task_subject: subject, hs_task_body: body, hs_task_status: 'NOT_STARTED',
      hs_task_priority: priority, hs_task_type: type, ...(hs.ownerId ? { hubspot_owner_id: hs.ownerId } : {}),
    },
    associations,
  });
  await db.updateLead(leadId, { hubspot_tasks: { ...(lead.hubspot_tasks || {}), [key]: t.id } });
  hubspotLog.push({ op: 'task', leadId, key, subject });
  return t.id;
});

/** The deal's "Next step" field: every lead always shows what happens next and when. */
export const setNextStep = safe(async (leadId, text) => {
  const lead = await db.getLead(leadId);
  const dealId = lead && (await dealIdFor(lead));
  if (dealId) await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { hs_next_step: text.slice(0, 250) } });
  hubspotLog.push({ op: 'next_step', leadId, text });
  return true;
});

/** Read-only: token works for contacts and deals, and both pipelines are reachable. */
export async function hubspotCheck() {
  if (!enabled()) return { ok: false, problems: ['HUBSPOT_TOKEN not set'] };
  const one = (pipeline) => api('POST', '/crm/v3/objects/deals/search', { filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipeline }] }], limit: 1 });
  const [buyers, sellers] = await Promise.all([one(hs.buyersPipeline), one(hs.sellersPipeline)]);
  await api('GET', '/crm/v3/objects/contacts?limit=1');
  const problems = [];
  if (!sellers.total) problems.push(`Sellers pipeline ${hs.sellersPipeline} has no deals visible to this token`);
  return { ok: !problems.length, buyers_deals: buyers.total, sellers_deals: sellers.total, problems };
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
export const upsertContact = safe(async (lead) => {
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
});

// ---------- buyer deals ----------
const dealKey = (lead, listing) => listing?.listing_code || listing?.hubspot_deal_id || lead.property_name || 'general';

export const ensureBuyerDeal = safe(async (lead, listing) => {
  if (!hs.createDeals) return null;
  const key = dealKey(lead, listing);
  const existing = lead.hubspot_deals?.[key];
  if (existing) return existing;
  const contactId = await upsertContact(lead);
  if (!contactId) return null;

  // reuse a deal Pierce (or another workflow) already made for this buyer + listing
  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: hs.buyersPipeline },
    { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
  ];
  if (listing?.listing_code) filters.push({ propertyName: 'listing_code', operator: 'EQ', value: listing.listing_code });
  const found = await api('POST', '/crm/v3/objects/deals/search', { filterGroups: [{ filters }], properties: ['dealname', 'dealstage'], limit: 1 });
  let dealId = found?.results?.[0]?.id;

  if (!dealId) {
    const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.company || lead.phone || lead.email;
    const props = {
      dealname: `${who} – ${listing?.name || lead.property_name || 'Buyer inquiry'}`,
      pipeline: hs.buyersPipeline,
      dealstage: S.newBuyer,
      ...(listing?.listing_code ? { listing_code: listing.listing_code } : {}),
      ...(hs.ownerId ? { hubspot_owner_id: hs.ownerId } : {}),
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
});

/** Call after any lead status change. Moves the buyer deal per decideStageMove. */
export const syncDealStage = safe(async (leadId) => {
  const lead = await db.getLead(leadId);
  if (!lead) return null;
  const listing = lead.listing_id ? await db.getListing(lead.listing_id) : null;
  const dealId = lead.hubspot_deals?.[dealKey(lead, listing)] || (await ensureBuyerDeal(lead, listing));
  if (!dealId) return null;
  const deal = await api('GET', `/crm/v3/objects/deals/${dealId}?properties=dealstage`);
  const move = decideStageMove(deal?.properties?.dealstage, lead.status);
  if (!move) return null;
  const properties = { dealstage: move.stage };
  if (move.lostReason) Object.assign(properties, { lost_reason_category: move.lostReason, closed_lost_reason: move.detail });
  await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties });
  hubspotLog.push({ op: 'deal_stage', leadId, dealId, ...properties });
  return properties;
});

/** Timeline note on the contact (and the deal if one exists). */
export const addNote = safe(async (leadId, body) => {
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
});

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
  const props = ['dealname', 'dealstage', 'listing_code', 'listing_status', 'crexi_listing_url', 'ca_link', 'listing_hub_url'];
  const st = hs.sellerStages;
  const existing = new Map((await db.listListings()).map((l) => [l.hubspot_deal_id, l]));
  let after; let count = 0;
  do {
    const page = await api('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [
        { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: hs.sellersPipeline }, { propertyName: 'dealstage', operator: 'IN', values: [st.listed, st.underContract, st.closedWon] }] },
        { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: hs.sellersPipeline }, { propertyName: 'listing_status', operator: 'IN', values: ['on_market', 'off_market', 'under_contract', 'sold'] }] },
      ],
      properties: props, limit: 100, after,
    });
    for (const d of page.results || []) {
      const p = d.properties;
      const hsStatus = listingStatusFor(p);
      if (!hsStatus) continue;
      const prev = existing.get(d.id);
      // a folder in Dropbox "02 - Under Contract" keeps it under contract even if HubSpot still says Listed
      const status = mostRestrictive(hsStatus, prev?.facts?.dropbox_stage === 'under_contract' ? 'in_escrow' : null);
      await db.upsertListing({
        hubspot_deal_id: d.id, listing_code: p.listing_code || null, name: p.dealname, // no code -> buyer deals key on hubspot_deal_id
        status,
        crexi_url: p.crexi_listing_url || null, ca_link: p.ca_link || null, hub_url: p.listing_hub_url || null,
      });
      count++;
    }
    after = page.paging?.next?.after;
  } while (after);
  return count;
});
