import { config } from '../config.js';
import { db } from '../db/index.js';
import { now } from '../clock.js';
import { normalizePhone } from '../guardrails.js';
import { matchListing } from '../listings.js';
import { notifyOwner, leadLabel } from '../notify.js';
import * as hubspot from '../hubspot.js';
import { publicListingName } from '../listings.js';

const ACTIVE = ['contacted', 'engaged', 'qualified', 'booked', 'escalated', 'human', 'awaiting_approval'];

/** Insert or merge one lead from any intake source. Never sends anything itself. */
export async function upsertIncomingLead(data, source, { quiet = false } = {}) {
  const phone = normalizePhone(data.phone);
  const email = data.email ? String(data.email).trim().toLowerCase() : null;
  if (!phone && !email) return { skipped: 'no_contact_info' };
  if (phone && (await db.isOptedOut(phone))) return { skipped: 'opted_out' };

  const listing = await matchListing(data.property_name, { crexiUrl: data.crexi_url });
  const base = {
    first_name: data.first_name?.trim() || null,
    last_name: data.last_name?.trim() || null,
    email, phone,
    company: data.company?.trim() || null,
    role: data.role?.trim() || null,
    // what the buyer saw on the platform; fall back to the listing's public name (never the seller's name)
    property_name: data.property_name?.trim() || (listing ? publicListingName(listing.name) : null),
    listing_id: listing?.id ?? null,
    listing_code: listing?.listing_code ?? null,
    inquiry: data.inquiry?.trim() || null,
    platform: data.platform || null,
  };

  let lead = (phone && (await db.findLeadByPhone(phone))) || (email && (await db.findLeadByEmail(email)));
  if (lead) {
    const sameProperty = (base.listing_id && lead.listing_id === base.listing_id) || (!base.listing_id && lead.property_name === base.property_name) || !base.property_name;
    const patch = Object.fromEntries(Object.entries(base).filter(([k, v]) => v && !lead[k]));
    if (!sameProperty) Object.assign(patch, { property_name: base.property_name, listing_id: base.listing_id, listing_code: base.listing_code, inquiry: base.inquiry });
    const reopen = !sameProperty && ['disqualified', 'no_response'].includes(lead.status) && lead.phone;
    if (reopen) Object.assign(patch, { status: 'new', followup_count: 0, next_action_at: now().toISOString() });
    if (Object.keys(patch).length) lead = await db.updateLead(lead.id, patch);
    if (!sameProperty) {
      if (!quiet) await hubspot.ensureBuyerDeal(lead, listing);
      if (!quiet && ACTIVE.includes(lead.status)) await notifyOwner(`${leadLabel(lead)} also inquired on ${base.property_name} (already in a thread).`);
    }
    if (!quiet) await hubspot.addNote(lead.id, `New inquiry${base.platform ? ` via ${base.platform}` : ''}: ${base.property_name || ''} ${base.inquiry || ''}`.trim());
    return { lead, duplicate: true, reopened: !!reopen };
  }

  lead = await db.insertLead({
    ...base, source,
    status: phone ? 'new' : 'no_phone',
    auto_send: !!config.autoSend[source],
    // first contact goes out 1-2 minutes after the inquiry lands (config.firstTouchDelay)
    next_action_at: new Date(+now() + 1000 * (config.firstTouchDelay.minSec + Math.random() * Math.max(0, config.firstTouchDelay.maxSec - config.firstTouchDelay.minSec))).toISOString(),
    raw: data.raw ?? null,
  });
  if (!phone && !quiet) {
    await hubspot.ensureBuyerDeal(lead, listing); // still lands in the Buyers pipeline
    await notifyOwner(`New ${base.platform || source} lead, no phone: ${leadLabel(lead)} ${email || ''}. Needs email follow-up.`);
  }
  return { lead, created: true };
}
