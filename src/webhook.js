import { config } from './config.js';
import { db } from './db/index.js';
import { normalizePhone } from './guardrails.js';
import { handleInboundSms } from './agent/setter.js';
import { handleOwnerCommand } from './agent/owner.js';

/** Process one RingCentral webhook notification. Exported for tests. */
export async function handleRingCentralEvent(evt) {
  const b = evt?.body;
  if (!b || b.type !== 'SMS' || b.direction !== 'Inbound') return { ignored: true };
  if (!(await db.claimEvent(`rc:${b.id}`))) return { duplicate: true };
  const from = normalizePhone(b.from?.phoneNumber);
  const text = b.subject || '';
  if (!from) return { ignored: 'no_from' };
  if (config.owner.phone && from === normalizePhone(config.owner.phone)) return handleOwnerCommand(text);
  return handleInboundSms(from, text, String(b.id));
}
