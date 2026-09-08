## Paying a purchase invoice never marked it paid — settle_pi_paid_sen wrote a text status into the enum column and every call failed 42804 [high]

<!-- area: Accounting + GL -->

**Symptom.** Owner, 2026-09-08: 有一张价钱是错的，但是我 knock off 完了 — and
asked whether a knocked-off purchase invoice can still be edited. It could.
Every purchase invoice paid through an approved AP Payment was still POSTED at
paid_sen 0 (2990-HPV-2608-026 → 2990-PI-2607-002/003; 2990-HPV-2609-002 → 19
invoices; 21 allocations, RM 46,948.10), still listed in the AP Payment picker,
still unlocked for edits, and each voucher's allocations carried applied_sen 0
— so cancelling the voucher would have released nothing. The voucher itself was
fine: its journal entry was posted and the bank was credited. Nothing on screen
said otherwise.

**Root cause (traced).** `scm.purchase_invoices.status` is the enum
`scm.purchase_invoice_status`. `scm.settle_pi_paid_sen` — 0147's body, carried
into the `_sen` names by `0305_money_centi_to_sen.sql` lines 752-810 — wrote
the new status as `CASE WHEN … THEN 'PAID' WHEN … THEN 'PARTIALLY_PAID' ELSE
'POSTED' END`. 0147's header says why: it trusted the planner to coerce bare
literals to the column's type. It does for ONE bare literal; a CASE whose
branches are all untyped literals is resolved on its own first ("all unknown →
text"), and Postgres has no assignment cast from text to an enum. So every call
raised `42804: column "status" is of type purchase_invoice_status but
expression is of type text`. `settlePiPaidSen` (`lib/pi-settlement.ts`)
correctly refuses to fall back to the optimistic loop on a live RPC error,
recorded `applied_sen 0`, and only `console.error`ed. Observed in the Supabase
Postgres logs on prod behind each SUPPLIER_PAYMENT approval, and reproduced on
staging 2026-09-08 by calling the live function inside a DO block that raised
at its end so everything rolled back: the exact 42804, from the exact UPDATE.
`settle_api_paid_sen` (20260906T1500) never failed — `ap_invoices.status` is
text. Why no test caught it: `tests-pg/pvRateAdoption.pg.test.ts` replays the
function against a fixture that declares `status text`; the function passed on
a table that is not the table.

**Fix.** `backend/src/db/migrations-pg/20260908T0900_scm_settle_pi_paid_sen_enum_status.sql`
re-creates the function with each CASE branch typed
`::scm.purchase_invoice_status`; everything else is 0305's body verbatim.
`backend/tests-pg/settlePiPaidSenEnum.pg.test.ts` declares the real enum and
integer money columns, replays the LATEST definition in the migration tree (so
a later redefinition is what gets tested) and pins full / partial / clamp /
cancel / not_live on the enum column. Proved RED on the unfixed tree: with the
fix migration absent the newest definition is 0305's and the suite fails on
that 42804 — CI `backend-postgres` on PR #3203's first push,
https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34192581459/job/101953527282;
GREEN with it. The
allocations the failure left behind are settled by
`.github/workflows/repair-pi-settlement.yml` +
`backend/scripts/repair-pi-settlement.mjs` (plan/apply, CONFIRM "SETTLE PI
ALLOCATIONS"): the same function, the same clamp, `applied_sen` recorded from
what it applied, vouchers in approval order, foreign-currency rows left alone
(the rate adoption is not replayed), and it refuses to run while the target
still carries the broken function.

**Ref.** fix/settle-pi-paid-sen-enum, 2026-09-08.
