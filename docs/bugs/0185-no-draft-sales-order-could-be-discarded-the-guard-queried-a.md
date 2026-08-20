## No draft Sales Order could be discarded — the guard queried a column that does not exist [high]

**Symptom.** Discard on a DRAFT SO returns **500** `delete_failed`, always, for
every draft. The documented `409 so_has_payments` was unreachable, so the failure
looked like a server fault rather than a refusal.

**Root cause.** `backend/src/scm/lib/so-lifecycle-guards.ts` checked for payments
with `.from('mfg_sales_order_payments').select('id').eq('doc_no', docNo)`. That
table has **no `doc_no` column** — it is `so_doc_no`, per
`backend/scripts/scm-schema/2990s-full-schema.sql:621` and the FK
`mfg_sales_order_payments_so_doc_no_mfg_sales_orders_doc_no_fk`. No migration
ever adds `doc_no`. PostgREST answers `42703`, `payErr` is set, and the guard —
**correctly failing closed**, because an unreadable ledger is not an empty one —
returns 500 before it can ever reach the 409.

It was the only site in the tree querying that table by `doc_no`;
`ar-reconciliation.ts:102` and `mfg-sales-orders.ts:494` both use `so_doc_no`.

**Why nothing caught it.** A column name inside a string is invisible to
TypeScript, and the guard's fail-closed branch turns the resulting error into a
plausible-looking 500 rather than a crash. The bug was found by a documentation
audit: `docs/modules/sales-order.md:266` documents a 409 the code cannot produce,
and checking WHY the doc was wrong is what exposed the query.

**Fix.** `so_doc_no`. One word.

**Ref.** 2026-08-14. Lesson: **a fail-closed guard hides its own defects.** When
a guard's error path is indistinguishable from a real refusal, a typo in it is
silent — so the error path deserves the same scrutiny as the rule. The class is
worth a checker: every `.from('t')...eq('c')` where `c` is not a column of `t`
is mechanically findable from the schema, and TypeScript will never see it.
