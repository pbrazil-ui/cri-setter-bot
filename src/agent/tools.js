// Tools the setter can call mid-conversation. Every access rule is enforced here, not in the prompt.
import { db } from '../db/index.js';
import { calculate } from '../calc.js';
import { viewLink } from '../dropbox.js';
import { visibleTiers } from '../docs/classify.js';
import { searchChunks } from '../docs/search.js';
import { rentRollStats } from '../docs/rentroll.js';
import { priorMentions } from '../docs/history.js';

export const AGENT_TOOLS = [
  { name: 'search_documents', description: "Search this listing's Dropbox documents (OM, income statements, seller Q&A, rules, utilities, permits) for facts. Returns excerpts with source file and tier. Tier 'sensitive' excerpts mean Pierce must approve the reply.", input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'rent_roll_stats', description: 'Exact unit mix (MH / RV / park model), occupancy, POH/TOH and rent figures computed from the latest rent roll. Use this for any unit-count or rent question; never estimate.', input_schema: { type: 'object', properties: {} } },
  { name: 'financial_summary', description: 'Income, expenses, NOI and expense ratio computed from the seller income statements, with any discrepancies found.', input_schema: { type: 'object', properties: {} } },
  { name: 'calculate', description: 'Exact arithmetic, e.g. "4500000 / 172" or "312000 / 4500000 * 100". Use for every number you derive.', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'prior_conversations', description: "Has this topic come up before on this listing in Pierce's past emails or correspondence (e.g. 'seller financing', 'price reduction', 'tour')? Returns excerpts. Use before saying something is or isn't available; answers drawn from this are reviewed by Pierce.", input_schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
  { name: 'list_documents', description: 'Documents you are allowed to send this lead right now (ids + names).', input_schema: { type: 'object', properties: {} } },
  { name: 'get_document_link', description: 'Create a view-only link for one document from list_documents. Put the returned url in your reply.', input_schema: { type: 'object', properties: { document_id: { type: 'number' } }, required: ['document_id'] } },
];

const caLocked = (listing) => ({ locked: true, message: 'Confidential until the CA is signed and Pierce has verified it.', ca_link: listing?.ca_link || null });

/** ctx = { lead, listing, flags: { usedSensitive, links: [], needsAttachment: [] } } */
const offMarket = (listing) => ({
  unavailable: true, status: listing.status,
  message: `This listing is ${listing.status === 'closed' ? 'sold' : 'under contract'}. Do not share its documents, numbers or details. Say so plainly and ask what they're looking for (property type, size, location, price range) so Pierce can share listings that fit.`,
});

export function makeExecutors(ctx) {
  const { lead, listing } = ctx;
  const ex = {
    async search_documents({ query }) {
      if (!listing) return { results: [], note: 'No listing matched for this lead.' };
      const visible = await db.listChunks(listing.id, visibleTiers(lead));
      const hits = searchChunks(visible, query, 5);
      if (hits.some((h) => h.tier === 'sensitive')) ctx.flags.usedSensitive = true;
      if (hits.some((h) => h.tier === 'ca')) ctx.flags.usedCaDocs = true;
      let lockedHits = 0;
      if (!lead.ca_verified) lockedHits = searchChunks(await db.listChunks(listing.id, ['ca', 'sensitive']), query, 5).length;
      return {
        results: hits.map((h) => ({ file: h.filename, tier: h.tier, excerpt: h.content.slice(0, 900) })),
        ...(lockedHits ? { locked_results: lockedHits, ...caLocked(listing) } : {}),
      };
    },
    async rent_roll_stats() {
      if (!listing) return { available: false };
      if (!lead.ca_verified) return caLocked(listing);
      ctx.flags.usedCaDocs = true;
      const units = await db.listRentRoll(listing.id);
      return units.length ? rentRollStats(units) : { available: false, note: 'No rent roll in Dropbox for this listing yet.' };
    },
    async financial_summary() {
      if (!listing) return { available: false };
      if (!lead.ca_verified) return caLocked(listing);
      ctx.flags.usedCaDocs = true;
      const docs = (await db.listDocuments(listing.id)).filter((d) => d.extracted?.financial_summary?.available);
      if (!docs.length) return { available: false, note: 'No income statement processed for this listing yet.' };
      return { statements: docs.sort((a, b) => b.filename.localeCompare(a.filename)).slice(0, 3).map((d) => ({ file: d.filename, ...d.extracted.financial_summary })) };
    },
    async calculate({ expression }) {
      try { return { expression, result: calculate(expression) }; } catch (e) { return { error: e.message }; }
    },
    async prior_conversations({ topic }) {
      if (!listing) return { results: [] };
      const results = await priorMentions(listing.id, topic);
      if (results.length) ctx.flags.usedSensitive = true;
      return { results, note: results.length ? 'Drawn from past correspondence: your reply will be reviewed by Pierce before sending.' : 'Nothing on this topic in past correspondence. If the buyer is asking whether it is available, use ask_pierce rather than assuming.' };
    },
    async list_documents() {
      if (!listing) return { documents: [] };
      const allowed = lead.ca_verified ? ['public', 'ca'] : ['public'];
      const docs = (await db.listDocuments(listing.id)).filter((d) => d.status === 'processed' && allowed.includes(d.tier));
      return {
        documents: docs.map((d) => ({ id: d.id, name: d.filename, type: d.doc_type })),
        ...(!lead.ca_verified ? { note: 'OM, rent roll and financials unlock after the CA.', ca_link: listing.ca_link || null } : {}),
      };
    },
    async get_document_link({ document_id }) {
      const doc = await db.getDocument(Number(document_id));
      const allowed = lead.ca_verified ? ['public', 'ca'] : ['public'];
      if (!doc || doc.listing_id !== listing?.id || !allowed.includes(doc.tier)) return { error: 'Not allowed to send that document to this lead.' };
      try {
        const link = await viewLink(doc.dropbox_id);
        if (!link.public) { ctx.flags.needsAttachment.push(doc); return { ok: false, reason: 'Dropbox policy made this link team-only. Tell the lead it is coming by email; do not include a link.' }; }
        ctx.flags.links.push({ doc: doc.filename, url: link.url });
        return { ok: true, url: link.url, name: doc.filename };
      } catch (e) {
        ctx.flags.needsAttachment.push(doc);
        return { ok: false, reason: `Link failed (${e.message}). Tell the lead it's coming by email.` };
      }
    },
  };
  // Under contract / sold: no documents, numbers or past correspondence for that listing, whatever the CA status.
  if (listing && listing.status && listing.status !== 'active') {
    for (const k of ['search_documents', 'rent_roll_stats', 'financial_summary', 'prior_conversations', 'list_documents', 'get_document_link']) ex[k] = async () => offMarket(listing);
  }
  return ex;
}
