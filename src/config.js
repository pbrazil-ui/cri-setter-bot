try { await import('dotenv/config'); } catch { /* dotenv optional; Render injects env vars */ }

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

// Pierce's email signature, verbatim as he sent it (Nov 2 2026: "use this email signature for communications").
// Appended to every email the bot SENDS (Graph mail gets no Outlook signature). Override with EMAIL_SIGNATURE_HTML.
// Laid out exactly like his Outlook signature (his screenshot, Nov 2 2026): bold name, a blank line between blocks,
// the notice in the same size and color as the rest.
// Line breaks, not paragraph margins, make the spacing, so Outlook, Superhuman and phones all show the same gaps.
const SIG_NOTICE = 'This electronic mail message and any attachments are private and confidential and are the property of the sender. The information contained in this electronic mail message is privileged and is intended only for the use of the individual(s) or entity(ies) named above. If you are not the intended recipient, be advised that any unauthorized disclosure, copying, distribution or the taking of any action in reliance on the contents of this information is strictly prohibited. If you have received this electronic mail message in error, please call the person at the number above, or notify me immediately at pbrazil@cribrokerage.com and delete the message and destroy your copy of the email.';
export const PIERCE_SIGNATURE_HTML = [
  '<div style="line-height:1.35">',
  '<b>Pierce Brazil</b><br>Senior Investment Associate<br>CRI Brokerage<br>DRE #02247759 | CRI DRE #01807613<br>Direct: 949.335.5921<br><br>',
  '2152 Dupont Dr, Suite 270<br>Irvine, CA 92612<br><br>',
  'Website: <a href="https://cribrokerage.com">cribrokerage.com</a><br><br>',
  `CONFIDENTIAL COMMUNICATION<br><br>${SIG_NOTICE.replace('pbrazil@cribrokerage.com', '<a href="mailto:pbrazil@cribrokerage.com">pbrazil@cribrokerage.com</a>')}`,
  '</div>',
].join('');

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
    // effort: medium for buyer conversations (Sonnet 5.5 defaults to high, which costs more for chat-length work)
    effort: env.ANTHROPIC_EFFORT || 'medium',
    extractEffort: env.ANTHROPIC_EXTRACT_EFFORT || 'medium',
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
    // Pierce (Nov 2 2026): "just send, not draft." send = sends after the policy gate; draft = leaves it in Outlook Drafts
    sendMode: env.EMAIL_SEND_MODE || 'send',
    tenantId: env.MS_TENANT_ID, clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET,
    mailbox: env.EMAIL_MAILBOX || 'pbrazil@cribrokerage.com',
    // Pierce (Nov 2 2026, latest): cc Dylan on every email to a LEAD. Never on Pierce's own Brief/alerts. Not Duane.
    leadCc: list(env.EMAIL_LEAD_CC || env.EMAIL_ALWAYS_CC, ['DylanB@cricommercial.com']),
    // Graph-sent mail gets no Outlook signature, so the bot appends Pierce's (his exact block, Nov 2 2026)
    signatureHtml: env.EMAIL_SIGNATURE_HTML ?? PIERCE_SIGNATURE_HTML,
    maxAttachmentMb: num(env.EMAIL_MAX_ATTACHMENT_MB, 3),
    // read lead notifications (Crexi, LoopNet, ...) straight from the inbox: no Postmark, no forwarding rule
    pollLeads: bool(env.EMAIL_POLL_LEADS, true),
    // Pierce (Nov 2 2026): ONLY his two mailboxes, never Dylan's, Duane's or anyone else's. Enforced in email.js on every
    // Graph call; also restrict the app in Exchange (SETUP-PROMPT step 6f) so the credential itself can't reach others.
    allowedMailboxes: list(env.EMAIL_ALLOWED_MAILBOXES, ['pbrazil@cribrokerage.com', 'pbrazil@cricommercial.com']).map((s) => s.toLowerCase()),
    // one inbox with two addresses (Pierce, Nov 2 2026): read it once, via EMAIL_MAILBOX (must be the mailbox's sign-in
    // name / UPN in Entra, which is what Graph resolves; the other address is an alias of the same inbox)
    readMailboxes: list(env.EMAIL_READ_MAILBOXES, [env.EMAIL_MAILBOX || 'pbrazil@cribrokerage.com']).map((s) => s.toLowerCase()),
    // Dylan's listing leads reach the bot only if Dylan forwards them to Pierce (his inbox is never read)
    trustedForwarders: list(env.EMAIL_TRUSTED_FORWARDERS, ['dylanb@cricommercial.com']).map((s) => s.toLowerCase()),
  },
  dropbox: {
    mode: env.DROPBOX_MODE || (env.DROPBOX_REFRESH_TOKEN ? 'live' : 'off'), // live | mock | off
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN,
    allowDownload: bool(env.DROPBOX_LINKS_ALLOW_DOWNLOAD, true),
  },
  // first contact: email goes out 1-2 min after the inquiry lands, the text follows ~5 min after the email
  firstTouchDelay: { minSec: num(env.FIRST_TOUCH_DELAY_MIN_SEC, 60), maxSec: num(env.FIRST_TOUCH_DELAY_MAX_SEC, 120) },
  textAfterEmail: { minSec: num(env.TEXT_AFTER_EMAIL_MIN_SEC, 240), maxSec: num(env.TEXT_AFTER_EMAIL_MAX_SEC, 390) },
  // Human pacing (Pierce, Nov 1 2026: "vary the timing in seconds and minutes"). Every delay is a fresh random draw.
  // Replies to a buyer wait 45s-5min; a burst of texts gets one answer (capped at 8 min after the first).
  replyDelay: { minSec: num(env.REPLY_DELAY_MIN_SEC, 45), maxSec: num(env.REPLY_DELAY_MAX_SEC, 300), capSec: num(env.REPLY_DELAY_CAP_SEC, 480) },
  // Pierce's A# answers wait 40s-3min before going out
  pace: { minSec: num(env.PACE_MIN_SEC, 40), maxSec: num(env.PACE_MAX_SEC, 180) },
  // never two bot texts to the same buyer closer than this; a too-soon text is pushed back a random 1-2.5x this
  minGapSec: num(env.MIN_GAP_SEC, 45),
  autoVerifyCrexiCa: bool(env.AUTO_VERIFY_CREXI_CA, true), // Crexi says the buyer signed the CA -> unlock docs
  followupDaysDd: list(env.FOLLOWUP_DAYS_DD, ['2', '5', '10', '21']).map(Number),
  hubspot: {
    token: env.HUBSPOT_TOKEN || '',
    createDeals: bool(env.HUBSPOT_CREATE_DEALS, true),
    ownerId: env.HUBSPOT_OWNER_ID || '',
    // Pierce (Nov 2 2026): the bot works only Pierce's and Dylan's listings. HubSpot owner ids (read Nov 2 2026).
    listingOwners: list(env.HUBSPOT_LISTING_OWNERS, ['2145826500', '683980338']),
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
    // Sellers pipeline stages (read Nov 1 2026). listing_status is blank on most deals, so the stage decides.
    sellerStages: {
      listed: env.HUBSPOT_SELLER_STAGE_LISTED || '1730621131',
      underContract: env.HUBSPOT_SELLER_STAGE_UNDER_CONTRACT || '1730621132',
      closedWon: env.HUBSPOT_SELLER_STAGE_CLOSED_WON || '1730874073',
    },
  },

  owner: {
    name: env.OWNER_NAME || 'Pierce Brazil',
    firstName: env.OWNER_FIRST_NAME || 'Pierce',
    phone: env.OWNER_PHONE || '', // your cell: approvals + alerts come here
    email: env.OWNER_EMAIL || 'pbrazil@cribrokerage.com', // full Morning Broker Brief goes here
  },
  company: env.COMPANY_NAME || 'CRI Brokerage',
  companyShort: env.COMPANY_SHORT || 'CRI Brokerage', // "this is Pierce over at CRI Brokerage" (elite-cre-sales skill)
  // Pierce's skill: every outreach email carries this line
  crexiProfileUrl: env.CREXI_PROFILE_URL || 'https://www.crexi.com/profile/pierce-brazil-piercebra',
  bookingLink: env.BOOKING_LINK || '',
  callWindows: env.CALL_WINDOWS || 'weekdays 9-10am or 2-4:30pm Pacific',

  // Pierce's decision (Nov 1 2026): messages go out as him ("this is Pierce over at CRI"), with no AI
  // announcement. The bot still never claims to be human: "are you a bot?" goes to Pierce (guardrails.js).
  // Set DISCLOSE_AI=true to switch back to "Pierce Brazil's AI assistant". Have counsel review (Cal. B&P 17941).
  discloseAi: bool(env.DISCLOSE_AI, false),

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
  // numbers that text platform lead alerts to the RingCentral number (Crexi, seen Nov 1 2026). An alert-shaped text
  // from any other number is NOT acted on (otherwise anyone could make the bot text a stranger); Pierce is told.
  platformAlertNumbers: list(env.PLATFORM_ALERT_NUMBERS, ['+14243223884']),
  maxPendingApprovals: num(env.MAX_PENDING_APPROVALS, 5),
  followupDays: list(env.FOLLOWUP_DAYS, ['1', '3', '7']).map(Number),
  // after day 7 (elite-cre-sales skill): every 2 weeks until day 91, then monthly, until they buy, say no or opt out.
  // Long tail goes by EMAIL. Texts stop after day 7 unless NURTURE_SMS=true (repeated texts to a one-time inquirer
  // draw carrier spam complaints and TCPA risk; email doesn't).
  nurture: { everyDays: num(env.NURTURE_EVERY_DAYS, 14), untilDay: num(env.NURTURE_UNTIL_DAY, 91), monthlyDays: num(env.NURTURE_MONTHLY_DAYS, 30), sms: bool(env.NURTURE_SMS, false) },
  // HubSpot call tasks for Pierce: hot = due now and he gets a text; otherwise due next business day at this hour
  callTaskHour: num(env.CALL_TASK_HOUR, 9),
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
  for (const mb of [config.email.mailbox, ...config.email.readMailboxes]) if (!config.email.allowedMailboxes.includes(String(mb).toLowerCase())) missing.push(`mailbox ${mb} is not in EMAIL_ALLOWED_MAILBOXES`);
  if (config.dropbox.mode === 'live') for (const k of ['appKey', 'appSecret', 'refreshToken']) need(config.dropbox[k], `DROPBOX_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
  if (config.smsMode === 'live') {
    for (const k of ['clientId', 'clientSecret', 'jwt', 'fromNumber']) need(config.rc[k], `RC_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
    need(config.publicUrl, 'PUBLIC_URL');
    need(config.owner.phone, 'OWNER_PHONE');
  }
  return missing;
}
