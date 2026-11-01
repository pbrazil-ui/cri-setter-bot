import { db } from './db/index.js';

const STOP = new Set(['the', 'a', 'of', 'and', '&', 'mobile', 'home', 'homes', 'park', 'mhp', 'mhc', 'rv', 'resort', 'community', 'ca', 'or', 'llc']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

// Words that mark a name segment as a property, not a person.
const PROPERTY_WORDS = /\b(park|parks|mhp|mhc|rv|resort|estates?|court|ct|village|gardens?|portfolio|ranch|retreat|marina|community|trailer|homes?|apartments?|plaza|center|warehouse|lots?|land|motel|storage|manor|acres|terrace|grove|haven|meadows?|springs?|shores?|creek|valley|hills?|heights|lake|view|redevelopment|fourplex|units?)\b/i;
const PERSON = /^[A-Z][a-z'.]+(?:\s+(?:&|and)\s+[A-Z][a-z'.]+)?(?:\s+[A-Z][a-z'.]+){1,2}$/;
const INTERNAL_PARENS = /\s*\((?:relisting|off-?market|bov|not for sale[^)]*)\)/gi;

/**
 * The name a buyer may see. HubSpot deal names often carry the seller ("Boon Chan - Hacienda Mobile Park",
 * "Arlington Heights MHP - Logan Taylor") or internal tags ("(Relisting)"). Seller identity is confidential:
 * drop any " - " / " | " segment that reads as a person's name, as long as a property segment remains.
 */
export function publicListingName(name) {
  const raw = String(name || '').replace(INTERNAL_PARENS, '').replace(/[​]/g, '').trim();
  const parts = raw.split(/\s+[-–—|]\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return raw;
  const keep = parts.filter((p) => !(PERSON.test(p) && !PROPERTY_WORDS.test(p) && !/[,\d]/.test(p)));
  return (keep.length ? keep : parts).join(' - ');
}

const RANK = { active: 0, in_escrow: 1, closed: 2 };

/** Match a free-text property name (and optional Crexi URL) to a listing. Returns listing or null. */
export async function matchListing(propertyName, { crexiUrl } = {}) {
  // on a tie, an active listing beats one under contract or closed with a similar name
  const listings = (await db.listListings()).sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
  if (crexiUrl) {
    const id = crexiUrl.match(/properties\/(\d+)/)?.[1];
    const hit = listings.find((l) => l.crexi_url && (l.crexi_url === crexiUrl || (id && l.crexi_url.includes(`/${id}`))));
    if (hit) return hit;
  }
  if (!propertyName) return null;
  const want = new Set(tokens(propertyName));
  if (!want.size) return null;
  let best = null; let bestScore = 0;
  for (const l of listings) {
    for (const name of [l.name, ...(l.aliases || []), l.listing_code]) {
      const have = new Set(tokens(name));
      const overlap = [...want].filter((w) => have.has(w)).length;
      const score = overlap / Math.max(want.size, 1);
      if (score > bestScore) { bestScore = score; best = l; }
    }
  }
  return bestScore >= 0.5 ? best : null;
}

const STRICT = { active: 0, in_escrow: 1, closed: 2 };
/** The most restrictive of several listing statuses (closed > in_escrow > active). Unknown/null values are ignored. */
export const mostRestrictive = (...statuses) => statuses.filter((s) => s in STRICT).sort((a, b) => STRICT[b] - STRICT[a])[0] || 'active';

export const isAvailable = (listing) => !listing || !listing.status || listing.status === 'active';
export const availabilityPhrase = (listing) => (listing?.status === 'closed' ? 'sold' : 'under contract');
