import { config } from './config.js';
import { db } from './db/index.js';
import { normalizePhone } from './guardrails.js';
import { handleInboundSms } from './agent/setter.js';
import { handleOwnerCommand } from './agent/owner.js';
import { handlePlatformAlert } from './intake/sms-alert.js';
import { now } from './clock.js';

/** Process one RingCentral webhook notification. Exported for tests. */
export async function handleRingCentralEvent(evt) {
  const b = evt?.body;
  if (!b || b.type !== 'SMS' || b.direction !== 'Inbound') return { ignored: true };
  if (!(await db.claimEvent(`rc:${b.id}`))) return { duplicate: true };
  const from = normalizePhone(b.from?.phoneNumber);
  const text = b.subject || '';
  if (!from) return { ignored: 'no_from' };
  if (config.owner.phone && from === normalizePhone(config.owner.phone)) {
    // TEST session: Pierce's cell plays the buyer; "#" in front still sends him a command (#Y12, #ENDTEST)
    const test = await db.getSetting('owner_test');
    const testing = test && new Date(test.expires_at) > now();
    if (testing && !/^\s*#/.test(text)) return handleInboundSms(from, text, String(b.id));
    return handleOwnerCommand(text.replace(/^\s*#\s*/, ''));
  }
  // Crexi/LoopNet lead alerts texted to the RingCentral number: the buyer in the alert is the lead, never the sender
  const alert = await handlePlatformAlert(from, text);
  if (alert) return alert;
  return handleInboundSms(from, text, String(b.id));
}
