import { readFileSync } from 'node:fs';

export const rules = JSON.parse(readFileSync(new URL('../../playbook/dropbox-rules.json', import.meta.url), 'utf8'));
const compiled = rules.rules.map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));

/** relPath = path inside the listing folder. Returns { tier, doc_type, why }. */
export function classifyFile(relPath, sizeBytes = 0) {
  if (sizeBytes > rules.max_file_mb * 1024 * 1024) return { tier: 'exclude', why: 'too large' };
  const hit = compiled.find((r) => r.re.test(relPath));
  return { tier: hit.tier, doc_type: hit.doc_type || 'other', why: hit.why };
}

/** True if a file at this path (inside the listing folder) must never be in a buyer data room (rules with data_room_block). */
export function blocksDataRoom(relPath) {
  return Boolean(compiled.find((r) => r.re.test(relPath))?.data_room_block);
}

export const TIER_ORDER = { public: 0, ca: 1, sensitive: 2, internal: 3 };
/** Which tiers a lead may see. Sensitive chunks are readable but flagged so the answer goes to Pierce. */
export const visibleTiers = (lead) => (lead?.ca_verified ? ['public', 'ca', 'sensitive'] : ['public']);
