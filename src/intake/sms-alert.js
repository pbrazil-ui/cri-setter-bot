// Platform lead alerts that arrive as TEXTS to the RingCentral number, e.g. Crexi from (424) 322-3884:
// "🏢 A potential buyer on www.CREXi.com is interested in Mobile Hacienda Park in Unincorporated -----
//  NAME: Pierce Brazil PHONE: (949) 335-5921 ROLE: Principal Investor, Buyer Rep ACTION: Broker Phone Clicked https://..."
// The sender is the platform, never the buyer: the bot must not reply to it. The buyer in the alert gets the first text.
import { config } from '../config.js';
import { normalizePhone } from '../guardrails.js';
import { upsertIncomingLead } from './common.js';
import { processFirstTouch } from '../agent/setter.js';
import { notifyOwner } from '../notify.js';
import { audit } from '../policy.js';

const field = (text, name, next) => text.match(new RegExp(`${name}:\\s*([\\s\\S]*?)\\s*(?=(?:${next.join('|')}):|https?:\\/\\/|$)`, 'i'))?.[1]?.trim() || null;
const FIELDS = ['NAME', 'PHONE', 'EMAIL', 'ROLE', 'ACTION', 'COMPANY'];

/** Parse a platform alert text. Returns null when the text isn't one. */
export function parsePlatformAlert(text) {
  const t = String(text || '');
  const platform = /crexi/i.test(t) ? 'crexi' : /loopnet/i.test(t) ? 'loopnet' : /rv\s?park\s?store/i.test(t) ? 'rvparkstore' : /mhvillage/i.test(t) ? 'mhvillage' : null;
  if (!platform || !/\bNAME:/i.test(t) || !/\bPHONE:|\bEMAIL:/i.test(t)) return null;
  const others = (f) => FIELDS.filter((x) => x !== f);
  const m = t.match(/interested in\s+(.+?)(?:\s+in\s+([^-\n]+?))?\s*(?:-{3,}|\bNAME:)/i);
  const name = field(t, 'NAME', others('NAME')) || '';
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  const crexiId = t.match(/crexi\.com\/propert(?:y|ies)\/(\d+)/i)?.[1];
  return {
    platform,
    property_name: m?.[1]?.trim() || null,
    city: m?.[2]?.trim() || null,
    first_name: first || null, last_name: rest.join(' ') || null,
    phone: field(t, 'PHONE', others('PHONE')),
    email: field(t, 'EMAIL', others('EMAIL')),
    role: field(t, 'ROLE', others('ROLE')),
    action: field(t, 'ACTION', others('ACTION')),
    company: field(t, 'COMPANY', others('COMPANY')),
    crexi_url: crexiId ? `https://www.crexi.com/properties/${crexiId}` : null,
  };
}

/** Turn an alert into a lead and start first contact (text; asks for their email if the alert has none). */
export async function handlePlatformAlert(fromPhone, text) {
  const a = parsePlatformAlert(text);
  if (!a) return null;
  if (!config.platformAlertNumbers.map(normalizePhone).includes(normalizePhone(fromPhone))) {
    await notifyOwner(`A text shaped like a ${a.platform} lead alert came from ${fromPhone}, which isn't a known alert number, so nobody was texted. If ${a.platform} uses this number now, add it to PLATFORM_ALERT_NUMBERS. Text: "${text.slice(0, 160)}"`);
    return { skipped: 'unknown_alert_sender', alert: a };
  }
  const phone = normalizePhone(a.phone);
  const own = [config.rc.fromNumber, config.owner.phone].map(normalizePhone).filter(Boolean);
  await audit('platform_alert', { detail: { from: fromPhone, platform: a.platform, property: a.property_name, action: a.action } });
  if (phone && own.includes(phone)) {
    await notifyOwner(`${a.platform} alert for ${a.property_name || 'a listing'} lists YOUR number (${a.phone}), so no text was sent. Test with a different phone.`);
    return { skipped: 'own_number', alert: a };
  }
  if (!phone && !a.email) { await notifyOwner(`${a.platform} alert for ${a.property_name || 'a listing'} had no phone or email: "${text.slice(0, 200)}"`); return { skipped: 'no_contact', alert: a }; }
  const r = await upsertIncomingLead({
    first_name: a.first_name, last_name: a.last_name, phone: a.phone, email: a.email, company: a.company, role: a.role,
    property_name: a.property_name, crexi_url: a.crexi_url, platform: a.platform,
    inquiry: [a.action, a.role && `role: ${a.role}`].filter(Boolean).join('; '), raw: { via: 'sms_alert', from: fromPhone },
  }, 'listing_email');
  if (r.created || r.reopened) r.firstTouch = await processFirstTouch(r.lead);
  return { alert: a, ...r };
}
