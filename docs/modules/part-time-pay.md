# Part-time sales pay

What a part-time salesperson is paid for an event, raised as a payment request Finance pays: the owner keys the sheet, HR confirms, Finance pays one voucher per person and attaches the bank slip. Desktop only (HR module).

## Flow

- The part-timer must be a member with a sales position and a POS PIN (Team > Members), and log into the POS under their own name — the sheet reads their logins and their orders.
- `HR > Part-time Pay`, pick the event. Everyone who logged into the POS or sold during the event's period is listed with their days, the first login of each day (the arrival time), their sales and the priced figures.
- The owner (`scm.part_time_pay.request`) ticks who goes on the sheet, corrects days, ticks one WiFi holder, keys the bank details and saves. A saved row is `DRAFT`.
- HR (`scm.part_time_pay.confirm`) confirms a row: a `SUBMITTED` payment request is raised for it, purpose `Part-time sales — {event} ({start} to {end})`, note = the breakdown, payee = the account name. The row is `CONFIRMED` and locked.
- Finance answers it like any request (PV New `?fromRequest=`). No bill is needed (`paymentRequestLinkGuard` exempts `part_time_pay_id`); the bank slip goes on the voucher. The sheet shows the request's stage, the voucher number and the slips for HR and the owner.

## Rules that must not break

- Days = Malaysian calendar days with a POS login inside the event's period (end inclusive); a day with a sale and no login counts too and shows "no login". Logins live in `scm.pos_logins`, written by `/api/pos/pin-login` and stamped at logout — both best-effort, never blocking the tablet.
- Sales = the event's orders (`project_id` = the event) by that salesperson, `COMMISSION_EXCLUDED_STATUSES` and held orders left out. Never keyed by hand. A row whose sales moved since the save refuses confirm (`sales_changed`) until the owner saves again.
- Zero sales earns no commission. One WiFi allowance per event (partial unique index + the route's check). A row totalling zero is not sent (`nothing_to_pay`).
- Rates (`part_time_commission_bps`, `part_time_day_rate_sen`, `part_time_wifi_sen`) live on `hr_commission_config`, edited in HR Settings; the sheet row keeps the rates it was priced with.
- A `CONFIRMED` row cannot be edited or removed. The owner cannot confirm; HR cannot key.

## Gotchas

- A part-timer not on the project's Sales Attending list may have orders without `project_id` (venue binding), which then do not count — add them to the project or set the venue on the POS.
- Sessions last 7 days: a tablet that stays signed in logs in once, so later days count only if there is a sale that day. The owner corrects the day count on the sheet.

## Where the code is

- `backend/src/scm/routes/hr-part-time-pay.ts` — routes; `backend/src/scm/lib/part-time-pay.ts` — days and money (pure).
- `backend/src/services/posLogin.ts` — the attendance book; `backend/src/routes/pos.ts`, `backend/src/services/auth.ts` — its two writers.
- `frontend/src/pages/scm-v2/PartTimePay.tsx`, `frontend/src/vendor/scm/lib/part-time-pay-queries.ts`.
- Tests: `backend/tests/partTimePay.test.ts`, `frontend/src/pages/scm-v2/PartTimePay.test.tsx`.
