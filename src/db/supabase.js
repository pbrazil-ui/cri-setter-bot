import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { now } from '../clock.js';

const sb = createClient(config.supabase.url, config.supabase.serviceKey, { auth: { persistSession: false } });

const one = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const ts = () => now().toISOString();

export const db = {
  async getSetting(key) { const r = await one(sb.from('settings').select('value').eq('key', key).maybeSingle()); return r?.value ?? null; },
  async setSetting(key, value) { await one(sb.from('settings').upsert({ key, value })); },

  async claimEvent(id) {
    const { error } = await sb.from('processed_events').insert({ id });
    if (!error) return true;
    if (error.code === '23505') return false; // duplicate = already handled
    throw error;
  },

  getLead: (id) => one(sb.from('leads').select('*').eq('id', id).maybeSingle()),
  findLeadByPhone: (phone) => one(sb.from('leads').select('*').eq('phone', phone).maybeSingle()),
  async findLeadByEmail(email) {
    const rows = await one(sb.from('leads').select('*').ilike('email', email).limit(1));
    return rows[0] ?? null;
  },
  insertLead: (lead) => one(sb.from('leads').insert({ ...lead, updated_at: ts() }).select().single()),
  updateLead: (id, patch) => one(sb.from('leads').update({ ...patch, updated_at: ts() }).eq('id', id).select().single()),

  listLeadsForFirstTouch: (limit) => one(
    sb.from('leads').select('*')
      .or('and(status.eq.new,phone.not.is.null),and(status.eq.no_phone,email.not.is.null)')
      .or(`next_action_at.is.null,next_action_at.lte.${ts()}`)
      .order('created_at', { ascending: true }).limit(limit),
  ),
  async listLeadsAwaitingReply() {
    const rows = await one(
      sb.from('leads').select('*').in('status', ['contacted', 'engaged', 'qualified', 'in_dd', 'nurture'])
        .not('last_outbound_at', 'is', null).limit(1000),
    );
    return rows.filter((l) => !l.last_inbound_at || l.last_outbound_at >= l.last_inbound_at);
  },
  async countByStatus() {
    const rows = await one(sb.from('leads').select('status'));
    return rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  },

  insertMessage: (m) => one(sb.from('messages').insert(m).select().single()),
  updateMessage: (id, patch) => one(sb.from('messages').update(patch).eq('id', id).select().single()),
  async listMessages(leadId, limit = 40) {
    const rows = await one(sb.from('messages').select('*').eq('lead_id', leadId).in('status', ['received', 'sent'])
      .order('created_at', { ascending: false }).limit(limit));
    return rows.reverse();
  },
  async countOutboundSince(leadId, sinceIso) {
    const { count, error } = await sb.from('messages').select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId).eq('direction', 'out').eq('status', 'sent').gte('created_at', sinceIso);
    if (error) throw error;
    return count ?? 0;
  },
  listDueScheduled: () => one(sb.from('messages').select('*').eq('status', 'scheduled').lte('send_at', ts()).limit(50)),
  cancelScheduledForLead: (leadId) => one(sb.from('messages').update({ status: 'cancelled' }).eq('lead_id', leadId).eq('status', 'scheduled')),

  async isOptedOut(phone) { if (!phone) return false; const r = await one(sb.from('opt_outs').select('phone').eq('phone', phone).maybeSingle()); return !!r; },
  addOptOut: (phone, reason) => one(sb.from('opt_outs').upsert({ phone, reason })),
  removeOptOut: (phone) => one(sb.from('opt_outs').delete().eq('phone', phone)),

  listListings: () => one(sb.from('listings').select('*').neq('status', 'closed')),
  upsertListing: (l) => one(sb.from('listings').upsert(l, { onConflict: 'hubspot_deal_id' }).select().single()),
  getListing: (id) => one(sb.from('listings').select('*').eq('id', id).maybeSingle()),

  createApproval: (a) => one(sb.from('approvals').insert(a).select().single()),
  getApproval: (id) => one(sb.from('approvals').select('*').eq('id', id).maybeSingle()),
  listPendingApprovals: () => one(sb.from('approvals').select('*').eq('status', 'pending').order('created_at')),
  updateApproval: (id, patch) => one(sb.from('approvals').update(patch).eq('id', id).select().single()),
  updateListing: (id, patch) => one(sb.from('listings').update(patch).eq('id', id).select().single()),

  // documents (listingId null = company SOPs)
  async listDocuments(listingId) {
    const q = sb.from('documents').select('id,listing_id,filename,doc_type,tier,dropbox_id,dropbox_path,content_hash,status,summary,extracted');
    return one(listingId === null ? q.is('listing_id', null) : q.eq('listing_id', listingId));
  },
  insertDocument: (d) => one(sb.from('documents').insert(d).select().single()),
  getDocument: (id) => one(sb.from('documents').select('*').eq('id', id).maybeSingle()),
  deleteDocument: (id) => one(sb.from('documents').delete().eq('id', id)),
  async insertChunks(rows) { if (rows.length) await one(sb.from('doc_chunks').insert(rows)); },
  async listChunks(listingId, tiers) {
    const q = sb.from('doc_chunks').select('id,document_id,tier,content,documents(filename,doc_type)').in('tier', tiers).limit(5000);
    const rows = await one(listingId === null ? q.is('listing_id', null) : q.eq('listing_id', listingId));
    return rows.map((r) => ({ ...r, filename: r.documents?.filename, doc_type: r.documents?.doc_type }));
  },
  async replaceRentRoll(listingId, documentId, units) {
    await one(sb.from('rent_roll_units').delete().eq('listing_id', listingId));
    if (units.length) await one(sb.from('rent_roll_units').insert(units.map((u) => ({ ...u, listing_id: listingId, document_id: documentId }))));
  },
  listRentRoll: (listingId) => one(sb.from('rent_roll_units').select('*').eq('listing_id', listingId)),

  addQa: (q) => one(sb.from('qa_bank').insert(q).select().single()),
  listQa: (listingId) => one(sb.from('qa_bank').select('*').or(`listing_id.is.null${listingId ? `,listing_id.eq.${listingId}` : ''}`).order('created_at', { ascending: false }).limit(200)),
  createOwnerQuestion: (q) => one(sb.from('owner_questions').insert(q).select().single()),
  getOwnerQuestion: (id) => one(sb.from('owner_questions').select('*').eq('id', id).maybeSingle()),
  updateOwnerQuestion: (id, patch) => one(sb.from('owner_questions').update(patch).eq('id', id).select().single()),
  listOpenOwnerQuestions: (leadId) => one(sb.from('owner_questions').select('*').eq('lead_id', leadId).eq('status', 'open')),
  listLeadsReplyDue: () => one(sb.from('leads').select('*').not('reply_due_at', 'is', null).lte('reply_due_at', ts()).limit(50)),

  insertAudit: (row) => one(sb.from('audit_log').insert(row)),
  listAuditSince: (sinceIso) => one(sb.from('audit_log').select('*').gte('created_at', sinceIso).order('created_at').limit(2000)),
  async countAutoSendsSince(sinceIso) {
    const { count, error } = await sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('event', 'sent').eq('actor', 'bot').gte('created_at', sinceIso);
    if (error) throw error; return count ?? 0;
  },
  expireApprovals: (nowIso) => one(sb.from('approvals').update({ status: 'expired', resolved_at: nowIso }).eq('status', 'pending').lt('expires_at', nowIso).select('id,lead_id')),
  listLeadsUpdatedSince: (sinceIso) => one(sb.from('leads').select('*').gte('updated_at', sinceIso).limit(500)),
  listOpenOwnerQuestionsAll: () => one(sb.from('owner_questions').select('*').eq('status', 'open').order('created_at')),

  supersedeApprovalsForLead: (leadId) => one(sb.from('approvals').update({ status: 'superseded', resolved_at: ts() }).eq('lead_id', leadId).eq('status', 'pending')),
};
