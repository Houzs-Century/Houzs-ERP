> **ARCHIVED 2026-08-13.** The receive-path decision this guide asks the owner to make was made: inbound runs through the `mail-sync/` IMAP poller into `backend/src/routes/mail-inbound.ts`. Superseded by `docs/modules/mail-center.md` (**2026-08-04**). Kept for history; do not follow it as a current instruction.

# Mail Center — go-live guide (owner actions)

The Mail Center has three parts. Two work as soon as the code deploys; one (RECEIVING)
needs the owner steps below.

| Part | How it works | Needs owner action? |
|---|---|---|
| **Staff read mail** | inside the ERP Mail Center page, via their normal ERP login | No — works on deploy |
| **Send / reply** | Resend API (`sendEmail`), from `@houzscentury.com` | Yes — verify the domain in Resend (Stage 1) |
| **Receive into the inbox** | inbound email → our `/api/mail-center/inbound` → DB | Yes — pick a path (Stage 2) |

**Note:** with this design there is normally **no traditional "mailbox password"** — staff
read in the ERP (ERP login), we send via Resend's API, and we receive via routing/polling.
A mailbox password is only needed if you choose the IMAP path (2B) for an EXISTING mailbox.

---

## THE ONE DECISION: how do we RECEIVE mail? (2A vs 2B)

### Path 2A — Cloudflare Email Routing (change MX)
Cloudflare receives all `@houzscentury.com` mail and routes it to a small Email Worker that
POSTs each message to our `/inbound` endpoint.
- Pros: free, real-time, no mailbox passwords, matches the built code.
- Cons: **changing the MX records is domain-wide** — ALL mail for `houzscentury.com` starts
  going through Cloudflare. If you currently receive mail somewhere else (Google Workspace,
  Hostinger), that flow is redirected. Do this only if there is no existing mail you must keep,
  or you are moving it to Cloudflare on purpose.
- Best when: the addresses are new, or you want everything on Cloudflare.

### Path 2B — IMAP polling (keep MX + your existing mailboxes; uses the mailbox password)
We keep your current mailboxes and MX. A scheduled job logs into each mailbox over IMAP and
pulls new mail into the inbox.
- Pros: **no MX change**, nothing disrupted, works with your existing `hello@`/`support@` mailboxes.
- Cons: not real-time (polls every few minutes), needs the **mailbox password** stored as a secret.
- Best when: you already have working `@houzscentury.com` mailboxes you want to keep.

**Your "邮箱密码" comment fits Path 2B.** Tell me: do you already have working `@houzscentury.com`
mailboxes (e.g. on Google Workspace / Hostinger), or not yet? -> picks 2A vs 2B.

---

## Stage 1 — Outbound (do this either way): verify the domain in Resend
1. Resend dashboard -> Domains -> Add `houzscentury.com`.
2. Resend shows ~3 DNS records (an SPF TXT, a DKIM record, a return-path) — add them to the
   `houzscentury.com` DNS (Cloudflare DNS panel).
3. Wait until Resend shows **Verified**. Now replies send reliably from `@houzscentury.com`.

## Stage 2A steps — Cloudflare Email Routing
1. Cloudflare dashboard -> `houzscentury.com` -> **Email -> Email Routing -> Enable** (this
   writes the MX + TXT records = the cutover).
2. Deploy the inbound Email Worker (I build `mail-inbound-worker`); bind it as the email handler.
3. Add routing rules: `hello@`, `support@`, … -> the Email Worker.
4. The Worker POSTs to `https://autocount-sync-api.../api/mail-center/inbound` with the secret (Stage 3).

## Stage 2B steps — IMAP polling
1. Keep your MX as-is.
2. For each mailbox, give me: host, port, username, **app password** (you set these as worker
   secrets — I never see them). 
3. The scheduled job polls and ingests. (No MX change.)

## Stage 3 — the inbound secret (Path 2A)
- Generate a random string (>=16 chars).
- Set it on the main worker: `wrangler secret put MAIL_INBOUND_SECRET` (project `autocount-sync-api`).
- Put the same value in the Email Worker so it sends the `x-mail-secret` header.
- (You run these — I cannot set secrets.)

## Stage 4 — test before full cutover
- I first POST a sample message to `/inbound` to confirm it ingests into the DB (no MX needed yet).
- Then route ONE address, send a test email, confirm it lands in the Mail Center, then add the rest.

---

## Adding 2990's mailbox (hello@2990shome.com)

The code side shipped 2026-07-24 (`feat/mail-center-2990-domain`): inbound mail to
`@2990shome.com` is tagged company 2990, the mailbox-create domain check follows the
ACTIVE company's Branding, and reply/compose from a 2990 mailbox goes out as
"2990's Home". What remains is owner ops, in this order:

1. **Resend: verify `2990shome.com`** — Resend dashboard -> Domains -> Add
   `2990shome.com`, add the SPF/DKIM/return-path records to the 2990shome.com DNS,
   wait for **Verified**. Until this is done, sends FROM `hello@2990shome.com` fail.
2. **Google Workspace: the mailbox** — create/confirm `hello@2990shome.com`, enable
   2-Step Verification, create an App Password, enable IMAP (same steps as the
   Houzs mailboxes — see `mail-sync/README.md`).
3. **GitHub secret `IMAP_ACCOUNTS`** — set it to a ONE-entry array with just the
   new account: `[{"user":"hello@2990shome.com","password":"<app password>"}]`.
   The sync MERGES it with the existing `IMAP_USER`/`IMAP_PASSWORD` pair (which
   keeps pulling hello@houzscentury.com untouched). The next run starts pulling.
4. **ERP** — migration 0193 seeds both the 2990 Branding email and the
   `hello@2990shome.com` mailbox row on deploy. What remains manual: Mail Center
   -> Mailboxes (2990 active) -> assign who can read/send from it.
5. **Test** — compose from `hello@2990shome.com` to an external address; send a
   reply back and confirm it lands in the Mail Center tagged 2990.

Already true today (verified 2026-07-24): `2990shome.com`'s DNS is on Cloudflare
and its MX already points at Google (aspmx.l.google.com), so Google-side mail
for the domain exists — steps 1-3 are the only credential work.

## Owner action checklist
- [ ] Tell me: existing `@houzscentury.com` mailboxes? (picks 2A vs 2B)
- [ ] Tell me: which addresses feed the Mail Center (hello@/support@/sales@…)
- [ ] Stage 1: verify `houzscentury.com` in Resend (add DNS records)
- [ ] Stage 2A: enable Cloudflare Email Routing + deploy the Email Worker + routing rules
      OR Stage 2B: provide IMAP host/user/app-password per mailbox
- [ ] Stage 3 (2A): `wrangler secret put MAIL_INBOUND_SECRET` on autocount-sync-api + the Email Worker
- [ ] Stage 4: test one address, then go live
