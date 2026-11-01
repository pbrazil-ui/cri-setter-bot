import { config } from './config.js';

export const mockOutbox = []; // used in SMS_MODE=mock and tests

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
export async function ensureSubscription() {
  if (config.smsMode === 'mock') return { mock: true };
  const p = await platform();
  const address = `${config.publicUrl}/webhooks/ringcentral`;
  const list = await (await p.get('/restapi/v1.0/subscription')).json();
  const mine = (list.records || []).filter((s) => s.deliveryMode?.address === address);

  for (const s of mine) {
    if (s.status === 'Active') {
      try {
        const r = await (await p.post(`/restapi/v1.0/subscription/${s.id}/renew`)).json();
        return { renewed: r.id, expires: r.expirationTime };
      } catch (e) {
        console.warn('renew failed, recreating', e.message);
      }
    }
    await p.delete(`/restapi/v1.0/subscription/${s.id}`).catch(() => {});
  }

  const created = await (await p.post('/restapi/v1.0/subscription', {
    eventFilters: [EVENT_FILTER],
    deliveryMode: { transportType: 'WebHook', address, verificationToken: config.rc.verificationToken || undefined },
    expiresIn: 604800, // 7 days; renewed every 12h by the job runner
  })).json();
  return { created: created.id, expires: created.expirationTime };
}
