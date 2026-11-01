// In-memory store with the same interface as supabase.js. Used for local dev + tests.
import { now } from '../clock.js';

const t = { audit: [], leads: [], messages: [], approvals: [], listings: [], documents: [], chunks: [], units: [], qa: [], oq: [], opt_outs: new Map(), events: new Set(), settings: new Map() };
let seq = 1;
const ts = () => now().toISOString();
const clone = (o) => (o ? structuredClone(o) : null);

export const db = {
  _tables: t,
  _reset() { t.audit = []; t.leads = []; t.messages = []; t.approvals = []; t.listings = []; t.documents = []; t.chunks = []; t.units = []; t.qa = []; t.oq = []; t.opt_outs.clear(); t.events.clear(); t.settings.clear(); seq = 1; },

  async getSetting(k) { return t.settings.get(k) ?? null; },
  async setSetting(k, v) { t.settings.set(k, v); },
  async claimEvent(id) { if (t.events.has(id)) return false; t.events.add(id); return true; },

  async getLead(id) { return clone(t.leads.find((l) => l.id === id)); },
  async findLeadByPhone(p) { return clone(t.leads.find((l) => l.phone && l.phone === p)); },
  async findLeadByEmail(e) { return clone(t.leads.find((l) => l.email && l.email.toLowerCase() === e.toLowerCase())); },
  async insertLead(lead) {
    if (lead.phone && t.leads.some((l) => l.phone === lead.phone)) throw Object.assign(new Error('duplicate phone'), { code: '23505' });
    const row = { id: seq++, created_at: ts(), updated_at: ts(), status: 'new', auto_send: false, qualification: {}, hubspot_deals: {}, followup_count: 0, ca_verified: false, preferred_channel: 'sms', ...lead };
    t.leads.push(row); return clone(row);
  },
  async updateLead(id, patch) { const l = t.leads.find((x) => x.id === id); Object.assign(l, patch, { updated_at: ts() }); return clone(l); },
  async listLeadsForFirstTouch(limit) {
    return t.leads.filter((l) => ((l.status === 'new' && l.phone) || (l.status === 'no_phone' && l.email)) && (!l.next_action_at || l.next_action_at <= ts())).slice(0, limit).map(clone);
  },
  async listLeadsAwaitingReply() {
    return t.leads.filter((l) => ['contacted', 'engaged', 'qualified', 'in_dd'].includes(l.status) && l.last_outbound_at && (!l.last_inbound_at || l.last_outbound_at >= l.last_inbound_at)).map(clone);
  },
  async countByStatus() { return t.leads.reduce((a, l) => ({ ...a, [l.status]: (a[l.status] || 0) + 1 }), {}); },

  async insertMessage(m) { const row = { id: seq++, created_at: ts(), ...m }; t.messages.push(row); return clone(row); },
  async updateMessage(id, patch) { const m = t.messages.find((x) => x.id === id); Object.assign(m, patch); return clone(m); },
  async listMessages(leadId, limit = 40) { return t.messages.filter((m) => m.lead_id === leadId && ['received', 'sent'].includes(m.status)).slice(-limit).map(clone); },
  async countOutboundSince(leadId, since) { return t.messages.filter((m) => m.lead_id === leadId && m.direction === 'out' && m.status === 'sent' && m.created_at >= since).length; },
  async listDueScheduled() { return t.messages.filter((m) => m.status === 'scheduled' && m.send_at <= ts()).map(clone); },
  async cancelScheduledForLead(leadId) { t.messages.filter((m) => m.lead_id === leadId && m.status === 'scheduled').forEach((m) => { m.status = 'cancelled'; }); },

  async isOptedOut(p) { return !!p && t.opt_outs.has(p); },
  async addOptOut(p, reason) { t.opt_outs.set(p, { reason, created_at: ts() }); },
  async removeOptOut(p) { t.opt_outs.delete(p); },

  async listListings() { return t.listings.filter((l) => l.status !== 'closed').map(clone); },
  async getListing(id) { return clone(t.listings.find((l) => l.id === id)); },
  async upsertListing(l) {
    const ex = t.listings.find((x) => x.hubspot_deal_id && x.hubspot_deal_id === l.hubspot_deal_id);
    if (ex) { Object.assign(ex, l); return clone(ex); }
    return db._addListing(l);
  },
  async _addListing(l) { const row = { id: seq++, status: 'active', aliases: [], facts: {}, ...l }; t.listings.push(row); return clone(row); },

  async createApproval(a) { const row = { id: seq++, created_at: ts(), status: 'pending', on_send: {}, ...a }; t.approvals.push(row); return clone(row); },
  async getApproval(id) { return clone(t.approvals.find((a) => a.id === id)); },
  async listPendingApprovals() { return t.approvals.filter((a) => a.status === 'pending').map(clone); },
  async updateApproval(id, patch) { const a = t.approvals.find((x) => x.id === id); Object.assign(a, patch); return clone(a); },
  async updateListing(id, patch) { const l = t.listings.find((x) => x.id === id); Object.assign(l, patch); return clone(l); },

  async listDocuments(listingId) { return t.documents.filter((d) => (d.listing_id ?? null) === listingId).map(clone); },
  async insertDocument(d) { const row = { id: seq++, created_at: ts(), ...d }; t.documents.push(row); return clone(row); },
  async getDocument(id) { return clone(t.documents.find((d) => d.id === id)); },
  async deleteDocument(id) { t.documents = t.documents.filter((d) => d.id !== id); t.chunks = t.chunks.filter((c) => c.document_id !== id); t.units = t.units.filter((u) => u.document_id !== id); },
  async insertChunks(rows) { rows.forEach((r) => t.chunks.push({ id: seq++, ...r })); },
  async listChunks(listingId, tiers) {
    return t.chunks.filter((c) => (c.listing_id ?? null) === listingId && tiers.includes(c.tier))
      .map((c) => { const d = t.documents.find((x) => x.id === c.document_id); return { ...clone(c), filename: d?.filename, doc_type: d?.doc_type }; });
  },
  async replaceRentRoll(listingId, documentId, units) { t.units = t.units.filter((u) => u.listing_id !== listingId); units.forEach((u) => t.units.push({ id: seq++, ...u, listing_id: listingId, document_id: documentId })); },
  async listRentRoll(listingId) { return t.units.filter((u) => u.listing_id === listingId).map(clone); },

  async addQa(q) { const row = { id: seq++, created_at: ts(), ...q }; t.qa.push(row); return clone(row); },
  async listQa(listingId) { return t.qa.filter((q) => q.listing_id == null || q.listing_id === listingId).map(clone); },
  async createOwnerQuestion(q) { const row = { id: seq++, created_at: ts(), status: 'open', ...q }; t.oq.push(row); return clone(row); },
  async getOwnerQuestion(id) { return clone(t.oq.find((q) => q.id === id)); },
  async updateOwnerQuestion(id, patch) { const q = t.oq.find((x) => x.id === id); Object.assign(q, patch); return clone(q); },
  async listOpenOwnerQuestions(leadId) { return t.oq.filter((q) => q.lead_id === leadId && q.status === 'open').map(clone); },
  async listLeadsReplyDue() { return t.leads.filter((l) => l.reply_due_at && l.reply_due_at <= ts()).map(clone); },

  async insertAudit(row) { t.audit.push({ id: seq++, ...row }); },
  async listAuditSince(since) { return t.audit.filter((a) => a.created_at >= since).map(clone); },
  async countAutoSendsSince(since) { return t.audit.filter((a) => a.event === 'sent' && a.actor === 'bot' && a.created_at >= since).length; },
  async expireApprovals(nowIso) { const hit = t.approvals.filter((a) => a.status === 'pending' && a.expires_at && a.expires_at < nowIso); hit.forEach((a) => { a.status = 'expired'; a.resolved_at = nowIso; }); return hit.map(clone); },
  async listLeadsUpdatedSince(since) { return t.leads.filter((l) => l.updated_at >= since).map(clone); },
  async listOpenOwnerQuestionsAll() { return t.oq.filter((q) => q.status === 'open').map(clone); },

  async supersedeApprovalsForLead(leadId) { t.approvals.filter((a) => a.lead_id === leadId && a.status === 'pending').forEach((a) => { a.status = 'superseded'; a.resolved_at = ts(); }); },
};
