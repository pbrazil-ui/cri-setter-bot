// Permission-policy engine. Every outbound message is classified into a policy key and resolved to
// auto | approve | block. The file is playbook/policies.json; PAUSE/RESUME from Pierce's phone and
// the emergency_stop flag override everything. Evaluated in deliver(); the model never sees this.
import { readFileSync } from 'node:fs';
import { db } from './db/index.js';
import { now } from './clock.js';

const path = new URL('../playbook/policies.json', import.meta.url);
let cache = null; let loadedAt = 0; let pinned = false;
export function policies() {
  if (!pinned && (!cache || Date.now() - loadedAt > 60e3)) {
    cache = JSON.parse(readFileSync(path, 'utf8')); loadedAt = Date.now();
    if (process.env.POLICY_TEST_MODE !== undefined) cache.test_mode = ['1', 'true'].includes(process.env.POLICY_TEST_MODE); // env wins over file
    if (process.env.POLICY_EMERGENCY_STOP !== undefined) cache.emergency_stop = ['1', 'true'].includes(process.env.POLICY_EMERGENCY_STOP);
  }
  return cache;
}
export const _setPoliciesForTest = (p) => { cache = p; pinned = true; };

/** Map a delivery to its policy key. */
export function classify({ kind, lead, flags = {}, decision = {}, human = false }) {
  const email = lead.preferred_channel === 'email' || (!lead.phone && lead.email);
  if (kind === 'first_touch') return email ? 'first_touch.email' : `first_touch.${lead.source || 'manual'}`;
  if (kind === 'followup') return lead.status === 'in_dd' ? 'followup.in_dd' : 'followup.pre_ca';
  if (kind === 'answer') return 'answer.from_pierce';
  if (kind === 'approved' || kind === 'owner_edit') return null; // Pierce already decided
  // replies
  if (human || decision.action === 'escalate') return 'escalate.price_terms_legal';
  if (email) return 'reply.email';
  if (flags.usedSensitive) return 'reply.sensitive_docs';
  if (decision.action === 'ask_pierce') return 'reply.holding';
  if (decision.source === 'qa_bank') return 'reply.from_approved_answers';
  if (flags.links?.length) return 'reply.document_link';
  if (decision.action === 'send_booking_link' || decision.action === 'booked') return 'reply.scheduling';
  if (flags.usedCaDocs) return 'reply.ca_docs';
  return 'reply.public_facts';
}

/**
 * Resolve to { mode: 'auto'|'approve'|'block', policy, reason }.
 * Order: emergency stop → PAUSE → test mode → policy table → hourly auto-send budget.
 */
export async function resolve(key, { countAutoSendsLastHour } = {}) {
  const p = policies();
  if (p.emergency_stop) return { mode: 'block', policy: key, reason: 'emergency_stop' };
  if ((await db.getSetting('paused')) === true) return { mode: 'approve', policy: key, reason: 'bot paused' };
  if (key === null) return { mode: 'auto', policy: 'owner_decided', reason: 'approved by Pierce' };
  const rule = p.policies[key] || { mode: 'approve', why: 'no policy for this case' };
  if (p.test_mode && rule.mode === 'auto') return { mode: 'approve', policy: key, reason: 'test mode' };
  if (rule.mode === 'auto' && countAutoSendsLastHour !== undefined && countAutoSendsLastHour >= (p.limits.max_auto_sends_per_hour ?? Infinity)) {
    return { mode: 'approve', policy: key, reason: 'hourly auto-send budget reached' };
  }
  return { mode: rule.mode, policy: key, reason: rule.why || '' };
}

export const limits = () => policies().limits;

/** Audit trail: one row per significant action. Never throws. */
export async function audit(event, { leadId = null, actor = 'bot', detail = {} } = {}) {
  try { await db.insertAudit({ created_at: now().toISOString(), event, lead_id: leadId, actor, detail }); } catch (e) { console.error('[audit]', e.message); }
}
