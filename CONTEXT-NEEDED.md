# What the bot needs from Pierce

Ordered by impact. 1–6 block go-live. The rest make it sound like you and answer more on its own.

## Blocking go-live (accounts and keys)
1. **RingCentral**: the texting number, its 10DLC campaign status, and a REST app (JWT auth, server-only) with
   SMS + Read Messages + Webhook Subscriptions permissions. Request production graduation early.
2. **Your cell** for approvals (`OWNER_PHONE`). Different from the texting number.
3. **Dropbox app** (dropbox.com/developers): scoped app, permissions `files.metadata.read`, `files.content.read`,
   `sharing.write`, `sharing.read`. No team scopes (they make the token team-linked; team folders are reached via path-root). Generate a refresh token once (README has the
   3-line script). Confirm the team's shared-link policy allows public view-only links; if it's "team only", every
   document goes out as an email attachment instead.
4. **Microsoft 365 app registration** for email: tenant ID, client ID, secret, application permission `Mail.ReadWrite`
   (+ `Mail.Send` if you ever flip `EMAIL_SEND_MODE=send`), admin consent, scoped to your mailbox with an
   application access policy. You noted the tenant needs admin action for writes; this is that.
5. **HubSpot private app** token (contacts + deals read/write) and your owner ID.
6. **Where lead emails land** and a real sample from each platform (Crexi, LoopNet, RVParkStore, MHVillage, HubSpot
   forms). Forward them as-is. RVParkStore's format is already covered by a test.

## Your voice (playbook/setter-playbook.md)
7. 3–5 real follow-up texts/emails that got replies. The single biggest lever.
8. 2–3 complete threads: one that went well, one that went badly, one with a tough question you handled.
9. Must-have qualification items before you'll take a call. Your co-broke / intermediary policy in two lines.
10. Confirm call windows: weekdays 9–10am or 2–4:30pm Pacific (from your time blocks). Booking link, if any.

## Listings
11. For each active listing: asking price, spaces, 2–3 sentence public summary, and a **do-not-share** note. The Dropbox
    sync fills everything else. Any Crexi/LoopNet names that differ from the HubSpot deal name → `aliases`.
12. Which Dropbox folders map to which HubSpot listings when the names differ (e.g. "Lighthouse Resort - Isleton, CA"
    vs the HubSpot deal "California Lighthouse Resort"). The sync guesses; check the log on first run.
13. Review `playbook/dropbox-rules.json`. It decides what's public / CA-gated / sensitive / excluded by folder and file
    name. Defaults are conservative (leases, inspections, water tests → Pierce reviews; contracts, financing, insurance,
    employment → never loaded). Change anything you'd handle differently.

## Decisions only you can make
14. ~~Auto-send or approve-first?~~ Pierce (Nov 1): email then text, automatic. test_mode stays on until he says otherwise.
15. Email: leave drafts in Outlook for you to send (default) or send automatically after the approval gate?
16. Should Crexi's "signed CA" activity unlock documents automatically (default yes), or only your `CA#` text?
17. Reply pacing: 1–5 minutes, bursts combined, 8-minute cap. Keep?
18. DD follow-up cadence: days 2, 5, 10, 21, then you decide. Keep?
19. Duplicate-deal risk: do any existing HubSpot workflows already create Buyers deals from inquiries? If yes, pick one.

## Questions I'd ask you before go-live (answer in one line each)
20. Which listings are live? Bot uses HubSpot stage Listed + Dropbox `01 - Listed`. To confirm: DCAR (HubSpot BOV) and NorCal Portfolio (HubSpot Closed Lost) have folders in `01 - Listed`, so the bot treats them as active. Seven HubSpot "Listed" deals have no Dropbox folder (Countryside Estates GA, Boneville Estates GA, 50 Davis St ME, Pinederosa Park GA, Arden Asheville, Star Mobile Estates, New Orchard Estates): are they publicly marketed?
21. ~~Under contract listings?~~ Pierce (Nov 1): say it's under contract, ask what else they want, share other deals. No backup-offer talk.
22. Lighthouse specifically: seller financing has been declined before per your correspondence. Standing answer the bot may give, or always route to you?
23. Who gets the Morning Broker Brief email besides you? Dylan?
24. Do you want Dylan able to text commands too (second OWNER phone)?

## Not needed from you (the system handles it)
- Reading rent rolls, P&Ls, OMs, seller Q&A, rules, permits from Dropbox: automatic, hourly, changed files only.
- Unit mix, occupancy, average rents, NOI, expense ratio, per-space math: computed in code from the documents.
- Answers you give via `A#` are saved per listing and reused for the next buyer who asks the same thing.
