# CRI Setter Bot - notes for Claude Code

A 24/7 inbound "setter" for CRI Brokerage (Pierce Brazil). Buyer leads from Crexi, LoopNet,
RVParkStore, MHVillage and website forms come in; the bot texts (RingCentral) or emails (Outlook via
Microsoft Graph) them, answers questions from the listing's Dropbox documents with real math, qualifies
them to CRI's standard, books a call with Pierce, and keeps the HubSpot **Buyers** pipeline current.
When it can't answer, it asks Pierce by text and saves his answer for the next buyer.

Runs on Render (web service `cri-setter-bot`, https://cri-setter-bot.onrender.com, Starter, auto-deploys this branch; `render.yaml` mirrors it). State in Supabase. Documents mirrored from Dropbox hourly.

## Autonomy is in code: `playbook/policies.json` + `src/policy.js`
Levels 1/2/3 from Pierce's instructions. Every outbound passes `classify()` → `resolve()` → auto | approve | block.
`test_mode` is OFF since Nov 1 2026 (Pierce gave standing approval for new-lead messaging within policies; Level 3 items still need his Y). `emergency_stop` and PAUSE override everything. `src/brief.js` sends the Morning Broker Brief at 7:30.
`audit_log` records every action with actor. Never relax a policy in code; Pierce edits the JSON.

## Pierce starts here: SETUP-PROMPT.md (status + go-live steps on Render; paste its box into a browser Claude)

## Read these first
1. `playbook/setter-playbook.md` - how the bot talks and what it may say. Pierce's standard. Plus `playbook/skills/*.md`:
   Pierce's own `my-writing-style` and `elite-cre-sales` skills, loaded into every prompt after the code rules.
2. `docs/` - Pierce's full specs: primary mission, autonomy levels, Mac-mini hub, master engineering spec, Dropbox deal
   intelligence, skills library. The setter bot is the first working slice (inbound buyers, documents, HubSpot Buyers
   pipeline, Morning Brief). Build the rest incrementally on this codebase; don't start a parallel framework.
3. `CONTEXT-NEEDED.md` - what Pierce still has to supply.

## Map
- `src/server.js` boot (validates env BEFORE importing anything that connects; Supabase client is lazy) · `src/app.js` HTTP routes · `src/webhook.js` RingCentral events · `src/jobs.js` loops
- `src/agent/setter.js` **core**: first touch, inbound → paced reply queue, `respondNow`, `deliver()` gate, follow-ups, ask-Pierce
- `src/agent/tools.js` the tools Claude calls mid-conversation (search docs, rent roll stats, financials, calculate, doc links). **All access rules live here.**
- `src/agent/owner.js` Pierce's SMS commands · `src/agent/prompt.js` system prompt + tool schemas
- `src/llm.js` Claude calls: agent loop, document extraction (PDF native), answer polishing, and deterministic mocks
- `src/policy.js` policy engine + `audit()` · `src/brief.js` Morning Broker Brief · `src/docs/history.js` past-email import + `prior_conversations`
- `src/docs/` `sync.js` Dropbox → DB mirror · `classify.js` + `playbook/dropbox-rules.json` folder → tier · `ingest.js` file → chunks/units/line items · `rentroll.js` + `financials.js` pure math · `search.js` keyword retrieval
- `src/dropbox.js` Dropbox API (team root, download, view-only links) · `src/email.js` Graph mail · `src/ringcentral.js` SMS
- `src/hubspot.js` contacts, Buyers deals, stage rules (`decideStageMove`), notes, listing import
- `src/intake/sms-alert.js` Crexi lead alerts TEXTED to the RingCentral number from (424) 322-3884 (`PLATFORM_ALERT_NUMBERS`; alert-shaped texts from other numbers are refused): the buyer in the alert gets the first text; the alert sender never gets a reply; Pierce's own numbers are never texted.
- Owner `TEST <listing>`: Pierce's cell plays a buyer for 2h (no HubSpot, any hour; his commands need `#` meanwhile; `#ENDTEST`). A buyer who texts an email gets the intro email (NDA/OM links, Dylan cc'd); the prompt shows whether it was actually sent.
- `src/intake/` lead emails (`email.js`), mailbox poller (`mailbox.js`: reads platform-sender emails from ALL folders of Pierce's Outlook every minute, since Superhuman "Done"/rules can move them, so no Postmark/forwarding), CSV (`csv.js`), shared upsert (`common.js`) · `src/platforms.js` which site a lead came from
- `src/selftest.js` `GET /admin/selftest?key=` read-only check of every integration (number SMS-enabled, webhook active, mailbox readable, models available)
- `src/guardrails.js` opt-out, quiet hours, human-only topics · `src/calc.js` safe arithmetic
- `src/db/` `supabase.js` (prod) / `memory.js` (tests), same interface · `supabase/schema.sql`

## Commands
- `npm install && npm test` (78 tests; in-memory DB, mock SMS/LLM/Dropbox/email, fake HubSpot. No accounts needed.)
- `npm run dev` local server, all mocks, :3000
- `open "$PUBLIC_URL/admin/selftest?key=$INGEST_SECRET"` after any deploy or key change: every check should be ok
- `curl -X POST "$PUBLIC_URL/admin/sync-docs?key=$INGEST_SECRET"` force a Dropbox sync
- `curl -X POST "$PUBLIC_URL/api/ask?key=..." -d '{"listing":"Lighthouse","question":"unit mix?","ca_verified":true}'` test the document brain

## Pierce's SMS commands (from OWNER_PHONE to the RingCentral number)
`Y12`/`YA` send draft(s) · `N12` skip · `E12 text` send his wording · `A7 answer` answer question Q7 (saved to qa_bank)
· `CA34` CA verified for lead 34 (unlocks OM/rent roll/financials, status → in_dd) · `T34`/`B34` take over / hand back
· `PAUSE`/`RESUME` · `STATUS` · `HELP`

## Non-negotiables (don't weaken without Pierce saying so explicitly)
1. Every outbound message passes `deliver()`: opt-out → rate limit → approval → time window.
2. Opt-outs are permanent and handled in code, never by the model.
3. Price/terms/offers/commission/co-broke/legal → approval required and thread muted (`escalated`).
4. **Document tiers** (`playbook/dropbox-rules.json`): `public` anyone · `ca` only when `lead.ca_verified` · `sensitive` bot may read, reply needs Pierce's Y · `exclude` never loaded (archives, media, contracts, financing, PII, employment, insurance). Enforced in `src/agent/tools.js`, not the prompt.
5. Tenant names are never stored (rent roll parser drops them; extraction prompt forbids PII).
6. Numbers come from `rentRollStats`, `summarizeFinancials`, `calculate`. The model never does arithmetic.
7. Unknown answer → `ask_pierce`, never a guess. One holding reply per open question.
8. HubSpot: bot never touches deals at/after Offer Out, never moves backward, only auto-closes from New buyer (opt-outs excepted).
9. Voice (Pierce's decision, Nov 1 2026): messages go out as Pierce ("this is Pierce over at CRI"), `DISCLOSE_AI=false`, no "Reply STOP" line. Honesty floor in code: the bot never claims to be human; "are you a bot?" is a human-only topic (`asksIfBot` in guardrails.js) and goes to Pierce. Counsel should review (Cal. B&P §17941). No signatures in email bodies in draft mode (Outlook adds Pierce's). Dylan (DylanB@cricommercial.com) is cc'd on every email to a lead (`EMAIL_LEAD_CC`, Pierce's latest, Nov 2 2026); never on Pierce's own Brief/alerts; never Duane.
10. Uploaded CSV lists are not auto-sent (TCPA). Fresh inquiries are.
11. Human pacing (Pierce: "vary the timing in seconds and minutes"): replies 45s–5min random (`REPLY_DELAY_*`), bursts collapse into one answer, A# answers 40s–3min (`PACE_*`), never two texts to one buyer <45s apart (`MIN_GAP_SEC`). First contact: email 1–2 min after the inquiry (`FIRST_TOUCH_DELAY_*`), text 4–6 min after the email (`TEXT_AFTER_EMAIL_*`). Don't "optimize" this away.
14. The bot can't call. Calls become HubSpot tasks for Pierce (`callTask`, deduped per lead): no reply after the first touch (next business morning), they ask for a call / tour / 1031 / escalation (due now + a text to Pierce). `claimsContact()` holds any message saying Pierce called or left a voicemail. Every deal's `hs_next_step` is kept current (`syncNextStep`); verified buyers get a structured note (property, buy box, capital, timeline, next step).
15. Follow-up (elite-cre-sales): days 1/3/7 alternating text and email, then `nurture` status: email every 14 days to day 91, then monthly. Long-tail texts off unless `NURTURE_SMS=true` (Pierce confirmed Nov 2 2026: "email only after this"; texts are for active conversations and the day 1/3/7 touches, and a nurture lead who replies is back in conversation on their channel with the cadence restarted). Email is SENT, not drafted (`EMAIL_SEND_MODE=send`, Pierce Nov 2 2026); buyer email replies are read from the inbox and answered in-thread, unless Pierce already replied in that conversation.
13. Listings under contract or sold: no documents/numbers/past correspondence (tools.js), first contact says so and asks criteria, Pierce gets a MATCH text. Seller names never reach buyers: `publicListingName()` strips "Seller Name - " from HubSpot deal names; buyer-facing text uses the platform's property name first.
12. One Render instance. Render overlaps old and new instances on every deploy (observed: the old one runs ~2 min more and gets no usable SIGTERM), so only the holder of the Supabase job lease (`claim_job_lease`) runs the send/follow-up loops, and the NEWEST booted instance wins (`makeLeaseKeeper` in `src/jobs.js`: `settings.job_newest` heartbeat; an older leader steps down within one 15s renew, and resumes if the newer one stops heartbeating for 60s). Becoming leader registers the RingCentral webhook for that instance's config. Tests never hit real services. Add a test for every behavior change.
16. Mailboxes (Pierce, Nov 2 2026): read/send ONLY pbrazil@cribrokerage.com and pbrazil@cricommercial.com (`EMAIL_ALLOWED_MAILBOXES`, enforced on every Graph call by `assertGraphAllowed`). Never Dylan's, Duane's or anyone else's mailbox; Dylan is only cc'd on lead emails. The two addresses are ONE inbox (Pierce, Nov 2 2026): it is read once via `EMAIL_MAILBOX`, which must be the mailbox's sign-in name (UPN) in Entra. Pierce and Dylan both receive the platform lead emails (Pierce, Nov 2 2026), so Dylan's listing leads are read from Pierce's inbox; a "FW:" from Dylan (`EMAIL_TRUSTED_FORWARDERS`) is the fallback, deduped by phone/email. Exchange RBAC for Applications (management scope = Pierce's mailbox, no Entra consent) restricts the credential itself; the admin verifies it with Test-ServicePrincipalAuthorization (SETUP-PROMPT 6f). The bot never probes another mailbox, not even to test.
17. Never delete without Pierce's approval (Nov 2 2026): no deleting/moving mail, no HubSpot DELETE/archive/merge, no Dropbox delete/move/unshare. Blocked in code (`assertGraphAllowed`, `assertHubspotAllowed`, `assertDropboxAllowed`). The bot's own Supabase mirror of Dropbox documents is the only thing it removes, when the source file changes. (Moving Walnut Estates on Nov 1 was Pierce's explicit request, done by Claude Code, not the bot.)
18. Listings: only Pierce's (`2145826500`) and Dylan's (`683980338`) HubSpot deals are imported (`HUBSPOT_LISTING_OWNERS`). Other agents' (e.g. Nolan Rockwell's Pinederosa, Dimitre Petrov's Arden Asheville) never are. A lead matching none of their listings waits for Pierce's Y (`first_touch.unmatched`). Buyer deals and call tasks are owned by the listing's owner.

## HubSpot facts (Pierce's portal, read Oct 31 2026)
- Auth: a HubSpot **service key** "CRI Setter Bot" (this account has no private apps), used as `HUBSPOT_TOKEN` (Bearer). Scopes: crm.objects.contacts.read/.write, crm.objects.deals.read/.write. Every call is contacts/deals search/get/create/patch (incl. `hs_next_step`, associations), plus notes and tasks creates. Whether contacts/deals scopes cover notes/tasks isn't documented clearly; selftest probes notes/tasks read and the bot texts Pierce once per object on a 401/403.
- Buyers pipeline `1100542670`: New buyer `1734608578` → Qualified `4502497982` → Offer Out `1734608577` → Under Contract `1734608579` → Closed Won `1734608582` / Closed Lost `1734608583`
- Sellers pipeline `1100540605` = listings. Stages: BOV `1730621130` · Listed `1730621131` · Under Contract `1730621132` · Closed Won `1730874073` · Closed Lost `1730874074`. `listing_status` is blank on nearly every deal (Nov 1 2026), so `listingStatusFor()` uses the stage; Listed/Under Contract/Closed Won are imported. Many deal names include the seller ("Boon Chan - Hacienda Mobile Park"). Props used: `listing_code`, `listing_status`, `crexi_listing_url`, `ca_link`, `om_link`, `listing_hub_url`. Closed Lost needs `lost_reason_category`.

## Microsoft facts (Nov 2 2026)
- Entra app "CRI Setter Bot": Mail.ReadWrite + Mail.Send listed but deliberately NOT consented (tenant-wide consent would open all 42 mailboxes). Access is ONLY via Exchange RBAC for Applications, management scope = pbrazil@cribrokerage.com. Verified with `Test-ServicePrincipalAuthorization`. The token carries no Mail roles; `mailCheck()` makes a real scoped call on the inbox instead.
- pbrazil@cricommercial.com is an alias of the same mailbox; `EMAIL_MAILBOX=pbrazil@cribrokerage.com`.

## Dropbox facts (Pierce's team space, read Oct 31 2026)
- Listings: `/Brokerage/01 - Brokerage/Deals/01 - Listed/<Park Name - City, ST>/` (some are shared-folder mounts). Also `02 - Under Contract`, `03 - Pursuits`, `04 - Closed`, `05 - Dead`, `00 - Property Template`.
- Inside a listing (Lighthouse layout): `00 - OM`, `01 - Financials/<year>`, `03 - Leases`, `04 - Rules, Permits & Licenses`, `06 - Property Taxes`, `07 - Photos`, `08 - Seller QA`, `09 - Insurance`, `10 - Water System, Septic & Utilities`, `11 - Inspections, Compliance & Hazardous Materials`, `12 - Capital Improvements`, `13 - Operations & Employment`, `14 - Financing`, `zz - Archive`. Template folders use `03 - Due Diligence/02 - Rent Roll w Move-In Dates`, `.../11 - Trailing 12 Month P&L`, `.../24 - Seller Questionnaire & Answers`.
- SOPs: `/Brokerage/04 - SOP's/Deal Flow & Execution/` (Buyer Qualification checklist, ICP guide, scripts). Loaded as `internal` tier: guides the bot, never quoted to leads.
- Folder names map to listings by fuzzy match on the HubSpot deal name (`src/listings.js`). A `01 - Listed` folder with no HubSpot match becomes an active listing of its own (Pierce: "if HubSpot doesn't have it, use Dropbox"); a `02 - Under Contract` folder marks its listing under contract. Status = most restrictive of HubSpot listing_status, HubSpot stage, Dropbox folder. Walnut Estates moved to `02 - Under Contract` on Nov 1 2026 at Pierce's request.
- LoopNet/Crexi "saved your listing" emails become `source: 'favorite'` leads: email per `first_touch.email`, text needs Pierce's Y (`first_touch.favorite`).

## Open TODOs (in order)
1. ~~`npm install`, lockfile, `npm test`~~ done Nov 1 2026. Dropbox path-root verified via MCP: team root namespace is `12987598657` (what `users/get_current_account` returns, which `src/dropbox.js` uses); `/Brokerage/01 - Brokerage/Deals/01 - Listed` resolves under it. `15100856355` is the Brokerage shared folder itself, not the root.
2. Pierce fills `CONTEXT-NEEDED.md` + the TODOs in `playbook/setter-playbook.md`.
3. Deploy per README. Run `/admin/sync-docs`, check logs for unmatched folders and failed files.
4. ~~Lead emails from the inbox~~ done (mailbox.js). Still open, inbound email REPLIES (Phase 2 of the master spec): Graph change-notification webhook → `handleInboundEmail` (mirror of `handleInboundSms`, set `email_last_message_id` so replies thread). Not built yet; today email is outbound + Outlook drafts.
5. ~~Mark listings closed / sync `02 - Under Contract`~~ done Nov 1 2026 (stage + Dropbox). Still open: `04 - Closed` folders.
6. HubSpot meetings webhook → mark `booked` automatically.
7. Weekly digest to Pierce: open questions, pending approvals, leads gone quiet, qa_bank growth.
8. Feedback loop: diff Pierce's `E#` edits against drafts, surface recurring changes as playbook suggestions (never auto-edit the playbook).
