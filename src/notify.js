import { config } from './config.js';
import { sendSms } from './ringcentral.js';

export const ownerLog = []; // tests read this

/** Text Pierce. Never blocked by lead guardrails. */
export async function notifyOwner(text) {
  ownerLog.push(text);
  if (!config.owner.phone) { console.log('[owner]', text); return; }
  // labeled: in a TEST, Pierce's cell is also the "buyer", so alerts must be unmistakable (buyers never get these)
  try { await sendSms(config.owner.phone, `[CRI bot] ${text}`.slice(0, 1000)); } catch (e) { console.error('[notifyOwner]', e.message); }
}

export const leadLabel = (lead) => {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.phone || lead.email || `Lead ${lead.id}`;
  return `L${lead.id} ${name}${lead.property_name ? ` (${lead.property_name})` : ''}`;
};
