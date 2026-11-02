import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const mockOutbox = []; // used in SMS_MODE=mock and tests
export const mockSmsFailures = new Map(); // SMS_MODE=mock only: phone -> error message the send throws (tests)

const EVENT_FILTER = '/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS';
let platformPromise = null;

async function platform() {
  if (!platformPromise) {
    const { SDK } = await import('@ringcentral/sdk');
    const sdk = new SDK({ server: config.rc.server, clientId: config.rc.clientId, clientSecret: config.rc.clientSecret });
    const p = sdk.platform();
    platformPromise = p.login({ jwt: config.rc.jwt }).then(() => p).catch((e) => { platformPromise = null; throw e; });
  }
  return platformPromise;
}

export async function sendSms(to, text) {
  if (config.smsMode === 'mock') {
    if (mockSmsFailures.has(to)) throw new Error(mockSmsFailures.get(to));
    const id = `mock-${mockOutbox.length + 1}`;
    mockOutbox.push({ id, to, text });
    if (process.env.NODE_ENV !== 'test') console.log(`[mock sms -> ${to}] ${text}`);
    return { id };
  }
  const p = await platform();
  const res = await p.post('/restapi/v1.0/account/~/extension/~/sms', {
    from: { phoneNumber: config.rc.fromNumber },
    to: [{ phoneNumber: to }],
    text,
  });
  return res.json();
}

/** Create or renew the webhook subscription for inbound SMS. Run on boot and every 12h. */
/** Read-only: logs in, confirms RC_FROM_NUMBER is on this account with SMS enabled, and the webhook is active. */
export async function rcCheck() {
  if (config.smsMode === 'mock') return { mode: 'mock' };
  const p = await platform();
  const ext = await (await p.get('/restapi/v1.0/account/~/extension/~')).json();
  const nums = (await (await p.get('/restapi/v1.0/account/~/extension/~/phone-number', { perPage: 100 })).json()).records || [];
  const from = nums.find((n) => n.phoneNumber === config.rc.fromNumber);
  const subs = ((await (await p.get('/restapi/v1.0/subscription')).json()).records || []).filter((s) => s.deliveryMode?.address === webhookAddress());
  const problems = [];
  if (!from) problems.push(`RC_FROM_NUMBER ${config.rc.fromNumber} is not on extension ${ext.extensionNumber} (numbers: ${nums.map((n) => n.phoneNumber).join(', ') || 'none'})`);
  else if (!(from.features || []).includes('SmsSender')) problems.push(`${config.rc.fromNumber} is not SMS-enabled (features: ${(from.features || []).join(', ')})`);
  if (!subs.some((s) => s.status === 'Active')) problems.push('no active inbound-SMS webhook for PUBLIC_URL yet (created on boot; check PUBLIC_URL and redeploy)');
  return { ok: !problems.length, extension: ext.name, from: config.rc.fromNumber, webhook: subs.map((s) => `${s.status} until ${s.expirationTime}`), problems };
}

/**
 * The inbound-SMS webhook is public, and owner commands are recognized by the sender's number, so a forged POST could
 * pose as Pierce. Every request must carry a secret: RC_VERIFICATION_TOKEN as RingCentral's Verification-Token header
 * when set, and always a key in the webhook URL derived from INGEST_SECRET (works with no extra setup).
 */
export const webhookKey = () => createHmac('sha256', config.ingestSecret || 'unset').update('rc-webhook-v1').digest('hex').slice(0, 32);
export const webhookAddress = () => `${config.publicUrl}/webhooks/ringcentral?k=${webhookKey()}`;
export function webhookAuthorized(req) {
  if (config.rc.verificationToken && req.get('Verification-Token') !== config.rc.verificationToken) return false;
  const k = String(req.query?.k || '');
  const want = webhookKey();
  return k.length === want.length && timingSafeEqual(Buffer.from(k), Buffer.from(want));
}

export async function ensureSubscription() {
  if (config.smsMode === 'mock') return { mock: true };
  const p = await platform();
  const base = `${config.publicUrl}/webhooks/ringcentral`;
  const address = webhookAddress();
  const list = await (await p.get('/restapi/v1.0/subscription')).json();
  const ours = (list.records || []).filter((s) => String(s.deliveryMode?.address || '').startsWith(base));
  const exact = ours.filter((s) => s.deliveryMode?.address === address);
  // stale ones (old address without the key, or a previous key) are removed only AFTER a working one exists,
  // so inbound texts never go dark during the switch
  const dropStale = async (keepId) => { for (const s of ours) if (s.id !== keepId) await p.delete(`/restapi/v1.0/subscription/${s.id}`).catch(() => {}); };

  for (const s of exact) {
    if (s.status === 'Active') {
      try {
        const r = await (await p.post(`/restapi/v1.0/subscription/${s.id}/renew`)).json();
        await dropStale(r.id);
        return { renewed: r.id, expires: r.expirationTime };
      } catch (e) {
        console.warn('renew failed, recreating', e.message);
      }
    }
  }

  const created = await (await p.post('/restapi/v1.0/subscription', {
    eventFilters: [EVENT_FILTER],
    deliveryMode: { transportType: 'WebHook', address, verificationToken: config.rc.verificationToken || undefined },
    expiresIn: 604800, // 7 days; renewed every 12h by the job runner
  })).json();
  await dropStale(created.id);
  return { created: created.id, expires: created.expirationTime };
}
