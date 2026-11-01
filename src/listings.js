import { db } from './db/index.js';

const STOP = new Set(['the', 'a', 'of', 'and', '&', 'mobile', 'home', 'homes', 'park', 'mhp', 'mhc', 'rv', 'resort', 'community', 'ca', 'or', 'llc']);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** Match a free-text property name (and optional Crexi URL) to a listing. Returns listing or null. */
export async function matchListing(propertyName, { crexiUrl } = {}) {
  const listings = await db.listListings();
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
