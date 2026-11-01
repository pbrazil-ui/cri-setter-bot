// GET /admin/selftest: checks every connection the bot depends on. Read-only: sends nothing, changes nothing
// except one settings row ('selftest_at') to prove the database accepts writes.
import { config, validateConfig } from './config.js';
import { db } from './db/index.js';
import { now } from './clock.js';
import { policies } from './policy.js';
import { rcCheck } from './ringcentral.js';
import { hubspotCheck } from './hubspot.js';
import { dropboxCheck } from './dropbox.js';
import { mailCheck } from './email.js';
import { rules } from './docs/classify.js';

const withTimeout = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);
const run = async (fn) => { try { return await withTimeout(fn()); } catch (e) { return { ok: false, problems: [e.message.slice(0, 400)] }; } };

async function anthropicCheck() {
  if (config.llmMode !== 'live') return { mode: config.llmMode };
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' } });
  if (!res.ok) return { ok: false, problems: [`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`] };
  const ids = ((await res.json()).data || []).map((m) => m.id);
  const missing = [config.anthropic.model, config.anthropic.extractModel].filter((m) => !ids.some((id) => id === m || id.startsWith(`${m}-`)));
  return { ok: !missing.length, models: [config.anthropic.model, config.anthropic.extractModel], problems: missing.map((m) => `model ${m} not available to this key`) };
}

async function databaseCheck() {
  const stamp = now().toISOString();
  await db.setSetting('selftest_at', stamp);
  const back = await db.getSetting('selftest_at');
  const listings = await db.listListings();
  const by = listings.reduce((a, l) => ({ ...a, [l.status]: (a[l.status] || 0) + 1 }), {});
  return { ok: back === stamp, mode: config.dbMode, listings: by, problems: back === stamp ? [] : ['settings write did not read back'] };
}

export async function selftest() {
  const p = policies();
  const checks = {
    config: { ok: !validateConfig().length, problems: validateConfig().map((v) => `missing ${v}`) },
    database: await run(databaseCheck),
    claude: await run(anthropicCheck),
    ringcentral: await run(rcCheck),
    hubspot: await run(hubspotCheck),
    dropbox: await run(() => dropboxCheck(rules.listings_root)),
    email: await run(mailCheck),
  };
  const failing = Object.entries(checks).filter(([, c]) => c.ok === false).map(([k]) => k);
  return {
    ok: !failing.length, failing,
    autonomy: { test_mode: p.test_mode, emergency_stop: p.emergency_stop, paused: (await db.getSetting('paused')) === true },
    modes: { db: config.dbMode, sms: config.smsMode, llm: config.llmMode, email: config.email.mode, dropbox: config.dropbox.mode },
    checks,
  };
}
