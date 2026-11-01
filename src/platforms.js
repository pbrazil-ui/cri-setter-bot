// Listing platforms that send lead-notification emails. Add new ones here.
// label = how the first text names it ("Saw your inquiry on X on LoopNet"); null = don't name a platform.
export const PLATFORMS = [
  { key: 'crexi', label: 'Crexi', match: /crexi/i },
  { key: 'loopnet', label: 'LoopNet', match: /loopnet/i },
  { key: 'rvparkstore', label: 'RVParkStore', match: /rv\s?park\s?store/i },
  { key: 'mhvillage', label: 'MHVillage', match: /mhvillage/i },
  { key: 'mhbay', label: 'MHBay', match: /mhbay/i },
  { key: 'costar', label: 'CoStar', match: /costar/i },
  { key: 'biproxi', label: 'Biproxi', match: /biproxi/i },
  { key: 'website', label: null, match: /hubspot|cribrokerage\.com\/|website form|form submission/i },
];

/** Sender is the most reliable signal, then subject, then body (forwarded emails). */
export function detectPlatform(from = '', subject = '', text = '') {
  for (const field of [from, subject, text]) {
    const hit = PLATFORMS.find((p) => p.match.test(field));
    if (hit) return hit.key;
  }
  return null;
}

export const platformLabel = (key) => PLATFORMS.find((p) => p.key === key)?.label ?? null;
export const platformPhrase = (key) => (platformLabel(key) ? ` on ${platformLabel(key)}` : '');
