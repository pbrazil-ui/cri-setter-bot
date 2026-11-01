// Rent roll: rows -> units (tenant names dropped) -> stats computed in code, never by the model.
const ALIASES = {
  space: ['space', 'lot', 'site', 'unit', 'space #', 'lot #', 'site #', 'space number', 'unit #', 'space no', 'lot no', 'site no'],
  type: ['type', 'unit type', 'home type', 'space type', 'category', 'class', 'use'],
  status: ['status', 'occupancy', 'occupied', 'vacant', 'occupied vacant'],
  rent: ['rent', 'lot rent', 'space rent', 'monthly rent', 'current rent', 'base rent', 'amount', 'rent amount', 'monthly'],
  ownership: ['ownership', 'poh toh', 'poh', 'toh', 'home owner', 'owned by', 'home ownership'],
};
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

export function looksLikeRentRoll(headers) {
  const n = headers.map(norm);
  const has = (f) => n.some((h) => ALIASES[f].includes(h));
  return has('space') && has('rent');
}

function mapCols(headers) {
  const map = {};
  for (const h of headers) for (const [f, names] of Object.entries(ALIASES)) if (!map[f] && names.includes(norm(h))) map[f] = h;
  return map;
}
const money = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };

export function normalizeType(raw = '', ownershipRaw = '') {
  const t = `${raw} ${ownershipRaw}`.toLowerCase();
  let unit_type = 'Other';
  if (/\brv\b|recreational|travel trailer|5th wheel|fifth wheel/.test(t)) unit_type = 'RV';
  else if (/park model|\bpm\b|cabin|cottage/.test(t)) unit_type = 'Park Model';
  else if (/\bmh\b|mobile|manufactured|home|poh|toh|\bmhp?\b|coach/.test(t)) unit_type = 'MH';
  const ownership = /\bpoh\b|park[- ]owned/.test(t) ? 'POH' : /\btoh\b|tenant[- ]owned|resident[- ]owned/.test(t) ? 'TOH' : null;
  return { unit_type, ownership };
}

/** rows: array of objects (from CSV/XLSX) or model-extracted {space,type,ownership,status,rent}. */
export function rowsToUnits(rows) {
  if (!rows.length) return [];
  const structured = 'rent' in rows[0] && !Object.keys(rows[0]).some((k) => k !== k.toLowerCase());
  const map = structured ? { space: 'space', type: 'type', status: 'status', rent: 'rent', ownership: 'ownership' } : mapCols(Object.keys(rows[0]));
  return rows
    .map((r) => {
      const rent = money(r[map.rent]);
      const statusRaw = String(r[map.status] ?? '').toLowerCase();
      const occupied = statusRaw ? !/vac|empty|avail|open|down/.test(statusRaw) : rent !== null && rent > 0;
      return { space: String(r[map.space] ?? '').trim() || null, ...normalizeType(r[map.type], r[map.ownership]), occupied, rent };
    })
    .filter((u) => u.space && !/^total|^grand/i.test(u.space));
}

const r2 = (n) => Math.round(n * 100) / 100;
export function rentRollStats(units) {
  if (!units.length) return { available: false };
  const group = (list) => {
    const occ = list.filter((u) => u.occupied);
    const rents = occ.map((u) => u.rent).filter((r) => r !== null && r > 0);
    const sum = rents.reduce((a, b) => a + b, 0);
    return {
      spaces: list.length, occupied: occ.length, vacant: list.length - occ.length,
      occupancy_pct: list.length ? r2((occ.length / list.length) * 100) : 0,
      avg_rent_occupied: rents.length ? r2(sum / rents.length) : null,
      min_rent: rents.length ? Math.min(...rents) : null, max_rent: rents.length ? Math.max(...rents) : null,
      monthly_in_place_rent: r2(sum),
    };
  };
  const by_type = {};
  for (const t of [...new Set(units.map((u) => u.unit_type))]) by_type[t] = group(units.filter((u) => u.unit_type === t));
  const total = group(units);
  return {
    available: true,
    total,
    by_type,
    ownership: { POH: units.filter((u) => u.ownership === 'POH').length, TOH: units.filter((u) => u.ownership === 'TOH').length, unknown: units.filter((u) => !u.ownership).length },
    annualized_in_place_rent: r2(total.monthly_in_place_rent * 12),
    notes: 'Computed from the seller rent roll. Rent averages use occupied spaces with rent > 0. Annualized = monthly x 12 (not a T12).',
  };
}
