# Chat Callback (Houzs Chat -> ERP)

The return leg of the WhatsApp delivery conversation. `chat.houzscentury.com` posts what the customer TAPPED (Confirm Date / Amend Date), and this endpoint records it against the Sales Order it was about. The outbound half (Delivery Planning's "Send Message") is a separate module; both directions write into the same `scm.wa_message_log` table, distinguished by `source`, so one query is the whole timeline of what was sent and what was answered.

## Statuses and flow

`POST /api/chat-callback` — `{callback_id, event: "confirm"|"amend", ref, phone, delivery_date?, reason?, note?}` (`event` and `ref` required; `delivery_date`/`reason` are the amend path's fields, recorded verbatim). Responds `{ok, id, event, ref, recorded, applied}` — `applied` is ALWAYS `false`.

**It records; it does not schedule.** The endpoint never writes a delivery date onto the Sales Order — a tapped date is a request, not a plan. Delivery Planning owns delivery dates and MRP pools off them, so a write here could let a customer silently move a date a trip has already been planned around. The Sales Order is read only to prove `ref` exists and belongs to this company; applying a requested date is a human step (or a later, separate approval step), not this endpoint.

## Permissions

- No session, no user, no permission key — mounted PRE-AUTH (above the global `/api/*` auth middleware), because chat's servers have neither a staff session nor a company header to offer.
- Authenticated instead by a single shared secret, `X-Chat-Key` against the `CHAT_CALLBACK_KEY` Worker secret — constant-time compare, a fixed failure delay, and a per-IP rate limiter. The secret speaks for exactly ONE company (Houzs Century, the WhatsApp number's owner); an unset secret refuses every request outright rather than letting an empty header match an empty value.

## Rules that must not break

- Company resolution runs FIRST, before any row is read, and every statement after it carries the company predicate — a misconfigured install (master readable but no HOUZS row) must refuse (500), never silently drop the predicate.
- "No such SO" and "not your company's SO" must return the identical 404 body — distinguishing them would let a caller probe which document numbers exist in another company.
- `callback_id` must be sanitised to `[A-Za-z0-9_-]` before it is interpolated into the duplicate-detection `LIKE` probe — an unfiltered wildcard character would silently widen the match.
- The duplicate probe must be scoped to both this company AND `source = 'chat-callback'` — otherwise an outbound delivery-planning send could be mistaken for a duplicate inbound reply.
- If the duplicate-check read itself fails, the handler must answer 500, never treat the row as absent — an unbound read error otherwise reads as "not a duplicate" and writes the customer's answer twice.
- An insert failure here must answer 500, not a soft-fail 200 — unlike the outbound send path (which logs best-effort because the WhatsApp message has already left), the row here IS the record of the customer's answer; a 200 with nothing written stops chat's retry and loses the answer for good.
- `POST /api/scm/delivery-messages/statuses` must keep filtering to `source = 'delivery-planning'` when taking the latest message per document — without it, an answered (inbound) row being newer than its outbound send would make every answered message misreport itself as freshly sent.

## Gotchas

- The endpoint 401s every request until the `CHAT_CALLBACK_KEY` Worker secret actually exists — deploying the route alone does not turn it on.
- Don't add a `.update(` on the Sales Order to this handler to "close the loop" on an amend — that is explicitly out of scope; a test fails the suite if an update is re-introduced.

## Where the code is

- `backend/src/routes/chatCallback.ts` — the endpoint.
- `backend/src/scm/routes/delivery-messages.ts` — the outbound half (Send Message).
- `backend/src/db/migrations-pg/0185_scm_wa_message_log.sql` — the shared message log table.
