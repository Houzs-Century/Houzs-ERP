# Module: Chat callback (Houzs Chat → ERP)

> **Line numbers are deliberately absent.** Every `:NNN` in this directory was
> found stale by the 2026-08-13 audit while the paths and methods stayed right.
> Resolve a route to its current line with the generated artifact instead:
>
> ```bash
> npm --prefix backend run gen:route-locator
> ```

The return leg of the WhatsApp delivery conversation. `chat.houzscentury.com`
posts what the customer **tapped** — *Confirm Date* / *Amend Date* — and this
endpoint records it against the Sales Order it was about.

---

## 1. Where it sits

The **outbound** half already existed and is not part of this module: Delivery
Planning's "Send Message" (`backend/src/scm/routes/delivery-messages.ts`) sends
one WhatsApp per customer phone and writes one `scm.wa_message_log` row per doc
(`backend/src/db/migrations-pg/0185_scm_wa_message_log.sql`).

What the customer answered had, until this module, only ever reached a Google
Sheet — the chat flow's `Call REST API` steps pointed at Apps Script
deployments and staff worked off the spreadsheet.

```
Delivery Planning board
   │  POST /api/scm/delivery-messages/send
   ▼
chat.houzscentury.com ──▶ WhatsApp ──▶ customer taps a button
                                            │
                          POST /api/chat-callback   ◀── THIS MODULE
                                            │
                                   scm.wa_message_log
                                   source = 'chat-callback'
```

Both directions land in the **same** table, so one query is the whole timeline
of "what we sent / what they answered".

## 2. Surface

| | |
|---|---|
| Route | `POST /api/chat-callback` |
| Source | `backend/src/routes/chatCallback.ts` |
| Mount | `backend/src/index.ts`, **above** `app.use("/api/*", auth)` |
| Auth | `X-Chat-Key` header vs the `CHAT_CALLBACK_KEY` worker secret |
| Permission key | none — there is no session and no user |

### Request

```json
{ "callback_id": "…",
  "event": "confirm" | "amend",
  "ref": "SO-012913",
  "phone": "+60…",
  "delivery_date": "2026-09-12",
  "reason": "Renovation Delay",
  "note": "…" }
```

`event` and `ref` are required. `delivery_date` and `reason` are the amend
path's fields and are recorded verbatim.

### Response

```json
{ "ok": true, "id": "…", "event": "confirm", "ref": "SO-012913",
  "recorded": true, "applied": false }
```

`applied` is **always** `false`. See §4.

## 3. Why it is mounted pre-auth

Chat's servers call it; there is no staff session and no `X-Company-Id`, so
`companyContext` never runs. Mounted below `app.use("/api/*", auth)` every call
would 401 at the gate before the route's own key check ran — the mistake
`/api/assr-form-intake` documents having made in its own header comment.

The guard is the same shape as that endpoint's: constant-time compare, a 250 ms
failure delay, and a per-IP failure limiter (`checkRateLimit`). An **unset**
`CHAT_CALLBACK_KEY` refuses every request rather than admitting one whose empty
header happens to equal an empty secret.

## 4. It records; it does not schedule

**The endpoint never writes a delivery date onto the Sales Order.**

A date a customer tapped is a *request*, not a plan. Delivery Planning owns
delivery dates, MRP pools off them, and a write here would let a customer move a
date a trip has already been planned around. `mfg_sales_orders` is read for one
purpose only — to prove the `ref` exists and belongs to this company — and the
statement is a `.select(`.

Applying a requested date is a human step, or a later explicit approve step. It
is not this endpoint. The flow's own copy already tells the customer so:
*"our team will review and plan according to our current delivery schedule."*

`tests/chatCallback.test.ts` pins this: a re-added `.update(` fails the suite.

## 5. One secret, one company

By the 2026-08-18 rule a shared secret speaks for exactly one company and opens
nothing else. `CHAT_CALLBACK_KEY` is a Houzs Century artifact — the WhatsApp
number it answers for is Houzs's — so the handler resolves `HOUZS` from the
`companies` master and refuses any other company's `doc_no`.

The company resolution runs **first**, before any row is read, so every
statement below it carries the predicate. Three states, the same contract as
`backend/src/scm/lib/companyScope.ts`:

| state | meaning | behaviour |
|---|---|---|
| master unreadable | single-company install / the D1 test mirror | no predicate |
| master readable, no `HOUZS` row | **misconfiguration** | refuse, 500 |
| master readable, row found | normal | `.eq("company_id", …)` on every statement |

"No such SO" and "not your company's SO" return the **same** 404 body, so a
Houzs credential cannot probe which doc numbers exist elsewhere.

## 6. Idempotency

A webhook can fire twice for one tap. `callback_id` is sanitised to
`[A-Za-z0-9_-]` before it is interpolated into the duplicate probe's `LIKE` — an
unfiltered `%` would silently widen the match — and the probe is scoped both to
this company and to `source = 'chat-callback'`, so a delivery-planning send is
never mistaken for a duplicate reply.

If the probe itself errors the handler returns 500 rather than treating the row
as absent. supabase-js does not throw; an unbound error would read a database
blip as "not a duplicate" and write the customer's answer twice.

## 7. Errors are not best-effort here

The send path logs best-effort on purpose: the WhatsApp had already left, and a
log failure must not report a delivered message as an error.

This endpoint is the opposite. The row **is** the delivery — a 200 with no row
would stop chat retrying and lose the customer's answer for good — so an insert
failure returns 500.

## 8. The board's Message column

`scm.wa_message_log` now carries inbound rows, and they are **newer** than the
send they answer. `POST /api/scm/delivery-messages/statuses` takes the first hit
per doc, so it filters to `source = 'delivery-planning'`. Without that
predicate every answered message would report itself as freshly sent.

That predicate is load-bearing, not tidiness, and
`tests/chatCallback.test.ts` pins it.

## 9. Turning it on

1. Add the GitHub secret `CHAT_CALLBACK_KEY` (48 random characters).
   `.github/workflows/deploy.yml` pushes it with the other worker secrets, and
   **omits** it from the bundle while it is empty rather than pushing `""`.
2. Deploy. The endpoint 401s everything until the secret exists.
3. In the chat flow's `Call REST API` step, set the method to `POST`, the URL to
   this endpoint, and the header `X-Chat-Key`.

## 10. Not covered here

- Whether an approved amend should write the date back, and by which surface.
  Deliberately out of scope — see §4.
- The chat side's own flow definitions, which live in
  `chat.houzscentury.com` and not in this repo.
