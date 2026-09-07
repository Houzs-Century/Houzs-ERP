## Customer payments never reach the GL — the SO-create deposit path skips the booking hook, and the hook's own refusals had no surface [high]

<!-- area: Accounting + GL -->

**Symptom.** Checking the data behind the Receipt & Payment report the owner
asked for (2026-09-07, 先检查): 2990's general ledger carried ZERO `SOPAY`
journals, while its sales orders carried 171 non-imported payments since June
— RM 403,593.50 of deposits and balances (11 of them balance payments on June
orders, which the owner asked about: 应该有些 6 月的 so 也有还款). Every
customer receipt the R&P report should show was missing. The Accounting
Self-check card said "Payments that reached the ledger — all of them".

**Root cause (traced).** Three things, all in code, none in data:
1. `createSalesOrderCore` (`routes/mfg-sales-orders.ts`) inserts the POS split
   payments and the SO-create deposit straight into `mfg_sales_order_payments`
   and never calls `postSoPayment` — the hook lives only in
   `lib/so-payment-row.ts` (the panel's POST /:docNo/payments). The audit rows
   prove the split: 64 `ADD_PAYMENT` entries with source `automation` (the
   SO-create path, is_deposit = true) against 15 with source `web` since the
   hook landed on 2026-08-16.
2. The 15 panel-path rows DID reach `postSoPayment` and were refused — and a
   refusal is `console.error` only (by design: sales must be able to record
   money whatever accounting is doing), so nothing on any screen carried the
   reason. Roles, accounts (exist, active, leaf), constraints, the service-role
   client and RLS were all checked from the database and are fine; the reason
   itself lives in the Worker log, which is why this fix adds a dry run.
3. `unbookedPayments` draws its boundary at the FIRST booked payment and returns
   no rows when there is none — correct for a company whose history was
   deliberately left unbooked, wrong for one whose hook had failed on every row:
   the card read green.

**Fix.** Both SO-create inserts now `.select(…).single()` the row and call
`postSoPayment` best-effort, exactly like the panel path (a refusal still never
blocks the order). `tests/soCreateDepositBooks.test.ts` pins the shape — every
`mfg_sales_order_payments` insert in the writers is followed by
`postSoPayment(` — and was RED on the unfixed tree (two inserts, no hook),
green after. The engine's read-only half is now `validateJournal` (steps 1–3b,
shared with `postJournal`); `postSoPayment(…, { dryRun })` and
`backfillSoPayments(…, { dryRun })` answer would_post / the refusal with its
reason and write nothing; `POST /accounting/backfill/customer-payments
{ dryRun: true }` exposes it; `unbookedPayments` reports `neverBooked`
(count, money, first/last date) when nothing has booked, and the Self-check
card shows that state in red with a **Why? (dry run)** button listing each
payment's verdict and reason (`acc/payments.test.ts`,
`UnbookedPaymentsCard.test.tsx`). The 171 rows are then booked by the same
endpoint without dryRun — batched, idempotent, dated by `paid_at` — on the
owner's word after the dry run has named any refusals.

**Ref.** feat/customer-payment-booking, 2026-09-07.
