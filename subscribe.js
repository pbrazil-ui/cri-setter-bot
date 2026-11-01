// Creates/renews the RingCentral inbound-SMS webhook. The server also does this on boot and every 12h.
import { ensureSubscription } from '../src/ringcentral.js';
console.log(await ensureSubscription());
