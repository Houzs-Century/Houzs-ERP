> ## Corrections — 2026-08-12 code-read sweep
>
> 1. LIVE BUG (flagged separately): compose VALIDATES and STORES cc/bcc (mail-center.ts:2104-2120,:2219) but the sendEmail call (:2148-2161) passes neither — composed Cc/Bcc recipients never receive the mail while the thread renders them. Reply is correct (:2004-2019).
> 2. LIVE BUG (same chip): attachment-bearing reply/compose do not set outboxRetry:false (only mfg-purchase-orders.ts:4203 does), so a failed send is re-drained BODY-ONLY by the */5 cron.
> 3. The cc/bcc outbox columns are migrations 0269/148, not 0254/144 (those were renumbered to assr_product_categories_refresh).
> 4. Plain-reply To = the newest inbound message's from_address, falling back to counterparty_email (mail-center.ts:1946-1956) — the two diverge when a later inbound came from a different sender.

# Module: Mail Center

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

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
| `email_outbox` | `0005`, +`0269` | the durable send queue: `to_address`, **`cc_address`**, **`bcc_address`** (both added by `0269_email_outbox_cc_bcc.sql`), `status`, `attempts` |
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

1. An explicit `to` from the caller wins outright.
2. No explicit `to` — To becomes the newest **inbound** message's `from_address`,
   whether or not `replyAll` was asked for. `thread.counterparty_email` is only
   the fallback when the thread has no inbound message at all.
3. `replyAll: true` **and** the caller sent no `cc` — Cc is rebuilt from that
   same inbound message's To + Cc, **minus every address in the caller's mailbox
   scope (not just this mailbox) and minus anyone already on To**. An explicit
   `cc` is never overwritten.

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
  than anything mentioning a schema — see `migrations-pg/0269_email_outbox_cc_bcc.sql`
  / `migrations/148_email_outbox_cc_bcc.sql`.
- **From is authorised per user.** `canSendFrom()` — a non-admin may only send
  from a mailbox in their scope or their own alias. Admins may send from any.
- **`purpose` gates delivery at both ends.** `isChannelEnabled()` is checked when
  sending AND again at drain time, so a channel switched off after enqueue stops
  the retry.
- **Attachments are not persisted.** `email_outbox` has no attachment column.
  The Mail Center reply DOES forward attachments to Resend on the immediate send
  (`contentBase64` → base64 content) but leaves the outbox row retryable, so a
  drained retry sends that mail BODY-ONLY. `outboxRetry: false` — suppress the
  outbox row entirely rather than retry it wrong — is used on the PO email path
  (`scm/routes/mfg-purchase-orders.ts:4223`), not here.

## See also

- `backend/tests/emailOutbox.test.ts` — the queue's retry ladder
- `docs/modules/` — sibling guides; `sales-order.md` is the shape to follow

## Company scope on the outbox (2026-08-18)

`GET /outbox`, its status roll-up, and `GET /outbox/:id` are scoped to the ACTIVE
company. `email_outbox` has no `company_id` — its company column is
`company_code` (mig 0094) — so the predicate is `activeCompanyCodePred(c)` from
`backend/src/scm/lib/companyScope.ts`, which BINDS rather than interpolating and
handles the three things that column actually holds: the code, NULL (= the base
company, per 0094 and the cron drain), and a company id stringified by two
callers that pass `String(row.company_id)` into `sendEmail`'s `companyCode`.

**Mail admin is NOT a company scope.** `isMailAdmin` grants management rights
over mailboxes; it never widened the company predicate and must not be made to.
Before this, both reads returned every company's rows — including `body_html`,
which carries the one-time `/invite/<token>` and `/reset/<token>` links minted in
`routes/auth.ts`.

## Mobile shares the desktop's rules — it does not re-derive them (2026-08-20)

`frontend/src/mobile/MobileMailCenter.tsx` is the phone twin of the desktop
screens, and the owner's standing rule is ONE shared logic layer with the two
surfaces differing only in presentation. Three rules had been re-implemented on
the phone instead of imported, and each copy was missing the half that had
already been fixed on desktop. They now come from the same modules:

| rule | shared module both surfaces use |
|---|---|
| which mailbox the From defaults to | `frontend/src/pages/MailCenter/mail-from-default.ts` (`pickDefaultFromAddress`) |
| the auto-sent log's fetchers | `frontend/src/pages/MailCenter/mail-actions.ts` (`fetchOutbox`, `fetchOutboxDetail`) |

**`replyAll` is a REQUIRED prop on the phone's reply box, and `defaultFrom` is a
REQUIRED prop on its composer.** Both were written that way on purpose, per the
`optional-param-noop` rule in `CLAUDE.md`: an omitted `replyAll` silently
answers one person on a mail that copied several, and an omitted `defaultFrom`
silently falls back to `addresses[0]`, which is the ALPHABETICALLY first mailbox
because `GET /addresses` is `ORDER BY address ASC`. Neither failure raises an
error, so the compiler is the only thing that can catch a new call site that
forgets one.

**The member's own alias is spliced into the From list on both surfaces.**
`getMailScope` builds `scope.addresses` from `email_addresses` rows only, while
`canSendFrom` also accepts the caller's `users.email_alias`. A member whose only
sending identity is that alias therefore gets an EMPTY `/addresses` response and
must be offered the alias by the client, or they cannot send at all.

**"Auto-sent" is on the phone too.** Same read-only outbox log as the desktop
folder, same endpoint, same company scope (see the section above). It is the
only place a FAILED customer notice is visible — the auto-sent mail goes out
from a no-reply sender, so there is no thread and no "Sent" copy anywhere else.
Before this the phone had a fixed six-folder list and a failed invoice email was
invisible to anyone not at a desk.
