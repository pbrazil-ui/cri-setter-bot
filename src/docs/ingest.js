// One Dropbox file -> document row + searchable chunks (+ rent roll units / T12 line items).
import { db } from '../db/index.js';
import { config } from '../config.js';
import { parseCsv } from '../intake/csv.js';
import { extractDocument } from '../llm.js';
import { looksLikeRentRoll, rowsToUnits, rentRollStats } from './rentroll.js';
import { summarizeFinancials } from './financials.js';
import { chunkText } from './search.js';

const ext = (name) => name.toLowerCase().split('.').pop();

async function sheetsToCsv(buffer, name) {
  if (ext(name) === 'csv') return [buffer.toString('utf8')];
  if (config.dropbox.mode === 'mock') return [buffer.toString('utf8')];
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]));
}

async function docxText(buffer) {
  if (config.dropbox.mode === 'mock') return buffer.toString('utf8');
  const mammoth = await import('mammoth');
  return (await mammoth.extractRawText({ buffer })).value;
}

export const statsToText = (s) => !s.available ? '' : [
  `Rent roll summary: ${s.total.spaces} total spaces, ${s.total.occupied} occupied, ${s.total.vacant} vacant (${s.total.occupancy_pct}% occupied).`,
  ...Object.entries(s.by_type).map(([t, g]) => `${t}: ${g.spaces} spaces, ${g.occupied} occupied, ${g.vacant} vacant, average occupied rent $${g.avg_rent_occupied ?? 'n/a'}/mo.`),
  `Ownership: ${s.ownership.POH} park-owned homes, ${s.ownership.TOH} tenant-owned.`,
  `In-place rent $${s.total.monthly_in_place_rent}/mo, $${s.annualized_in_place_rent}/yr annualized.`,
].join('\n');

/**
 * entry: Dropbox file entry {id, name, path_display, content_hash}; cls: {tier, doc_type}
 * Returns the document row. Never throws for a bad file: records status=failed instead.
 */
export async function ingestFile({ listingId, entry, buffer, cls }) {
  const base = { listing_id: listingId, filename: entry.name, doc_type: cls.doc_type, tier: cls.tier, dropbox_id: entry.id, dropbox_path: entry.path_display, content_hash: entry.content_hash };
  try {
    const e = ext(entry.name);
    let text = ''; let extracted = {}; let summary = ''; let units = null;

    if (['csv', 'xlsx', 'xls'].includes(e)) {
      const sheets = await sheetsToCsv(buffer, entry.name);
      for (const csv of sheets) {
        const rows = parseCsv(csv);
        if (rows.length && looksLikeRentRoll(Object.keys(rows[0]))) { units = rowsToUnits(rows); break; }
      }
      text = sheets.join('\n\n');
    } else if (e === 'docx') text = await docxText(buffer);
    else if (['txt', 'md'].includes(e)) text = buffer.toString('utf8');

    const needsModel = e === 'pdf' || (cls.doc_type === 't12' && !units) || (cls.doc_type === 'rent_roll' && !units);
    if (needsModel) {
      const x = await extractDocument({ filename: entry.name, docType: cls.doc_type, pdf: e === 'pdf' ? buffer : null, text: e === 'pdf' ? null : text.slice(0, 150000) });
      summary = x.summary || '';
      if (x.rent_roll_rows?.length && !units) units = rowsToUnits(x.rent_roll_rows);
      if (x.financials) extracted.financials = x.financials;
      text = [...new Set([summary, ...(x.facts || [])].filter(Boolean))].join('\n');
    }

    if (units) {
      extracted.rent_roll = rentRollStats(units);
      base.doc_type = 'rent_roll';
      const t = statsToText(extracted.rent_roll);
      text = `${t}\n${text}`; summary ||= t.split('\n')[0];
    }
    if (extracted.financials) {
      extracted.financial_summary = summarizeFinancials(extracted.financials);
      const f = extracted.financial_summary;
      if (f.available) text = `Financials ${f.period}: total income $${f.total_income}, expenses $${f.total_expenses}, NOI $${f.noi}.\n${text}`;
    }

    const doc = await db.insertDocument({ ...base, status: 'processed', summary: summary || text.slice(0, 300), extracted });
    if (units && listingId) await db.replaceRentRoll(listingId, doc.id, units);
    await db.insertChunks(chunkText(`[${entry.name}]\n${text}`).map((content) => ({ document_id: doc.id, listing_id: listingId, tier: cls.tier, content })));
    return doc;
  } catch (err) {
    console.error('[ingest]', entry.path_display, err.message);
    return db.insertDocument({ ...base, status: 'failed', summary: `failed: ${err.message}`.slice(0, 300), extracted: {} });
  }
}
