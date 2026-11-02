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
import { pollInboxForLeads } from './intake/mailbox.js';

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

let polling = false;
/** Every minute: new lead notifications in Pierce's inbox become leads (replaces Postmark + forwarding). */
export async function inboxTick() {
  if (polling) return null;
  polling = true;
  try { const r = await pollInboxForLeads(); if (r?.leads) console.log('[inbox leads]', JSON.stringify(r)); return r; } catch (e) {
    console.error('[inbox leads]', e.message);
    return { error: e.message };
  } finally { polling = false; }
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

// ---------- one instance runs the loops (Render overlaps old and new instances during every deploy) ----------
const HOLDER = `${process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'local'}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const LEASE_TTL_SEC = 60;
let leader = false; let leaseWarned = false; let stopping = false;

/** Claim or renew the job lease. Without the DB function (schema.sql not re-run) it falls back to running, loudly. */
export async function renewLease() {
  if (stopping) return (leader = false);
  try {
    const got = await db.claimLease(HOLDER, LEASE_TTL_SEC);
    if (got && !leader) console.log(`[lease] ${HOLDER} is running the job loops`);
    if (!got && leader) console.log('[lease] another instance took over the job loops');
    leader = got;
  } catch (e) {
    if (e.missingFunction) {
      if (!leaseWarned) { console.warn('[lease] claim_job_lease() missing: re-run supabase/schema.sql. Running loops without a lease (overlapping deploys could double-send).'); leaseWarned = true; }
      leader = true;
    } else console.error('[lease]', e.message); // transient: keep the current state
  }
  return leader;
}
export const isLeader = () => leader;
const onlyLeader = (fn) => async () => (leader && !stopping ? fn() : null);

export function startJobs() {
  const timers = [];
  const every = (fn, ms) => timers.push(setInterval(onlyLeader(fn), ms));
  const once = (fn, ms) => timers.push(setTimeout(onlyLeader(fn), ms));
  const history = () => importEmailHistory().then((r) => r && console.log('[email history]', JSON.stringify(r))).catch((e) => console.error('[email history]', e.message));

  timers.push(setInterval(renewLease, 15 * 1000));
  renewLease().then(() => {
    once(renewSubscription, 0);
    once(syncListings, 0);
  });
  every(briefTick, 60 * 1000);
  every(history, 6 * 3600 * 1000);
  once(history, 120 * 1000);
  every(expireTick, 10 * 60 * 1000);
  every(replyTick, 20 * 1000);
  every(firstTouchTick, 20 * 1000);
  every(inboxTick, 60 * 1000);
  once(inboxTick, 15 * 1000);
  every(docSync, 3600 * 1000);
  once(docSync, 60 * 1000); // after HubSpot listings sync
  every(tick, config.tickSeconds * 1000);
  every(renewSubscription, 12 * 3600 * 1000);
  every(syncListings, 3600 * 1000);
  once(tick, 5000);

  // Render sends SIGTERM to the old instance once the new one is healthy: stop the loops and hand over the lease.
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true; leader = false;
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    try { await db.releaseLease(HOLDER); } catch { /* lease expires on its own in 60s */ }
    console.log(`[shutdown] ${sig}: loops stopped, lease released`);
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
