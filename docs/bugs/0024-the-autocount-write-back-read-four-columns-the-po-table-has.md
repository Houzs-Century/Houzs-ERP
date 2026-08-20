## The AutoCount write-back read four columns the PO table has never had, and one the SO items table did not have yet [critical]

**Symptom** — with the write-back toggle on, a purchase order created in the ERP
would reach AutoCount as NOTHING at all, and a sales order would reach it as a
header with an EMPTY line list. Both silently: no error, no failed outbox row,
nothing to notice it by. Found by the payload contract test in PR #1898 before
the toggle was ever turned on, so no live document was affected.

**Root cause (traced, not guessed)** — two selects naming columns that are not
there, and one shared swallow.

1. `enqueuePoCreate` and `composePoState` asked `scm.purchase_orders` for
   `creditor_code, creditor_name, agent, ref`. That table is SUPPLIER-keyed —
   `supplier_id` into `scm.suppliers`, which carries `code` and `name` — and it
   has no `agent` or `ref` at all. Verified against the schema dump, not
   assumed: its 18 columns are `id, po_number, supplier_id, status, po_date,
   expected_at, purchase_location_id, currency, subtotal_centi, tax_centi,
   total_centi, notes, submitted_at, received_at, cancelled_at, created_at,
   created_by, updated_at`, plus `company_id`, `revision`, the supplier delivery
   dates, the PO-email columns and the `linked_ac_*` refs from later migrations.
2. The SO and PO line selects asked for `linked_ac_dtlkey`, which migration
   0273 adds and which was still sitting in an unmerged PR (#1819).

**PostgREST does not ignore an unknown column — it fails the whole query with
42703 and returns a NULL body.** The code took only `data` and dropped `error`,
so `header` became null (the PO functions returned false inside their own
try/catch: a silent no-op) and `items ?? []` became an empty array (the SO
composed a document with no Details). #1855's own body described the second one
as "every line is new, correct-but-degraded"; it was every line MISSING.

**Fix** — three parts, all in `scm/lib/autocount-outbox.ts`:

- the PO reads name the real columns (`id, po_number, po_date, supplier_id,
  notes, linked_ac_docno`) and join `scm.suppliers` for the creditor code and
  name. `Agent` and `Ref` are null on a create because the ERP has no such
  field; the PO EDIT omits `Ref` entirely rather than sending null, because
  `/edit` applies only the keys it is given (`h.ContainsKey`, AcSyncService.cs:369)
  and a null would blank whatever the account book has there.
- every select's column list is named ONCE at the top of the file, so a phantom
  column has one place to enter instead of four.
- **a read that FAILS is no longer a read that found nothing.** `readOrThrow`
  turns a PostgREST error into a throw; the enqueue logs it and writes a
  `skipped` outbox row carrying the database's own message, and composes
  nothing. Same rule `recordConvertSkipped` already followed: a divergence that
  is written down can be found.

PR #1819 (migration 0273, `linked_ac_dtlkey` on both item tables) was merged
first — it is the real dependency, and the same column is what lets an edit
address an existing AutoCount line instead of appending a duplicate.

**Where the phantom columns came from** — there are TWO tables named
`purchase_orders` in this database, in different schemas and with different
shapes. `scm.purchase_orders` is the ERP's own, supplier-keyed. The one in the
default schema (`db/schema.pg.ts:440`) is the **AutoCount mirror** — `doc_no`,
`creditor_code`, `creditor_name`, `remaining_qty` — filled from AutoCount's own
outstanding-PO export. The composer was written against the mirror's shape and
run against the ERP's, and the SCM Supabase client is pinned to
`db: { schema: 'scm' }`, so `sb.from('purchase_orders')` was never going to
reach the table those four columns live on.

**The class, for next time** — a Supabase/PostgREST select is not a projection
that degrades: one wrong column takes the whole row set with it. Two habits fall
out of that. Never write `const { data } = await sb...` on a path whose empty
result is meaningful — take `error` and decide. And check a column against the
schema before selecting it: `autocount-outbox.test.ts` now runs its fake
PostgREST with a list of columns the table does NOT have, and answers 42703 for
them, which is what makes these two bugs fail a test instead of a live account
book.

**Ref** — 2026-08-10, PR #1855 (feat/ac-writeback-wiring-v2), found by #1898.
