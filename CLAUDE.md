# CRI Setter Bot - notes for Claude Code

A 24/7 inbound "setter" for CRI Brokerage (Pierce Brazil). Buyer leads from Crexi, LoopNet,
RVParkStore, MHVillage and website forms come in; the bot texts (RingCentral) or emails (Outlook via
Microsoft Graph) them, answers questions from the listing's Dropbox documents with real math, qualifies
them to CRI's standard, books a call with Pierce, and keeps the HubSpot **Buyers** pipeline current.
When it can't answer, it asks Pierce by text and saves his answer for the next buyer.

Runs on Railway (one replica). State in Supabase. Documents mirrored from Dropbox hourly.

## Autonomy is in code: `playbook/policies.json` + `src/policy.js`
Levels 1/2/3 from Pierce's instructions. Every outbound passes `classify()` → `resolve()` → auto | approve | block.
`test_mode` ships ON. `emergency_stop` and PAUSE override everything. `src/brief.js` sends the Morning Broker Brief at 7:30.
`audit_log` records every action with actor. Never relax a policy in code; Pierce edits the JSON.

## Pierce starts here: HANDOFF.md

## Read these first
1. `playbook/setter-playbook.md` - how the bot talks and what it may say. Pierce's standard.
2. `docs/` - Pierce's full specs: primary mission, autonomy levels, Mac-mini hub, master engineering spec, Dropbox deal
   intelligence, skills library. The setter bot is the first working slice (inbound buyers, documents, HubSpot Buyers
   pipeline, Morning Brief). Build the rest incrementally on this codebase; don't start a parallel framework.
3. `CONTEXT-NEEDED.md` - what Pierce still has to supply.

## Map
- `src/server.js` boot · `src/app.js` HTTP routes · `src/webhook.js` RingCentral events · `src/jobs.js` loops
- `src/agent/setter.js` **core**: first touch, inbound → paced reply queue, `respondNow`, `deliver()` gate, follow-ups, ask-Pierce
- `src/agent/tools.js` the tools Claude calls mid-conversation (search docs, rent roll stats, financials, calculate, doc links). **All access rules live here.**
- `src/agent/owner.js` Pierce's SMS commands · `src/agent/prompt.js` system prompt + tool schemas
- `src/llm.js` Claude calls: agent loop, document extraction (PDF native), answer polishing, and deterministic mocks
- `src/policy.js` policy engine + `audit()` · `src/brief.js` Morning Broker Brief · `src/docs/history.js` past-email import + `prior_conversations`
- `src/docs/` `sync.js` Dropbox → DB mirror · `classify.js` + `playbook/dropbox-rules.json` folder → tier · `ingest.js` file → chunks/units/line items · `rentroll.js` + `financials.js` pure math · `search.js` keyword retrieval
- `src/dropbox.js` Dropbox API (team root, download, view-only links) · `src/email.js` Graph mail · `src/ringcentral.js` SMS
- `src/hubspot.js` contacts, Buyers deals, stage rules (`decideStageMove`), notes, listing import
- `src/intake/` lead emails (`email.js`), CSV (`csv.js`), shared upsert (`common.js`) · `src/platforms.js` which site a lead came from
- `src/guardrails.js` opt-out, quiet hours, human-only topics · `src/calc.js` safe arithmetic
- `src/db/` `supabase.js` (prod) / `memory.js` (tests), same interface · `supabase/schema.sql`

## Commands
- `npm install && npm test` (32 tests; in-memory DB, mock SMS/LLM/Dropbox/email, fake HubSpot. No accounts needed.)
- `npm run dev` local server, all mocks, :3000
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
9. AI disclosure on (`DISCLOSE_AI=true`, Cal. B&P §17941). No signatures in email bodies in draft mode (Outlook adds Pierce's). Dylan always cc'd.
10. Uploaded CSV lists are not auto-sent (TCPA). Fresh inquiries are.
11. Replies are paced 1–5 min (`REPLY_DELAY_*`); bursts collapse into one answer. Don't "optimize" this away.
12. One Railway replica. Tests never hit real services. Add a test for every behavior change.

## HubSpot facts (Pierce's portal, read Oct 31 2026)
- Buyers pipeline `1100542670`: New buyer `1734608578` → Qualified `4502497982` → Offer Out `1734608577` → Under Contract `1734608579` → Closed Won `1734608582` / Closed Lost `1734608583`
- Sellers pipeline `1100540605` = listings. Props used: `listing_code`, `listing_status`, `crexi_listing_url`, `ca_link`, `om_link`, `listing_hub_url`. Closed Lost needs `lost_reason_category`.

## Dropbox facts (Pierce's team space, read Oct 31 2026)
- Listings: `/Brokerage/01 - Brokerage/Deals/01 - Listed/<Park Name - City, ST>/` (some are shared-folder mounts). Also `02 - Under Contract`, `03 - Pursuits`, `04 - Closed`, `05 - Dead`, `00 - Property Template`.
- Inside a listing (Lighthouse layout): `00 - OM`, `01 - Financials/<year>`, `03 - Leases`, `04 - Rules, Permits & Licenses`, `06 - Property Taxes`, `07 - Photos`, `08 - Seller QA`, `09 - Insurance`, `10 - Water System, Septic & Utilities`, `11 - Inspections, Compliance & Hazardous Materials`, `12 - Capital Improvements`, `13 - Operations & Employment`, `14 - Financing`, `zz - Archive`. Template folders use `03 - Due Diligence/02 - Rent Roll w Move-In Dates`, `.../11 - Trailing 12 Month P&L`, `.../24 - Seller Questionnaire & Answers`.
- SOPs: `/Brokerage/04 - SOP's/Deal Flow & Execution/` (Buyer Qualification checklist, ICP guide, scripts). Loaded as `internal` tier: guides the bot, never quoted to leads.
- Folder names map to listings by fuzzy match on the HubSpot deal name (`src/listings.js`). Unmatched folders are logged; fix by setting `listings.dropbox_path` or adding an alias.

## Open TODOs (in order)
1. ~~`npm install`, lockfile, `npm test`~~ done Nov 1 2026. Dropbox path-root verified via MCP: team root namespace is `12987598657` (what `users/get_current_account` returns, which `src/dropbox.js` uses); `/Brokerage/01 - Brokerage/Deals/01 - Listed` resolves under it. `15100856355` is the Brokerage shared folder itself, not the root.
2. Pierce fills `CONTEXT-NEEDED.md` + the TODOs in `playbook/setter-playbook.md`.
3. Deploy per README. Run `/admin/sync-docs`, check logs for unmatched folders and failed files.
4. Inbound email replies (Phase 2 of the master spec): Graph change-notification webhook → `handleInboundEmail` (mirror of `handleInboundSms`, set `email_last_message_id` so replies thread). Not built yet; today email is outbound + Outlook drafts.
5. Mark listings closed when HubSpot `listing_status` = sold; sync `02 - Under Contract` folders too.
6. HubSpot meetings webhook → mark `booked` automatically.
7. Weekly digest to Pierce: open questions, pending approvals, leads gone quiet, qa_bank growth.
8. Feedback loop: diff Pierce's `E#` edits against drafts, surface recurring changes as playbook suggestions (never auto-edit the playbook).
