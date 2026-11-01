try { await import('dotenv/config'); } catch { /* dotenv optional; Railway injects env vars */ }

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

const autoSendSources = list(env.AUTO_SEND_SOURCES, ['listing_email', 'inbound_sms', 'webhook']);

export const config = {
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  ingestSecret: env.INGEST_SECRET || '',

  // live | memory / mock — memory+mock let you run everything locally with no accounts
  dbMode: env.DB_MODE || 'supabase',
  smsMode: env.SMS_MODE || 'live',
  llmMode: env.LLM_MODE || 'live',

  supabase: { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    extractModel: env.ANTHROPIC_EXTRACT_MODEL || 'claude-haiku-5-5',
  },

  rc: {
    server: env.RC_SERVER || 'https://platform.ringcentral.com',
    clientId: env.RC_CLIENT_ID,
    clientSecret: env.RC_CLIENT_SECRET,
    jwt: env.RC_JWT,
    fromNumber: env.RC_FROM_NUMBER, // the 10DLC-registered number that texts leads
    verificationToken: env.RC_VERIFICATION_TOKEN || '',
  },

  email: {
    mode: env.EMAIL_MODE || (env.MS_CLIENT_ID ? 'live' : 'off'), // live | mock | off
    sendMode: env.EMAIL_SEND_MODE || 'draft', // draft = leave in Outlook Drafts for you; send = send after approval gate
    tenantId: env.MS_TENANT_ID, clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET,
    mailbox: env.EMAIL_MAILBOX || 'pbrazil@cribrokerage.com',
    alwaysCc: list(env.EMAIL_ALWAYS_CC, ['DylanB@cricommercial.com']),
    signatureHtml: env.EMAIL_SIGNATURE_HTML || '',
    maxAttachmentMb: num(env.EMAIL_MAX_ATTACHMENT_MB, 3),
  },
  dropbox: {
    mode: env.DROPBOX_MODE || (env.DROPBOX_REFRESH_TOKEN ? 'live' : 'off'), // live | mock | off
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN,
    allowDownload: bool(env.DROPBOX_LINKS_ALLOW_DOWNLOAD, true),
  },
  // human pacing: replies wait a random 1-5 minutes; a burst of texts gets one answer
  replyDelay: { minSec: num(env.REPLY_DELAY_MIN_SEC, 60), maxSec: num(env.REPLY_DELAY_MAX_SEC, 300), capSec: num(env.REPLY_DELAY_CAP_SEC, 480) },
  autoVerifyCrexiCa: bool(env.AUTO_VERIFY_CREXI_CA, true), // Crexi says the buyer signed the CA -> unlock docs
  followupDaysDd: list(env.FOLLOWUP_DAYS_DD, ['2', '5', '10', '21']).map(Number),
  hubspot: {
    token: env.HUBSPOT_TOKEN || '',
    createDeals: bool(env.HUBSPOT_CREATE_DEALS, true),
    ownerId: env.HUBSPOT_OWNER_ID || '',
    platformProperty: env.HUBSPOT_PLATFORM_PROPERTY || '', // optional deal property to record Crexi/LoopNet/etc.
    // Defaults = Pierce's live portal (read Oct 31 2026). Override if the pipeline changes.
    buyersPipeline: env.HUBSPOT_BUYERS_PIPELINE || '1100542670',
    sellersPipeline: env.HUBSPOT_SELLERS_PIPELINE || '1100540605',
    stages: {
      newBuyer: env.HUBSPOT_STAGE_NEW_BUYER || '1734608578',
      qualified: env.HUBSPOT_STAGE_QUALIFIED || '4502497982',
      offerOut: env.HUBSPOT_STAGE_OFFER_OUT || '1734608577',
      underContract: env.HUBSPOT_STAGE_UNDER_CONTRACT || '1734608579',
      won: env.HUBSPOT_STAGE_WON || '1734608582',
      lost: env.HUBSPOT_STAGE_LOST || '1734608583',
    },
  },

  owner: {
    name: env.OWNER_NAME || 'Pierce Brazil',
    firstName: env.OWNER_FIRST_NAME || 'Pierce',
    phone: env.OWNER_PHONE || '', // your cell: approvals + alerts come here
    email: env.OWNER_EMAIL || 'pbrazil@cribrokerage.com', // full Morning Broker Brief goes here
  },
  company: env.COMPANY_NAME || 'CRI Brokerage',
  bookingLink: env.BOOKING_LINK || '',
  callWindows: env.CALL_WINDOWS || 'weekdays 9-10am or 2-4:30pm Pacific',

  // California bot-disclosure law (B&P 17940-17943): keep this on unless counsel says otherwise
  discloseAi: bool(env.DISCLOSE_AI, true),

  timezone: env.TIMEZONE || 'America/Los_Angeles',
  briefHour: num(env.BRIEF_HOUR, 7), briefMinute: num(env.BRIEF_MINUTE, 30), // Morning Broker Brief, local time
  // first touches + follow-ups only go out inside this window (24h clock, local tz)
  sendWindow: { start: num(env.SEND_START_HOUR, 8), end: num(env.SEND_END_HOUR, 20), days: list(env.SEND_DAYS, ['1', '2', '3', '4', '5', '6']).map(Number) },
  // replies to someone who just texted us can go out in this wider window
  replyWindow: { start: num(env.REPLY_START_HOUR, 7), end: num(env.REPLY_END_HOUR, 22), days: [0, 1, 2, 3, 4, 5, 6] },

  autoSend: Object.fromEntries(['listing_email', 'csv', 'inbound_sms', 'webhook', 'manual'].map((s) => [s, autoSendSources.includes(s)])),
  // only emails from a known listing platform become leads (see src/platforms.js)
  requireKnownPlatform: bool(env.REQUIRE_KNOWN_PLATFORM, true),
  leadPlatforms: list(env.LEAD_PLATFORMS, ['crexi', 'loopnet', 'rvparkstore', 'mhvillage', 'mhbay', 'costar', 'biproxi', 'website']),

  firstTouchPerTick: num(env.FIRST_TOUCH_PER_TICK, 10),
  maxPendingApprovals: num(env.MAX_PENDING_APPROVALS, 5),
  followupDays: list(env.FOLLOWUP_DAYS, ['1', '3', '7']).map(Number),
  maxMsgsPerLeadPerDay: num(env.MAX_MSGS_PER_LEAD_PER_DAY, 6),
  tickSeconds: num(env.TICK_SECONDS, 300),
};

export function validateConfig() {
  const missing = [];
  const need = (cond, name) => cond || missing.push(name);
  need(config.ingestSecret, 'INGEST_SECRET');
  if (config.dbMode === 'supabase') {
    need(config.supabase.url, 'SUPABASE_URL');
    need(config.supabase.serviceKey, 'SUPABASE_SERVICE_ROLE_KEY');
  }
  if (config.llmMode === 'live') need(config.anthropic.apiKey, 'ANTHROPIC_API_KEY');
  if (config.email.mode === 'live') for (const k of ['tenantId', 'clientId', 'clientSecret']) need(config.email[k], `MS_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
  if (config.dropbox.mode === 'live') for (const k of ['appKey', 'appSecret', 'refreshToken']) need(config.dropbox[k], `DROPBOX_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
  if (config.smsMode === 'live') {
    for (const k of ['clientId', 'clientSecret', 'jwt', 'fromNumber']) need(config.rc[k], `RC_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
    need(config.publicUrl, 'PUBLIC_URL');
    need(config.owner.phone, 'OWNER_PHONE');
  }
  return missing;
}
