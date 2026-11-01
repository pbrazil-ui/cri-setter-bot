# Setup prompt for a browser Claude (Claude in Chrome / Claude Desktop with computer use)

Pierce: do the two Terminal steps first (30 seconds), then paste everything inside the box below into a Claude
that can drive your browser. It clicks through each site; you log in when asked, and approve anything that
needs an admin or a credit card. It stops and asks whenever it needs you.

## Before you start: Terminal on your Mac (Cmd+Space, "Terminal")
Run this twice and keep both outputs in your password manager. The first is `INGEST_SECRET`, the second is
`RC_VERIFICATION_TOKEN`:

```bash
openssl rand -hex 24
```

You'll come back to Terminal once more in step 5 (Dropbox). Claude will give you the exact command.

---

```
You are setting up Pierce Brazil's CRI setter bot (GitHub: pbrazil-ui/cri-setter-bot, branch
claude/project-setup-integrations-un1lo6). Work in his browser, one site at a time, in the order below.

RULES
- Never type a key, secret or token into this chat, a document, a note or any field other than its destination.
  Copy it from the page that shows it and paste it straight into Railway's Variables (or ask Pierce to).
- Stop and ask Pierce whenever a page wants a login, 2FA, payment, an admin approval, or a choice not written here.
- Do not send any email or text, and do not change anything in HubSpot, Dropbox files, or Outlook mail.
- Keep a running checklist in this chat: done / blocked (and why). No secrets in it.

1. SUPABASE (supabase.com, project ccnybuifsgwwuqasjqmu)
   a. SQL Editor > New query. Open
      https://github.com/pbrazil-ui/cri-setter-bot/blob/claude/project-setup-integrations-un1lo6/supabase/schema.sql
      click "Raw", copy everything, paste, Run. Expect "Success. No rows returned." (Safe to re-run.)
   b. Table Editor: confirm 13 tables, and that "leads" has a column first_email_at.
   c. Project Settings > API Keys: you'll need the service_role key (Legacy tab) or the Secret key (sb_secret_...)
      for SUPABASE_SERVICE_ROLE_KEY in step 7.

2. CLAUDE API (console.anthropic.com)
   a. API Keys > Create Key, name "cri-setter-bot". Needed for ANTHROPIC_API_KEY.
   b. Settings > Limits: set a monthly spend limit of $50 (ask Pierce to confirm the amount).

3. HUBSPOT (app.hubspot.com, portal 44904909)
   Settings (gear) > Integrations > Private Apps > Create a private app, name "CRI Setter Bot".
   Scopes: crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.deals.read, crm.objects.deals.write.
   Create, then "Show token": needed for HUBSPOT_TOKEN.

4. RINGCENTRAL (developers.ringcentral.com > Console)
   Pierce says the texting number is already 10DLC-verified. Ask him which number it is (RC_FROM_NUMBER, +1XXXXXXXXXX)
   and his cell for approvals (OWNER_PHONE, must be a different number).
   a. Register App > REST API App. Auth: JWT auth flow. Private / server-only (no UI).
      Permissions: SMS, Read Messages, Webhook Subscriptions, Read Accounts. Create.
   b. Use the PRODUCTION credentials (Client ID, Client Secret). If only Sandbox is shown, click "Apply for production"
      and tell Pierce it is pending.
   c. Profile menu > Credentials > Create JWT, for the user who owns the texting number, restricted to this app.
      Needed for RC_JWT. RC_SERVER is https://platform.ringcentral.com

5. DROPBOX (dropbox.com/developers/apps, logged in as pbrazil@cricommercial.com)
   a. Create app > Scoped access > Full Dropbox > name "CRI Setter Bot".
   b. Permissions tab: check files.metadata.read, files.content.read, sharing.read, sharing.write. Submit.
      Do NOT add any team scopes (team_data.*, members.*): they break the bot.
   c. Settings tab: note App key and App secret (DROPBOX_APP_KEY, DROPBOX_APP_SECRET).
   d. Open https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
      (replace APP_KEY), click Allow, and have Pierce copy the code it shows.
   e. Give Pierce this to run in Terminal right away (codes expire in minutes), with his values filled in by him:
      curl https://api.dropboxapi.com/oauth2/token -d code=CODE -d grant_type=authorization_code -u APP_KEY:APP_SECRET
      The "refresh_token" in the reply is DROPBOX_REFRESH_TOKEN. He pastes it into Railway himself.

6. MICROSOFT 365 (entra.microsoft.com). Needs a tenant admin; stop and ask Pierce if blocked.
   a. App registrations > New registration, name "CRI Setter Bot", single tenant. Register.
   b. Overview: Directory (tenant) ID = MS_TENANT_ID, Application (client) ID = MS_CLIENT_ID.
   c. API permissions > Add > Microsoft Graph > Application permissions: Mail.ReadWrite and Mail.Send.
      Then "Grant admin consent". Both must show a green check.
   d. Certificates & secrets > New client secret, 24 months. Copy the VALUE (not the Secret ID) = MS_CLIENT_SECRET.
      Tell Pierce the expiry date so he can calendar it.
   e. Confirm with Pierce that pbrazil@cribrokerage.com is a mailbox in THIS tenant.

7. RAILWAY (railway.com). Railway, not Vercel: the bot is a server that runs timers all day.
   a. New Project > Deploy from GitHub repo > pbrazil-ui/cri-setter-bot.
   b. Service > Settings > Source > Branch: claude/project-setup-integrations-un1lo6.
   c. Settings > Networking > Generate Domain. That URL (https://..., no trailing slash) is PUBLIC_URL.
   d. Variables > Raw Editor. If a POLICY_TEST_MODE variable already exists, delete it (playbook/policies.json decides).
      Paste the block below, then fill every <...> from the steps above
      (Pierce pastes INGEST_SECRET, RC_VERIFICATION_TOKEN and DROPBOX_REFRESH_TOKEN himself):

INGEST_SECRET=<Pierce's first Terminal output>
PUBLIC_URL=<from 7c>
TIMEZONE=America/Los_Angeles
DB_MODE=supabase
SMS_MODE=live
LLM_MODE=live
SUPABASE_URL=https://ccnybuifsgwwuqasjqmu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<1c>
ANTHROPIC_API_KEY=<2a>
HUBSPOT_TOKEN=<3>
HUBSPOT_OWNER_ID=2145826500
RC_SERVER=https://platform.ringcentral.com
RC_CLIENT_ID=<4b>
RC_CLIENT_SECRET=<4b>
RC_JWT=<4c>
RC_FROM_NUMBER=<texting number, +1...>
RC_VERIFICATION_TOKEN=<Pierce's second Terminal output>
OWNER_PHONE=<Pierce's cell, +1...>
OWNER_EMAIL=pbrazil@cribrokerage.com
DROPBOX_APP_KEY=<5c>
DROPBOX_APP_SECRET=<5c>
DROPBOX_REFRESH_TOKEN=<5e>
MS_TENANT_ID=<6b>
MS_CLIENT_ID=<6b>
MS_CLIENT_SECRET=<6d>
EMAIL_MAILBOX=pbrazil@cribrokerage.com
EMAIL_SEND_MODE=send
EMAIL_SIGNATURE_HTML=<ask Pierce for his signature; paste as simple HTML, e.g. <p>Pierce Brazil<br>CRI Brokerage<br>PHONE</p>>
DISCLOSE_AI=false

      If RingCentral (step 4) isn't finished, set SMS_MODE=mock for now: the app refuses to start with missing
      RingCentral values. Same for Microsoft: if step 6 isn't done, delete the MS_* lines (email is skipped).
   e. Deploy. Deployments > latest > View logs. Healthy looks like:
      "CRI setter bot on :PORT (db=supabase sms=live llm=live)", "[rc subscription]", "[listings] synced N from HubSpot",
      and about a minute later "[dropbox sync]". Copy any line containing "error", "FAILED" or "Missing env vars" for Pierce.
   f. Open PUBLIC_URL/health in a tab. Expect {"ok":true,"paused":false,"db":"supabase","sms":"live","llm":"live"}.
   g. Ask Pierce to open PUBLIC_URL/admin/selftest?key=INGEST_SECRET himself (the key is in the URL, so you don't type it).
      It checks Supabase, Claude, RingCentral (number is SMS-enabled, webhook active), HubSpot, Dropbox and Outlook
      without sending anything. Every check should say "ok": true. Fix anything under "problems" before going further.

8. UPTIME (uptimerobot.com, free plan)
   New monitor > HTTP(s) > URL: PUBLIC_URL/health > every 5 minutes > alert contact: Pierce's email and cell.

9. REPORT to Pierce: the Railway domain, the /health result, the checklist, and anything blocked.
   Remind him: test_mode is OFF (his call, Nov 1 2026). New inquiries get the email and text automatically; price,
   terms, legal, sensitive documents and LoopNet "saved" texts still come to his phone for Y#. PAUSE stops everything.
```

## After the browser Claude finishes
1. From your cell, text `STATUS` to the RingCentral number. A reply means texting in and out works.
2. Send me (Claude Code) the Railway domain. I'll check `/health` and the logs with you.
3. Live test before a real buyer hits it: submit an inquiry on one of your own Crexi or LoopNet listings using a
   second phone and an email you control (not your cell, which is the command line). Within ~2 minutes that inbox
   gets the email; 4–6 minutes later the phone gets the text. Reply from the test phone with a question and watch
   the answer come back 45 seconds to 5 minutes later. Text `PAUSE` from your cell if anything looks wrong.
4. Morning Broker Brief arrives at 7:30 every day. If it doesn't, something is down (UptimeRobot should have told you).
