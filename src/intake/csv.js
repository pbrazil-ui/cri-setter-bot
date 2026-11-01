// Bulk import: Crexi "Export Lead Report" CSV, a HubSpot export, or any spreadsheet of leads.
import { upsertIncomingLead } from './common.js';

const ALIASES = {
  first_name: ['first name', 'firstname', 'first', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  full_name: ['name', 'full name', 'lead name', 'contact name', 'contact', 'user name'],
  email: ['email', 'email address', 'e mail', 'contact email', 'user email'],
  phone: ['phone', 'phone number', 'mobile', 'mobile phone', 'mobile phone number', 'cell', 'cell phone', 'contact phone', 'phone 1', 'direct phone', 'user phone'],
  company: ['company', 'company name', 'organization', 'firm', 'brokerage'],
  role: ['industry role', 'role', 'title', 'job title', 'investor type', 'user type'],
  property_name: ['property', 'property name', 'listing', 'listing name', 'asset', 'property title', 'listing title', 'asset name'],
  crexi_url: ['listing url', 'property url', 'url', 'link', 'crexi url'],
  platform: ['source', 'lead source', 'platform', 'channel'],
  inquiry: ['message', 'notes', 'comments', 'inquiry', 'activity', 'actions', 'action', 'last activity', 'lead activity', 'interest level'],
};
/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF, BOM. */
export function parseCsv(input) {
  const s = String(input).replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function mapHeaders(headers) {
  const map = {};
  for (const h of headers) {
    const n = norm(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (!map[field] && names.includes(n)) { map[field] = h; break; }
    }
  }
  return map;
}

export function parseLeadsCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  if (!rows.length) return { rows: [], map: {} };
  const map = mapHeaders(Object.keys(rows[0]));
  const out = rows.map((r) => {
    const get = (f) => (map[f] ? r[map[f]] : undefined);
    let first = get('first_name'); let last = get('last_name');
    if (!first && !last && get('full_name')) { const parts = get('full_name').trim().split(/\s+/); first = parts[0]; last = parts.slice(1).join(' '); }
    return {
      first_name: first, last_name: last, email: get('email'), phone: get('phone'), company: get('company'),
      role: get('role'), property_name: get('property_name'), crexi_url: get('crexi_url'), inquiry: get('inquiry'), platform: get('platform')?.toLowerCase().replace(/[^a-z]/g, '') || undefined, raw: r,
    };
  });
  return { rows: out, map };
}

export async function importCsv(buffer, { defaultProperty } = {}) {
  const { rows, map } = parseLeadsCsv(buffer);
  const summary = { total: rows.length, created: 0, duplicates: 0, no_phone: 0, skipped: 0, columns: map };
  for (const row of rows) {
    if (!row.property_name && defaultProperty) row.property_name = defaultProperty;
    const r = await upsertIncomingLead(row, 'csv', { quiet: true });
    if (r.created) { summary.created++; if (r.lead.status === 'no_phone') summary.no_phone++; }
    else if (r.duplicate) summary.duplicates++;
    else summary.skipped++;
  }
  return summary;
}
