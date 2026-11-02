# Setup and go-live (Render)

Hosting is **Render**: web service `cri-setter-bot`, https://cri-setter-bot.onrender.com, Starter plan, auto-deploys every
push to `claude/project-setup-integrations-un1lo6`, start command `npm start`, health check `/health`. Secrets live only
in Render > cri-setter-bot > **Environment**. Never in chat, a file, or a commit.

The boxed part below can be pasted into a browser Claude (Claude in Chrome / Claude Desktop). It stops whenever it needs
a login, 2FA, an admin, or a value only Pierce has.

## Status (Nov 2 2026)
Done: Supabase schema · Claude API key with $50/mo limit · HubSpot service key "CRI Setter Bot" · RingCentral production
app (JWT) · Dropbox app · Entra app "CRI Setter Bot" (no consent) + Exchange RBAC for Applications on Pierce's mailbox ·
UptimeRobot on /health · Render service with the non-secret variables.

Pending in Render Environment: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `HUBSPOT_TOKEN`, `RC_CLIENT_SECRET`,
`RC_JWT`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`; then `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (after 6f
is verified); then `RC_FROM_NUMBER` and `OWNER_PHONE` (before SMS goes live). 10DLC status: confirm in RingCentral.

Keep `SMS_MODE=mock` and `EMAIL_SEND_MODE=draft` in Render until `/admin/selftest` passes. (The code default for
`EMAIL_SEND_MODE` is `send`, so the Render variable is what holds email in draft until then.)

---

```
You are helping Pierce Brazil finish his CRI setter bot (GitHub pbrazil-ui/cri-setter-bot, branch
claude/project-setup-integrations-un1lo6), hosted on Render as "cri-setter-bot". Work in his browser.

RULES
- Never type a key, secret or token into this chat, a document or any field other than its destination: Render >
  cri-setter-bot > Environment. Copy it from the page that shows it and paste it there, or ask Pierce to.
- Stop and ask Pierce for any login, 2FA, payment, admin approval, or choice not written here.
- Do not send email or texts, and do not change HubSpot records, Dropbox files or Outlook mail. Never delete anything.
- Microsoft: ONLY Pierce's mailbox (pbrazil@cribrokerage.com, alias pbrazil@cricommercial.com). Never grant tenant-wide
  admin consent: it would open all 42 mailboxes. Never open or test anyone else's mailbox.
- Keep a checklist in this chat: done / blocked (why). No secrets in it.

1. SUPABASE (project ccnybuifsgwwuqasjqmu)
   a. SQL Editor > New query. Open
      https://github.com/pbrazil-ui/cri-setter-bot/blob/claude/project-setup-integrations-un1lo6/supabase/schema.sql
      > Raw, copy all, paste, Run. Safe to re-run; it adds listings.owner_id and the job-lease functions.
   b. Project Settings > API Keys > service_role (Legacy) or Secret key: SUPABASE_SERVICE_ROLE_KEY.

2. CLAUDE API (console.anthropic.com): API Keys > the "cri-setter-bot" key: ANTHROPIC_API_KEY. Limit stays $50/mo.

3. HUBSPOT (portal 44904909): the SERVICE KEY "CRI Setter Bot" (this account has no private apps). Its token is
   HUBSPOT_TOKEN; it is sent as a Bearer token. Scopes it has: crm.objects.contacts.read/.write,
   crm.objects.deals.read/.write. If its scope list also offers crm.objects.notes.* or crm.objects.tasks.*, add them:
   the bot writes notes and call tasks. (If HubSpot refuses one, the bot texts Pierce once and keeps working.)

4. RINGCENTRAL (developers.ringcentral.com > Console > the production app, JWT flow, scopes Read Accounts, Read Messages,
   SMS, Webhook Subscriptions): Client Secret = RC_CLIENT_SECRET. Profile > Credentials > the JWT for the user who owns
   the texting number = RC_JWT. Ask Pierce for RC_FROM_NUMBER (+1...) and OWNER_PHONE (his cell, a different number),
   and check Admin > Phone System > Business SMS (10DLC) for the number's campaign status: tell Pierce what it says.

5. DROPBOX (dropbox.com/developers/apps > "CRI Setter Bot", 4 scopes): App secret = DROPBOX_APP_SECRET.
   Refresh token: open https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
   (APP_KEY is already in Render), Allow, and have Pierce run in Terminal within a few minutes, with his own values:
     curl https://api.dropboxapi.com/oauth2/token -d code=CODE -d grant_type=authorization_code -u APP_KEY:APP_SECRET
   The "refresh_token" in the reply is DROPBOX_REFRESH_TOKEN. Pierce pastes it into Render himself.

6. MICROSOFT (Entra app "CRI Setter Bot"). Access comes ONLY from Exchange RBAC for Applications, never Entra consent.
   a. Overview: Directory (tenant) ID = MS_TENANT_ID, Application (client) ID = MS_CLIENT_ID.
   b. Certificates & secrets: the client secret VALUE = MS_CLIENT_SECRET. Tell Pierce its expiry date.
   c. API permissions may list Mail.ReadWrite and Mail.Send. Do NOT click "Grant admin consent". If a green
      "Granted for <tenant>" check ever appears on them, stop and tell Pierce: revoke it before going further.
   d. EMAIL_MAILBOX = pbrazil@cribrokerage.com (pbrazil@cricommercial.com is an alias of the same inbox).
   e. (Already done by the admin; this is the reference.) In PowerShell (`pwsh`), Exchange Online:
        Connect-ExchangeOnline -UserPrincipalName <admin email>
        New-ServicePrincipal -AppId <MS_CLIENT_ID> -ObjectId <Enterprise applications > CRI Setter Bot > Object ID> -DisplayName "CRI Setter Bot"
        New-ManagementScope -Name "CRI Setter Bot - Pierce only" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'pbrazil@cribrokerage.com'"
        New-ManagementRoleAssignment -App <MS_CLIENT_ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "CRI Setter Bot - Pierce only"
        New-ManagementRoleAssignment -App <MS_CLIENT_ID> -Role "Application Mail.Send" -CustomResourceScope "CRI Setter Bot - Pierce only"
   f. VERIFY before MS_* go into Render (admin, PowerShell):
        Test-ServicePrincipalAuthorization -Identity <MS_CLIENT_ID> -Resource pbrazil@cribrokerage.com
          -> both "Application Mail.ReadWrite" and "Application Mail.Send" show InScope = True
        Test-ServicePrincipalAuthorization -Identity <MS_CLIENT_ID>
          -> lists ONLY those two roles, both on scope "CRI Setter Bot - Pierce only"; nothing tenant-wide
      This is an authorization lookup. Do not test against any other person's mailbox.
   g. Only after 6f passes: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET into Render.

7. RENDER (dashboard > cri-setter-bot > Environment). Add the pending values from steps 1-6, then Save (Render redeploys).
   Leave SMS_MODE=mock and EMAIL_SEND_MODE=draft. Logs (cri-setter-bot > Logs): a missing value prints one line,
   "Missing env vars: ...". Healthy: "CRI setter bot on :10000 (db=supabase sms=mock llm=live email=live/draft
   dropbox=live)", "[lease] ... is running the job loops", "[listings] synced N from HubSpot", then "[dropbox sync]".

8. SELF-TEST: ask Pierce to open https://cri-setter-bot.onrender.com/admin/selftest?key=INGEST_SECRET himself (the key
   is in Render). It checks the database (incl. new columns + lease), Claude, HubSpot (contacts, deals, notes/tasks read),
   Dropbox, and a real scoped read of Pierce's inbox. It sends nothing. Every check should say "ok": true.

9. GO LIVE (only after 8 passes and Pierce says so): in Render set RC_FROM_NUMBER, OWNER_PHONE, SMS_MODE=live,
   EMAIL_SEND_MODE=send. Save. Re-run the self-test: ringcentral must show the number SMS-enabled and the webhook Active.

10. REPORT: the checklist, the self-test result, 10DLC status, and anything blocked.
```

## After go-live
1. From your cell, text `STATUS` to the RingCentral number. A reply means texting in and out works.
2. Test before a real buyer: submit an inquiry on one of your own Crexi or LoopNet listings from a second phone and an
   email you control (not your cell, which is the command line). ~2 minutes: the email. 4–6 minutes later: the text.
   Reply with a question; the answer comes 45 seconds to 5 minutes later. Text `PAUSE` from your cell to stop everything.
3. The Morning Broker Brief arrives at 7:30. UptimeRobot alerts you if /health goes down.
