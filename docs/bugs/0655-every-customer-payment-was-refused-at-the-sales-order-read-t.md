## Every customer payment was refused at the sales-order read — the booking hook asked for customer_name, a column the order table does not have [high]

<!-- area: Accounting + GL -->

**Symptom.** Owner, 2026-09-07, the Self-check card's first dry run
(docs/bugs/0652): "171 unbooked payments put through the gate, nothing
written: 171 so_read_failed — column mfg_sales_orders.customer_name does not
exist", on every row from 2026-06-11 to 2026-09-06. Zero SOPAY journals had
ever existed in the company (0652), and the cause had been invisible because
the hook's refusal went to the console only.

**Root cause (traced).** `postSoPayment` (`acc/payments.ts`) opened with
`from('mfg_sales_orders').select('company_id, customer_name, customer_phone')`.
The order table has no such columns — prod's information_schema names the
customer `debtor_name` and the phone `phone` (checked 2026-09-07) — so
PostgREST answered 400 and the function returned `so_read_failed` before
any rule ran. `acc/settlement.ts` carried the same `customer_name` read for
the settlement screen's names. Every test passed because the fake client
returns the fixture row whatever columns are asked for, and the fixture row
had been written with the wrong names.

**Fix.** Both reads name `debtor_name` (and `phone`); the fixture wears the
real names. `tests/soPaymentOrderColumns.test.ts` pins every
`mfg_sales_orders` SELECT in `backend/src/acc` against the table's real
column list — RED on the unfixed tree (`customer_name`, `customer_phone`
named twice), green after. The Self-check card gains **Book N payments now**
(the real backfill, one batch of 500, behind a confirm, offered only after a
dry run with no refusal) so the owner runs the 171 himself
(`UnbookedPaymentsCard.test.tsx`).

**Ref.** fix/so-payment-debtor-name, 2026-09-07.
