# houzs-mail-sync — Gmail IMAP -> ERP

Pulls mail from the company **Gmail (Google Workspace)** mailboxes into the ERP
Mail Center — with **no MX change**.

The mailboxes (`hello@` plus the department mailboxes `operation@` / `sales@` /
`marketing@` / `finance@` / `hr@houzscentury.com`) stay on Google Workspace.
This job connects to **each one** over **IMAP, read-only** (it never marks your
mail as read) and POSTs every message to the ERP's
`POST /api/mail-center/inbound`. The ERP **dedups by Message-ID**, so re-running
— including the one-time history backfill — never creates duplicates, and a
message cross-posted to two mailboxes is stored once.

**Multi-mailbox:** each department mailbox is a **separate Google account** with
its **own login and its own App Password**. List them all in `IMAP_ACCOUNTS`
(below) and the job pulls each in turn, attributing every message to the mailbox
it was fetched from. A single account failing (bad app password, IMAP disabled)
is logged and the run continues to the next mailbox.

It runs on a **GitHub Actions cron** (`.github/workflows/mail-sync.yml`), every
5 minutes. It is NOT part of the Cloudflare Worker — it's an independent Node
script, so it can use the mature `imapflow` IMAP client + `mailparser`.

This replaces the need for a Cloudflare Email-Routing / MX-cutover path: the
mail stays on Gmail, the ERP just reads it. Both paths feed the same ingest.

## One-time setup

### 1. Pick a shared secret

Generate a random string **>= 16 chars** (the inbound secret). You set the
**same value** in two places:

- **GitHub** -> repo **Settings -> Secrets and variables -> Actions -> New repository secret**
  - `MAIL_INBOUND_SECRET` = _that string_
- **The ERP worker** (Cloudflare) -> set `MAIL_INBOUND_SECRET` as a Worker
  secret (`wrangler secret put MAIL_INBOUND_SECRET`, or via the dashboard) =
  _the same string_. The ERP returns **503** on `/api/mail-center/inbound` until
  this is set and >= 16 chars, and **401** if the header doesn't match.

### 2. Enable IMAP + create a Google App Password for EACH mailbox

Do this **once per account** — `hello@`, `operation@`, `sales@`, `marketing@`,
`finance@`, `hr@houzscentury.com`. For each one, signed in as that account:

1. **Enable 2-Step Verification** — Google Account -> Security -> 2-Step
   Verification (required before app passwords are available).
2. **Create an App Password** — Google Account -> Security -> App passwords ->
   generate one (name it e.g. "ERP mail sync"). Copy the 16-char password.
   This is what goes in `IMAP_ACCOUNTS` for that account — NOT the normal
   account password.
3. **Enable IMAP** — Gmail -> Settings (gear) -> See all settings ->
   Forwarding and POP/IMAP -> **Enable IMAP** -> Save. (Workspace admins:
   ensure IMAP access is allowed for the org / OU in the Admin console.)

### 3. Add the GitHub secrets

Repo **Settings -> Secrets and variables -> Actions**:

| Secret name | Value |
|---|---|
| `MAIL_INBOUND_SECRET` | the shared secret from step 1 (also on the ERP worker) |
| `IMAP_ACCOUNTS` | a **JSON array** of every mailbox account (see below) |

`IMAP_ACCOUNTS` is a single-line JSON array of `{ "user", "password" }` objects
— one per Google account, each `password` the App Password from step 2:

```json
[{"user":"hello@houzscentury.com","password":"abcd efgh ijkl mnop"},{"user":"operation@houzscentury.com","password":"…"},{"user":"sales@houzscentury.com","password":"…"},{"user":"marketing@houzscentury.com","password":"…"},{"user":"finance@houzscentury.com","password":"…"},{"user":"hr@houzscentury.com","password":"…"}]
```

> Spaces inside an app password are fine (Google shows them in groups of 4) —
> Gmail accepts the password with or without them. Keep the whole value on one
> line when you paste it into the GitHub secret.

**Single mailbox / merge semantics:** `IMAP_USER` (the Gmail address) +
`IMAP_PASSWORD` (its App Password) always work on their own, and they **MERGE**
with `IMAP_ACCOUNTS` (de-duplicated by address). So to add another company's
mailbox — e.g. `hello@2990shome.com` — set `IMAP_ACCOUNTS` to a one-entry array
with just the new account and leave the existing `IMAP_USER`/`IMAP_PASSWORD`
untouched.

Optional repo **Variable** (not a secret) — only if you want a non-default URL:

| Variable name | Value |
|---|---|
| `MAIL_INBOUND_URL` | defaults to `https://autocount-sync-api.houzs-erp.workers.dev/api/mail-center/inbound` |

Other defaults you usually don't touch (override via repo **Variables**),
applied to **every** account: `IMAP_HOST` = `imap.gmail.com`,
`IMAP_PORT` = `993`, `IMAP_MAILBOX` = `INBOX`.

## First run (import history)

Actions tab -> **Mail Sync (Gmail IMAP -> ERP)** -> **Run workflow** ->
tick **backfill** -> Run. This imports all existing INBOX mail for **every**
account in `IMAP_ACCOUNTS`. Watch the run log for the per-mailbox summary
(`<address>: N seen, N new, N dup, N failed`) — one line per account.

After that, leave it — the cron keeps pulling new mail every 5 minutes.

> **Cron + branch:** scheduled runs only fire from the repo's **default** branch.
> To test on a feature branch first, use **Run workflow** (manual) and pick that
> branch — it runs this file from whatever branch you select. Once the workflow
> file is on the default branch, the 5-minute cron is automatic.

## Notes / limits

- **Read-only**: opens the folder with EXAMINE and fetches with `BODY.PEEK[]`,
  so unread counts in Gmail are never touched.
- **Incremental window**: each cron run fetches the last `SINCE_DAYS` (default 3)
  and relies on Message-ID dedup — robust against missed ticks / downtime.
- **INBOX only** for now (incoming mail). To mirror mail sent from Gmail webmail,
  point `IMAP_MAILBOX` at `[Gmail]/Sent Mail` in a second job later.
- This handles **receive**. Sending from the ERP is a separate path (the Mail
  Center send flow).
