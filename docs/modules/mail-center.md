# Module: Mail Center

Shared team mailboxes inside the ERP — inbound mail lands in threads, and staff
reply or compose from the mailbox address rather than from `no-reply@`.

Written 2026-08-04 while adding multi-recipient support. There was no guide
before; per CLAUDE.md that gap is the thing to close, so this covers what the
module IS and the traps found while working in it, not every line of it.

## The pieces

| Layer | Where |
|---|---|
| Inbound webhook + routing | `backend/src/routes/mail-inbound.ts` |
| Threads, messages, compose, reply | `backend/src/routes/mail-center.ts` (~2100 lines) |
| Outbound send + durable queue | `backend/src/services/email.ts` |
| Screens | `frontend/src/pages/MailCenter/` — `Inbox.tsx`, `Thread.tsx`, `Compose.tsx` |
| Mobile | `frontend/src/mobile/MobileMailCenter.tsx` |

## Data model

| Table | Migration | Notes |
|---|---|---|
| `email_threads` | `0039_mail_center.sql` | one per conversation; carries `mailbox_address` and `counterparty_email` |
| `email_messages` | `0039` | `direction` inbound/outbound, `from_address`, **`to_addresses`**, **`cc_addresses`** (JSON arrays) |
| `email_outbox` | `0005`, +`0254` | the durable send queue: `to_address`, **`cc_address`**, **`bcc_address`**, `status`, `attempts` |
| `email_log` | — | per-attempt audit, separate from the queue |

## Sending: one queue row, one provider call

`sendEmail()` enqueues to `email_outbox` FIRST, then attempts an immediate
delivery. A failure leaves the row `pending` and the `*/5` cron
(`drainEmailOutbox`) retries it up to 3 attempts. `email_log` records every
attempt; the outbox records the state.

**ONE SEND, NEVER N SENDS.** A message with several recipients is a single
Resend call carrying arrays. This is not a style preference — looping per
recipient would let a mid-loop failure leave the row `pending`, and the cron
retry would then deliver a **second copy** to everyone who already had it. The
recipients live in one row and go out in one call; delivery either happens or
does not.

**The retry re-sends the same audience.** `cc_address`/`bcc_address` are stored
for exactly that reason — a retry that quietly dropped the Cc would be worse than
the failure it is recovering from.

## Recipients (2026-08-03/04)

Owner: *"为什么 Email Center 里面的 email 栏那边不能加多个或者 CC 谁吗?"* and
*"然后那些人回复我的话，我要怎么回复他?"*

Before this, the whole stack was single-recipient at **four layers** — the form
had one field, the route typed `to` as one string and validated it with a
single-address regex, `sendEmail` took one string, and the outbox had one column.
Resend has always accepted arrays and cc/bcc. The capability was there; nothing
above it asked for it.

`recipientList()` (`services/email.ts`) is the one normaliser: accepts a string,
an array, or a comma/semicolon-separated string; trims; drops anything without an
`@`; **de-duplicates case-insensitively**. That de-dup is load-bearing — the same
address in To and Cc makes the provider deliver twice, and a reply-all that
includes our own mailbox loops mail back into the thread it came from. Cc is
filtered against To, and Bcc against both.

### Reply-all

`POST /threads/:id/reply` used to have **no recipient field at all** — it replied
to `thread.counterparty_email` and nothing else. An email that Cc'd three people
was answered to one of them, silently, with nothing on screen saying so.

The addresses were never missing: `email_messages.cc_addresses` has stored
inbound Cc since mig 0039 and was simply never read back.

Precedence, in order:

1. An explicit `to` from the caller.
2. `replyAll: true` — rebuilds To from the newest **inbound** message's sender,
   and Cc from that message's To + Cc, **minus this mailbox and minus anyone
   already on To**.
3. Otherwise the counterparty, exactly as before.

**Bcc is never reconstructed.** It was blind; guessing at it would expose a
recipient the original sender chose to hide.

**Bcc is never stored on the message row** either — a thread is readable by
anyone on the mailbox, which is the wrong place to record who was quietly copied.
It reaches the provider and stops there (and in the outbox row, which is
ops-only, so a retry can reproduce the same send).

## Rules that will bite you

- **`to_addresses` / `cc_addresses` are JSON arrays**, read with
  `parseJsonArray`. An outbound row written as `JSON.stringify([to])` — one
  address — makes every other recipient invisible in the thread AND drops them
  from the next reply-all.
- **Two migration trees.** `email_outbox` exists in `migrations-pg/` (production)
  *and* `migrations/` (D1, test-only). The outbox tests exercise the real INSERT,
  so a column added to only one tree fails the suite with "no outbox row" rather
  than anything mentioning a schema — see `0254` / `144`.
- **From is authorised per user.** `canSendFrom()` — a non-admin may only send
  from a mailbox in their scope or their own alias. Admins may send from any.
- **`purpose` gates delivery at both ends.** `isChannelEnabled()` is checked when
  sending AND again at drain time, so a channel switched off after enqueue stops
  the retry.
- **Attachments are not persisted.** `email_outbox` has no attachment column, so
  a send carrying one sets `outboxRetry: false` — otherwise a cron retry would
  re-send it body-only.

## See also

- `backend/tests/emailOutbox.test.ts` — the queue's retry ladder
- `docs/modules/` — sibling guides; `sales-order.md` is the shape to follow
