# Mail Center

Shared team mailboxes inside the ERP — inbound mail lands in threads, and staff reply or compose from the mailbox address rather than from `no-reply@`.

## Statuses and flow

Sending goes through one durable queue: `sendEmail()` enqueues to `email_outbox` first, then attempts immediate delivery; a failure leaves the row `pending` and a `*/5` cron retries up to 3 attempts. `email_log` records every attempt; the outbox row records the current state.

A message with several recipients is always ONE provider call carrying arrays — never one call per recipient — so a mid-loop failure and its retry cannot deliver a second copy to whoever already received it.

Reply-all precedence: an explicit `to` from the caller always wins; otherwise To becomes the newest INBOUND message's `from_address` (falling back to the thread's `counterparty_email` only when there is no inbound message at all); when `replyAll: true` and the caller sent no `cc`, Cc is rebuilt from that inbound message's To+Cc, minus the caller's own mailbox-scope addresses and minus anyone already on To. Bcc is never reconstructed (it was blind, it stays blind) and never stored on the message row — only the provider and the ops-only outbox row ever see it.

## Permissions

- `canSendFrom()` — a non-admin may send only from a mailbox in their own scope, or their own alias (`users.email_alias`); admins may send from any mailbox.
- `purpose` / `isChannelEnabled()` gates delivery at both send time and drain time — a channel switched off after a message is enqueued stops its retry.
- `isMailAdmin` grants mailbox management rights only — it must never widen the company scope on outbox reads.

## Rules that must not break

- `recipientList()` is the one normaliser for To/Cc/Bcc — it de-duplicates case-insensitively; the same address in To and Cc would otherwise be delivered twice, and a reply-all that includes our own mailbox would loop mail back into its own thread.
- `to_addresses`/`cc_addresses` are JSON arrays — always read them with `parseJsonArray`; an outbound row written with only one address makes every other recipient invisible in the thread and drops them from the next reply-all.
- `email_outbox`'s schema exists in two migration trees (`migrations-pg/` for production, `migrations/` for D1 tests) — a column added to only one fails the test suite without a clear schema-related error; add it to both.
- `GET /outbox` and `GET /outbox/:id` must stay scoped to the active company via `activeCompanyCodePred` — `email_outbox` has no `company_id`, only a `company_code` text column, and `body_html` carries live one-time invite/reset-password links, so a widened predicate is a credential leak, not just a privacy gap.
- `scopeToCompanyIdOrOpen`'s open-on-null branch is for a helper already handed a resolved id, never for a route — a route must still call `requireActiveCompanyId` and refuse (409) when the company is unresolved, not read across every company.
- Mobile must call the same shared modules as desktop for recipient parsing, attachments, From-address defaulting, and label colours — three of these were previously re-implemented on the phone and each copy was missing a fix already made on desktop.

## Gotchas

- Composed mail validates and stores Cc/Bcc, but the compose send path does not currently pass them to the provider — the thread renders the Cc/Bcc recipients even though they never received the mail. Reply's Cc/Bcc do go out correctly; don't assume compose behaves the same way without checking.
- An attachment on a reply or compose is forwarded on the immediate send, but the outbox row is left retryable with no attachment column — if that send fails, the cron's retry delivers the mail BODY-ONLY. Set `outboxRetry: false` on any path where a body-only retry would be worse than no retry (the PO email path already does this).
- A member whose only sending identity is their `email_alias` (no `email_addresses` row) gets an EMPTY `/addresses` response from the mailbox-scope endpoint — the client must offer the alias explicitly rather than assume the list is complete.
- `replyAll` and `defaultFrom` are required (non-optional) props on the mobile reply/compose components on purpose — an omitted `replyAll` silently answers only one person on a mail that copied several, and an omitted `defaultFrom` silently falls back to the alphabetically first mailbox.
- A new label's colour must come from `LABEL_PALETTE`, never a hand-picked hex — the backend maps anything outside its own nine-colour allow-list to brand brown, so an off-palette colour is stored differently from what the picker showed.

## Where the code is

- `backend/src/routes/mail-inbound.ts` — inbound webhook + routing.
- `backend/src/routes/mail-center.ts` — threads, messages, compose, reply.
- `backend/src/services/email.ts` — `sendEmail`, `recipientList`, outbound queue.
- `backend/src/scm/lib/companyScope.ts` — the company-scope helper family.
- `frontend/src/pages/MailCenter/` — `Inbox.tsx`, `Thread.tsx`, `Compose.tsx`, and the shared modules (`mail-recipients.ts`, `mail-attach-files.ts`, `mail-from-default.ts`, `mail-labels.ts`, `mail-actions.ts`).
- `frontend/src/mobile/MobileMailCenter.tsx` — mobile surface.
