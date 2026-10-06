# Chat Callback (Houzs Chat -> ERP)

The return leg of the WhatsApp delivery conversation. `chat.houzscentury.com` posts what the customer TAPPED (Confirm Date / Amend Date), and this endpoint records it against the Sales Order it was about. The outbound half (Delivery Planning's "Send Message") is a separate module; both directions write into the same `scm.wa_message_log` table, distinguished by `source`, so one query is the whole timeline of what was sent and what was answered.

## Statuses and flow

`POST /api/chat-callback` — `{callback_id, event: "confirm"|"amend", ref, phone, delivery_date?, reason?, note?}` (`event` and `ref` required; `delivery_date`/`reason` are the amend path's fields, recorded verbatim). Responds `{ok, id, event, ref, recorded, applied}` — `applied` is ALWAYS `false`.

`refs` (optional, comma-joined — the send's `refs_all`) is the whole bundle a multi-order message covered; the tap is recorded against every order in it (each resolved like `ref`, primary first, siblings that do not resolve reported as `unknown`, never fatal). Idempotency is per `(callback_id, doc_no)`, so the second order of a bundle is not mistaken for the first's duplicate. The per-order work lives in `backend/src/lib/chat-callback-record.ts`.

`ref` is the number the customer was shown. The outbound send puts `COALESCE(linked_ac_docno, doc_no)` in `ref_1`, so for an AutoCount-linked order it is the AutoCount number; the endpoint matches either column (company-scoped) and records the row under OUR `doc_no`, keeping the inbound value as `customer_ref` in the payload when the two differ. A `ref` with characters outside `[A-Za-z0-9_-/.]` is refused 400 before it can reach the filter.

### Message kinds the board can send

`POST /api/scm/delivery-messages/send` takes `kind` (default `delivery`); each kind fires one Connect automation by exact name (`backend/src/scm/lib/delivery-message-kinds.ts`). Every kind carries the shared bundle below; the table lists what it adds and when an order is skipped instead of sent with a blank variable.

| kind | Connect automation | adds | skipped when | resets conversation |
|---|---|---|---|---|
| `delivery` | New Delivery Follow-up | — | — | yes |
| `amend` | New Amend | — | — | yes |
| `postpone` | Postpone | `client_delivery_date`, `amend_date_reason_2`, `new_delivery_date` (operator: reason + date; 400 without) | — | yes |
| `driver_info` | Driver Info | `client_delivery_date`, `delivery_time`, `drivers_name/contact/ic`, `car_plate` (operator picks driver / lorry / time; 400 without — the ERP's DOs carry no driver or time yet) | — | no |
| `balance_reminder` | Balance Reminder | — (`amount` + `bank_block` from the bundle) | nothing owed (`no_balance`) | no |
| `reminder_1/2/3` | Reminder 1/2/3 | — | — | no |
| `postage` | Postage Confirm | `customer_phone`, `delivery_address` (delivery address, else customer address, + postcode/city/state) | no address (`no_address`) | no |
| `delivery_completed` | Delivery Completed | — | — | no |

"Resets conversation" = the six reset attributes below are sent as empty. Only the openers do it: a Driver Info or Balance Reminder to a customer who already confirmed must not clear `button_status`, or the Delivery Lock guard stops protecting the confirmed date.

### What the outbound send tells Connect (the contract the flows depend on)

Delivery Planning's Send Message (`POST /api/scm/delivery-messages/send`) posts ONE contact per customer phone with these attributes: `full_name`, `order_total`, `ref_1..3` / `delivery_date_1..3` / `brand_1..3`, `refs_all` (every bundled order's number, comma-joined, echoed back as the callback's `refs`), `callback_url` (this endpoint's absolute URL, from `PUBLIC_APP_URL`), `amount` (the owed sum across every bundled order as `1,500.00`, from the SO list's `balance_sen_live` view column; empty when nothing is owed), and the per-company `company_signature` / `bank_block` / `disposal_block` from the `connect.company_profile` app_config key. It also RESETS `button_status`, `last_button`, `amount`, `amended_delivery_date`, `amend_date_reason`, `date_amended` to empty on every send — Connect merges attributes over the contact's existing ones, so without the reset the previous order's Confirm would lock the new order's Amend tap and a settled balance would print again. Connect's flow adds the `X-Chat-Key` header itself from its own `ERP_CALLBACK_KEY` secret; the key is never sent as an attribute.

**It records the request; it does not schedule.** The endpoint never writes a delivery date onto the Sales Order — a tapped date is a request, not a plan. Delivery Planning owns delivery dates and MRP pools off them, so a write here could let a customer silently move a date a trip has already been planned around. What it DOES fill, after the log row, are the Sales Order's request columns the board already shows: `amend_date_from_customer` ("Customer Request Date", from the tapped/typed date when it parses as DD/MM/YYYY or YYYY-MM-DD), `amend_reason` ("Amend Reason") and `delivery_message_status` ("Pending Reschedule (D)" on amend, "Done Scheduling" on confirm). The patch is built by `backend/src/lib/chat-request-patch.ts`, whose test pins that it never names `customer_delivery_date`, `amended_delivery_date`, `delivery_state` or `status`; it is written through `advanceSoGeneration` (the SO version moves, so a stale SO editor save gets a 409 rather than overwriting the customer's answer) and audited as actor "Customer (WhatsApp)", source `chat-callback`. A lease/conflict on that write is reported in the response as `so_request.reason` and does not fail the callback — the log row is the record. Applying a requested date to the schedule stays a human step on the board.

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

- The endpoint 401s every request until the `CHAT_CALLBACK_KEY` Worker secret actually exists — deploying the route alone does not turn it on. The same value must be set on the Connect worker as `ERP_CALLBACK_KEY`, or every callback 401s and the tap is only visible in Connect's run log.
- A failed read of the company profile or of the live balances makes the send answer 500 (`profile_load_failed` / `balance_load_failed`) rather than send a message with blank bank details or "nothing owed" — nothing has left at that point, so refusing is free.
- Don't add a raw `.update(` on the Sales Order to this handler, and don't add a schedule column to `chat-request-patch.ts` to "close the loop" on an amend — applying the date is a human step; tests fail the suite on either.

## Where the code is

- `backend/src/routes/chatCallback.ts` — the endpoint.
- `backend/src/scm/routes/delivery-messages.ts` — the outbound half (Send Message).
- `backend/src/db/migrations-pg/0185_scm_wa_message_log.sql` — the shared message log table.
