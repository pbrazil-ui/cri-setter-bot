# CRI Setter Bot

Pierce Brazil's inbound brokerage assistant. A lead inquires on Crexi, LoopNet, RVParkStore, MHVillage or the
website → texted (RingCentral) or emailed (Outlook) within minutes → questions answered from the listing's
Dropbox documents with real math → qualified to CRI's standard → call booked → HubSpot Buyers pipeline updated.
What it can't answer, it asks Pierce by text and remembers his answer. Every morning it sends a Broker Brief.

Runs 24/7 on Render (https://cri-setter-bot.onrender.com). State in Supabase. Documents from Dropbox. Autonomy governed by `playbook/policies.json`.

```
Lead emails (Crexi/LoopNet/RVParkStore/MHVillage/forms) ─► /ingest/email ─┐
CSV exports ──────────────────────────────────────────────► /ingest/csv ──┼─► Supabase
Zapier / HubSpot workflow ────────────────────────────────► /ingest/lead ─┘      │
                                                                                  ▼
RingCentral SMS ◄──► /webhooks/ringcentral ◄──► Setter (Claude + tools) ──► HubSpot (contact, Buyers deal, notes)
Outlook (Graph)  ◄── drafts / sends            │  ▲                       
                                               │  └── Dropbox: OM, rent roll, P&L, seller Q&A, rules, past emails
Pierce's cell ◄── approvals (Y/N/E), questions (A#), CA#, PAUSE, Morning Broker Brief
```

## What it does, concretely
- **New inquiry**: 1–2 min later an email as Pierce with the summary, listing page, public flyer links, the CA link and three qualifying questions; 4–6 min after that a text ("Hey Jane, this is Pierce over at CRI. Just sent you an email with the info on Lighthouse Resort, so check your inbox... Are you buying on your own or with a group?"). Texts only go out 8am–8pm Mon–Sat PT; emails any hour. No "Reply STOP" line, no AI announcement (Pierce's call; opt-outs still handled in code; "are you a bot?" goes to Pierce).
- **Under contract / sold** (HubSpot stage or Dropbox `02 - Under Contract`): "That one is under contract, but I have other listings I can share. What are you looking for?" Pierce gets their criteria as a MATCH text. No documents on that deal.
- **LoopNet "saved your listing"**: same email; the text waits for Pierce's Y.
- **They go quiet**: day 1 text + a HubSpot call task for Pierce (the bot can't call and never says it did), day 3 email, day 7 text, then a listings email every 2 weeks to 3 months and monthly after, until they reply, say no or opt out.
- **They email back**: answered by email in the same thread, unless Pierce already replied there.
- **They reply**: waits a random 45 seconds to 5 minutes (a burst of texts gets one answer, never two texts within 45s), then responds. Facts come from tools, not memory:
  - `rent_roll_stats` → exact unit mix (MH / RV / park model), occupancy, POH/TOH, average rents, in-place rent.
  - `financial_summary` → income, expenses, NOI, expense ratio from the seller's P&Ls, with discrepancies flagged.
  - `search_documents` → OM, seller Q&A, rules, permits, utilities, inspections.
  - `prior_conversations` → Pierce's past emails on this listing ("has seller financing come up before?").
  - `calculate` → every derived number. `get_document_link` → view-only Dropbox link, or an email attachment when policy blocks public links.
- **CA gate**: before the CA is verified, only public info; the bot sends the CA link. `CA34` from Pierce (or Crexi's "signed CA" activity) unlocks OM, rent roll, financials and moves the lead to **in DD**.
- **Can't answer** → short holding reply to the buyer, `Q7` to Pierce. `A7 your answer` → reworded for the buyer and saved; the next buyer who asks gets it instantly.
- **Sensitive material** (inspections, water tests, leases, compliance, past correspondence): bot may read it, but the reply waits for your `Y`.
- **Price, offers, terms, commission, co-broke, legal**: never auto. Draft goes to you; thread muted until you hand it back.
- **Follow-ups**: pre-CA days 1/3/7 then closed out. In DD days 2/5/10/21, then Pierce is told, never auto-closed. Paused while a question is open with Pierce.
- **STOP / "remove me" / "wrong number"**: permanent opt-out, deal closed, never contacted again.
- **HubSpot**: one Buyers deal per buyer per listing (`listing_code`). New buyer → Qualified on qualify/book. Closed Lost only from New buyer. Never touches Offer Out or later. Notes on every meaningful event.
- **Morning Broker Brief** at 7:30am: what it did, who replied, what's booked/qualified, what's stalled, and the few `Y#`/`A#` decisions that need you. Short by text, full by email.

## Autonomy model (your Levels 1/2/3) - `playbook/policies.json`
Every outbound message is classified (`first_touch.listing_email`, `reply.ca_docs`, `reply.sensitive_docs`, `escalate.price_terms_legal`, …) and resolved to **auto**, **approve** or **block**. Change the file, redeploy, done.
- `test_mode: true` → nothing external goes out; every message becomes an approval so you can watch what it *would* do. (Off since Nov 1 2026, Pierce's call.)
- `emergency_stop: true` (or text `PAUSE`) → global stop on external actions.
- Limits: per-lead daily cap, hourly auto-send budget, max pending approvals, approval expiry (48h; stale drafts never send).
- Audit trail (`audit_log`): every send, draft, approval, edit, escalation, question, answer, stage move, opt-out, with actor (bot / pierce / system). Your `E#` edits are stored original-vs-final to feed the writing-style loop.

## Pierce's text commands (from `OWNER_PHONE` to the RingCentral number)
| Text | Does |
|---|---|
| `Y12` / `YA` | send draft #12 / all pending |
| `N12` | skip #12 |
| `E12 your words` | send your wording instead (logged as feedback) |
| `A7 your answer` | answer question Q7; reworded for the buyer, saved for future buyers |
| `CA34` | CA verified for lead L34: unlocks docs, status → in DD |
| `T34` / `B34` | take over L34 (bot quiet) / hand back |
| `PAUSE` / `RESUME` | kill switch |
| `STATUS` / `HELP` | counts and pending items / command list |

---

## Setup

### 0. Start today: 10DLC
Business texting needs an approved 10DLC campaign (RingCentral Admin → Phone System → Business SMS). Days to weeks. Use case: "replying to buyers who inquired on our property listings." Sample texts: `playbook/templates.json`.

### 1. GitHub + Claude Code
Yes, GitHub is required: Render deploys from it and Claude Code works out of it.
```bash
cd cri-setter-bot
git init && git add . && git commit -m "CRI setter bot"
gh repo create cri-setter-bot --private --source=. --push
```
Open the repo in Claude Code (CLI: `claude` in the folder; or claude.ai/code → connect repo). First prompt:

> Read CLAUDE.md, then docs/ and CONTEXT-NEEDED.md. Run `npm install` and `npm test`, commit the lockfile, push. Then walk me through README setup one step at a time, stopping wherever you need a key or a decision from me. Keep test_mode on until I say otherwise.

### 2. Supabase
New project (West US) → SQL Editor → paste `supabase/schema.sql` → Run → copy Project URL + `service_role` key.

### 3. RingCentral
developers.ringcentral.com → Create App → REST API, server-only, **JWT** auth. Permissions: SMS, Read Messages, Webhook Subscriptions, Read Accounts. Create a JWT for the texting number's user. Request production graduation.

### 4. Dropbox
dropbox.com/developers → Create app → Scoped access, Full Dropbox. Permissions: `files.metadata.read`, `files.content.read`, `sharing.read`, `sharing.write` (no team scopes: a team scope makes the token team-linked and breaks the per-user calls; the team space is reached with the root-namespace path-root header instead). Get a refresh token once (commands in `.env.example`). Check Admin → Settings → Sharing: if links are "team only", documents go out as email attachments instead of links (handled automatically).

### 5. Microsoft 365 (email)
Entra → App registration (Mail.ReadWrite + Mail.Send listed, NO admin consent) → Exchange RBAC for Applications scoped to pbrazil@cribrokerage.com only, verified with `Test-ServicePrincipalAuthorization` (SETUP-PROMPT step 6). Without this, email-only leads are flagged to you instead of emailed; everything else works.

### 6. Claude API, HubSpot
console.anthropic.com key (set a $50/mo limit to start). HubSpot → service key "CRI Setter Bot" (no private apps on this account) → contacts + deals read/write (+ notes/tasks if offered).

### 7. Render
Web service `cri-setter-bot` (Starter, always on), auto-deploys `claude/project-setup-integrations-un1lo6`, `npm start`, health check `/health`. Set variables in Render > Environment (names in `.env.example`, mirrored in `render.yaml`). Keep `SMS_MODE=mock` and `EMAIL_SEND_MODE=draft` until `/admin/selftest` passes. Logs should show `[lease] ... running the job loops`, `[listings] synced`, `[dropbox sync]`.

### 8. Leads in
Automatic once Microsoft 365 is connected: every minute the bot reads new emails in your inbox **from** crexi.com, loopnet.com, rvparkstore.com, mhvillage.com (and HubSpot form notifications) and turns them into leads. No Postmark, no forwarding rule. `EMAIL_POLL_LEADS=false` turns it off. `/ingest/email` still accepts Postmark/Zapier posts if you ever need them. Lists: `https://DOMAIN/upload?key=SECRET` on your phone.

### 8b. Check everything
`https://DOMAIN/admin/selftest?key=SECRET` checks Supabase, Claude, RingCentral (number SMS-enabled, webhook active), HubSpot, Dropbox and Outlook without sending anything.

### 9. Documents
`POST /admin/sync-docs?key=SECRET`. Check the log for `unmatched_folders` (Dropbox folder names that didn't match a HubSpot listing) and fix with `listings.dropbox_path` or an alias. Then `POST /admin/import-email-history?key=SECRET&days=365` to index your past threads per listing. In Supabase → `listings`, fill `asking_price`, `spaces`, `summary`, `do_not_share` for each.

### 10. Watch it in test mode for a week
`policies.json` ships with `test_mode: true`. Every message comes to you as an approval. When the drafts stop needing edits, set `test_mode: false` and flip the Level 2 policies you trust to `auto`.

## Try the document brain directly
```bash
curl -X POST "https://DOMAIN/api/ask?key=SECRET" -H 'Content-Type: application/json' \
  -d '{"listing":"Lighthouse","question":"What is the unit mix and current NOI?","ca_verified":true}'
```

## Costs (estimates)
Render Starter $7 · Supabase Pro $25 (recommended: daily backups of the lead/Q&A data) · Claude $20–150/mo depending on volume (document extraction is the big one on first sync) · RingCentral SMS per plan · UptimeRobot free. No Postmark needed.

## Compliance (not legal advice; have counsel review)
Texting people about a listing they inquired on is the defensible core; cold lists aren't, which is why CSV uploads require approval. California requires bots to disclose they're bots (B&P §17941): the first text says "AI assistant". Opt-outs, quiet hours, rate limits and the CA gate are enforced in code, not in the prompt.
