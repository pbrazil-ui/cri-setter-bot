# Handoff to Claude Code

Pierce: this is the file to follow. Everything below is copy-paste. Steps 1-3 take ten minutes.
After that, Claude Code does the work and stops when it needs a key or a decision from you.

## 1. Install Claude Code on the Mac (one time)

Open Terminal (Cmd+Space, type Terminal) and paste:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

If `npm` is not found, install Node first: https://nodejs.org (LTS), then re-run the two lines.
First `claude` run asks you to log in. Use the same Anthropic account as the Claude app.

## 2. Put the repo on GitHub (one time)

GitHub is required: Railway deploys from it, and Claude Code pushes to it.

1. Unzip `cri-setter-bot.zip` into `~/Projects` (so you have `~/Projects/cri-setter-bot`).
2. Install the GitHub CLI if you don't have it: `brew install gh` (if `brew` is missing: https://brew.sh), then `gh auth login` and follow the prompts (GitHub.com, HTTPS, log in with browser).
3. Paste:

```bash
cd ~/Projects/cri-setter-bot
git init
git add .
git commit -m "CRI setter bot"
gh repo create cri-setter-bot --private --source=. --push
```

Done when it prints a URL like https://github.com/<you>/cri-setter-bot.

## 3. Start Claude Code in the repo

```bash
cd ~/Projects/cri-setter-bot
claude
```

Paste this as the first message:

> Read CLAUDE.md, then docs/ and CONTEXT-NEEDED.md. Run `npm install` and `npm test`, fix anything that breaks, commit the lockfile and push. Then walk me through README.md setup one step at a time: Supabase, RingCentral, Dropbox, Microsoft 365, Claude API, HubSpot, Railway, lead forwarding, document sync. Stop at every step that needs a key or a decision from me and tell me exactly where to click. Keep `test_mode` on in playbook/policies.json until I say otherwise. Never send anything external without my explicit OK.

Claude Code will ask you for keys as it goes. Paste them into Railway's Variables tab (never into the chat log or a file in the repo). Every key is listed with where to get it in `.env.example`.

## 4. What you'll be asked for, in order

| Step | You do | Time |
|---|---|---|
| Supabase | Create project, run `supabase/schema.sql`, copy URL + service_role key | 5 min |
| RingCentral | Developer app (JWT), copy client id/secret/JWT; confirm 10DLC status | 15 min, then wait on 10DLC |
| Dropbox | Developer app with the 5 scopes, one-time refresh token (commands in `.env.example`) | 10 min |
| Microsoft 365 | Entra app registration, `Mail.ReadWrite`, admin consent (this is the tenant admin step) | 15 min, admin needed |
| Claude API | console.anthropic.com key, $50/mo limit | 2 min |
| HubSpot | Private app token (contacts + deals) | 3 min |
| Railway | Deploy from GitHub, paste variables, generate domain | 10 min |
| Leads in | Outlook rule forwarding Crexi/LoopNet/RVParkStore/MHVillage emails to the Postmark address | 10 min |
| Docs | `/admin/sync-docs`, fix any unmatched Dropbox folders, fill asking price/summary per listing | 20 min |

## 5. Then: a week in test mode

Every message the bot wants to send comes to your cell as a draft (`Y12` to send, `E12 your words` to fix it).
Every question it can't answer comes as `Q7`; answer with `A7 ...` and it's remembered.
Morning Broker Brief arrives at 7:30.

After a week, tell Claude Code: "Turn off test_mode and set these policies to auto: ..." naming the ones whose
drafts never needed edits.

## 6. Day-to-day with Claude Code

- Change how the bot talks: edit `playbook/setter-playbook.md`, then `git commit -am "playbook" && git push`. Railway redeploys.
- Change what's automatic: edit `playbook/policies.json`, same push.
- New listing: appears from HubSpot automatically; its Dropbox folder syncs within the hour.
- Something broke: `claude` in the repo, paste the error from Railway logs.
- Next build phases are listed at the bottom of CLAUDE.md (inbound email replies, dashboard, buyer matching). Ask Claude Code for one at a time.

## Secrets rule

Keys live in Railway Variables (and a local `.env` that is git-ignored). Never in CLAUDE.md, the playbook, a commit, or a chat you might share.
