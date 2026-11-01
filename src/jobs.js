import { config } from './config.js';
import { db } from './db/index.js';
import { inWindow } from './guardrails.js';
import { ensureSubscription } from './ringcentral.js';
import { syncListingsFromHubSpot } from './hubspot.js';
import { notifyOwner } from './notify.js';
import { processFirstTouch, runFollowups, sendDueScheduled, isPaused, processDueReplies } from './agent/setter.js';
import { syncDropbox } from './docs/sync.js';
import { sendMorningBrief } from './brief.js';
import { importEmailHistory } from './docs/history.js';
import { audit } from './policy.js';
import { now } from './clock.js';

let running = false;

/** One pass: scheduled sends, paced first touches, follow-ups. Safe to call any time. */
export async function tick() {
  if (running) return { skipped: 'already_running' };
  running = true;
  try {
    await sendDueScheduled();
    await firstTouchPass();
    if (inWindow(config.sendWindow) && !(await isPaused())) await runFollowups();
    return { ok: true };
  } catch (e) {
    console.error('[tick]', e);
    return { error: e.message };
  } finally {
    running = false;
  }
}

async function renewSubscription() {
  try { console.log('[rc subscription]', await ensureSubscription()); } catch (e) {
    console.error('[rc subscription]', e.message);
    await notifyOwner(`Setter bot: RingCentral webhook renewal FAILED (${e.message}). Inbound texts may not reach the bot.`);
  }
}

async function syncListings() {
  const n = await syncListingsFromHubSpot();
  if (n !== null) console.log(`[listings] synced ${n} from HubSpot`);
}

/** New inquiries whose 1-2 min (email) or +5 min (text) mark has come due. Emails go any hour; texts wait for the send window. */
async function firstTouchPass() {
  for (const lead of await db.listLeadsForFirstTouch(config.firstTouchPerTick)) await processFirstTouch(lead);
}

let touching = false;
export async function firstTouchTick() {
  if (touching) return;
  touching = true;
  try { await firstTouchPass(); } catch (e) { console.error('[firstTouchTick]', e); } finally { touching = false; }
}

let replying = false;
/** Fast loop: paced replies that have come due. */
export async function replyTick() {
  if (replying) return [];
  replying = true;
  try { await sendDueScheduled(); return await processDueReplies(); } catch (e) { console.error('[replyTick]', e); return []; } finally { replying = false; }
}

let syncing = false;
export async function docSync() {
  if (syncing) return { skipped: 'running' };
  syncing = true;
  try {
    const r = await syncDropbox();
    if (r) {
      console.log('[dropbox sync]', JSON.stringify(r));
      if (r.unmatched_folders.length) console.warn('[dropbox sync] folders with no matching listing:', r.unmatched_folders.join(' | '));
    }
    return r;
  } catch (e) {
    console.error('[dropbox sync]', e.message);
    await notifyOwner(`Setter bot: Dropbox sync failed (${e.message}). Answers use the last good copy.`);
    return { error: e.message };
  } finally { syncing = false; }
}

/** Fires once per local day at BRIEF_HOUR:BRIEF_MINUTE. Idempotent via a settings key. */
export async function briefTick() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now());
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const today = `${g('year')}-${g('month')}-${g('day')}`;
  const mins = Number(g('hour')) * 60 + Number(g('minute'));
  if (mins < config.briefHour * 60 + config.briefMinute) return null;
  if ((await db.getSetting('last_brief_date')) === today) return null;
  await db.setSetting('last_brief_date', today);
  try { return await sendMorningBrief(); } catch (e) { console.error('[brief]', e); return null; }
}

/** Approvals older than policies.limits.approval_expires_hours are expired so stale drafts never go out. */
export async function expireTick() {
  const hit = await db.expireApprovals(now().toISOString());
  for (const a of hit || []) await audit('approval_expired', { leadId: a.lead_id, actor: 'system', detail: { approval: a.id } });
  return hit?.length || 0;
}

export function startJobs() {
  setInterval(briefTick, 60 * 1000);
  setInterval(() => importEmailHistory().then((r) => r && console.log('[email history]', JSON.stringify(r))).catch((e) => console.error('[email history]', e.message)), 6 * 3600 * 1000);
  setTimeout(() => importEmailHistory().then((r) => r && console.log('[email history]', JSON.stringify(r))).catch((e) => console.error('[email history]', e.message)), 120 * 1000);
  setInterval(expireTick, 10 * 60 * 1000);
  setInterval(replyTick, 20 * 1000);
  setInterval(firstTouchTick, 20 * 1000);
  setInterval(docSync, 3600 * 1000);
  setTimeout(docSync, 60 * 1000); // after HubSpot listings sync
  renewSubscription();
  syncListings();
  setInterval(tick, config.tickSeconds * 1000);
  setInterval(renewSubscription, 12 * 3600 * 1000);
  setInterval(syncListings, 3600 * 1000);
  setTimeout(tick, 5000);
}
