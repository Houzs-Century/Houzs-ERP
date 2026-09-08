## Deleting a sales order trusted a hand-written child list nobody had checked against the schema [high]

**Symptom.** The owner, 2026-09-08: 「把SO2609-001 删掉 这是测试单来的」 — delete
`HC-SO-2609-001`, it is a test order. The tool for that is
`backend/scripts/delete-test-so.mjs`, and CLAUDE.md names its `CONFIRM_DOC` guard
as the house example of a strong confirm. It would have deleted the order and
left two rows in the database pointing at a document that no longer existed —
silently, with nothing in its output to say so.

**Root cause (traced).** The script decided what to remove from a list typed into
the file:

```js
const CHILD_TABLES = [
  { table: "scm.mfg_sales_order_items",    cols: ["doc_no"] },
  { table: "scm.mfg_sales_order_payments", cols: ["so_doc_no", "doc_no"] },
  { table: "scm.mfg_sales_order_activity", cols: ["doc_no"] },
  { table: "scm.so_amendments",            cols: ["so_doc_no"] },
];
```

and decided whether deleting was SAFE from a second typed list of two downstream
tables. Nothing ever asked the database. Both lists were written when the script
was, for the 2990 POS smoke-test case, and neither was revisited as the schema
grew.

Asked properly — every text column in `scm`/`public` whose name could hold a
document number, counted against this one — the live schema offers **107
candidate columns**, and five of them name `HC-SO-2609-001`. Run `34220446297`,
2026-09-08, `MODE=plan` against production:

```
REFERENCE SWEEP — 107 candidate columns in the live schema
      1 row(s)  scm.autocount_outbox.ac_doc_no                 AUDIT        — deliberately KEPT (append-only record)
      1 row(s)  scm.autocount_outbox.doc_no                    AUDIT        — deliberately KEPT (append-only record)
      1 row(s)  scm.mfg_sales_order_items.doc_no               CHILD        — deleted with the order
      1 row(s)  scm.mfg_sales_orders.linked_ac_docno           UNCLASSIFIED — nobody has said what this is
      1 row(s)  scm.mfg_so_audit_log.so_doc_no                 UNCLASSIFIED — nobody has said what this is

REFUSED: 2 reference(s) nobody has classified …
Nothing was written. This is a verdict, not a failure.
```

**`scm.mfg_so_audit_log` was on no list at all.** It is the sales-order audit
trail — `so_doc_no, action, actor_id, actor_name_snapshot, field_changes,
status_snapshot, source, note` (`backend/scripts/scm-schema/2990s-full-schema.sql`
:727) — and the row it holds for this document is the `CREATE by Lim, via web,
14:06:51 MYT` line that is how this order was identified as a test in the first
place. The old script would neither have deleted it nor mentioned it.

Two things that were NOT wrong, and matter because they are what a smaller fix
would have got backwards:

- `scm.mfg_sales_order_activity` **is not in the production schema at all.** The
  old script printed `(table/column missing — skip)` for it (run `34220089049`),
  which is correct behaviour. The first draft of the new content capture named
  that table's column literally and would have died on `relation does not exist`
  before printing a single row — caught by reading that baseline, not by any
  gate.
- `scm.mfg_sales_orders.linked_ac_docno` is **the deleted row's own book
  number**, equal to its `doc_no` because AutoCount took our number. The first
  draft excluded the parent table by COLUMN, so it reported the row as a
  reference to itself. Excluding the column would have been the wrong repair: a
  DIFFERENT order carrying this one's number there is a real and dangerous
  reference. The parent table is now scanned with the row itself excluded, and
  both directions are pinned by tests.

**Fix.**

| what | where |
|---|---|
| the sweep, the control, and their SQL | `backend/scripts/lib/delete-test-so-refs.mjs` |
| `MODE=plan` default, full content capture, sweep + classification, fresh-connection SHAPE verification with a control | `backend/scripts/delete-test-so.mjs` |
| the SQL executed against a real Postgres before production sees it | `backend/tests-pg/deleteTestSoRefs.pg.test.ts` |

A swept reference is CLASSIFIED, never cascaded into: `CHILD` is deleted, `AUDIT`
is kept on purpose, `DOWNSTREAM` refuses, and anything nobody has classified
**stops the run** unless `ALLOW_ORPHAN_REFS=yes` says otherwise out loud. The
refusal exits 0 — it is a verdict, not a malfunction.

The script now also satisfies `fresh-verify`, so its entry left
`backend/scripts/release-discipline-grandfathered.json`. The list may only
shrink; this is one off it.

**Proved RED, and in both directions.** `tests-pg/deleteTestSoRefs.pg.test.ts`
runs in CI's `postgres:16` service (`backend-postgres`), because `node --check`
was the entire body of evidence a production DELETE had before it — the same gap
that killed `probe-undated-demand.mjs` mid-dispatch and `set-write-freeze.mjs` on
its first run (`docs/bugs/0711-*`). The two assertions that matter fail against
the unfixed code: the sweep finds `scm.so_revisions`, which no list names; and
the control DETECTS a status change, a deleted order, a deleted line, a touched
payment and a money change on ANOTHER document. A control that always answers
"nothing moved" is the same as no control.

---

### The owner's SECOND delete override (2026-09-08), and what it covers

The standing rule is **never delete, only cancel**. This is the second time in
one day it has been overridden, both times by the owner, both times after being
told the rule. The first is recorded at the same date in
`docs/bugs/0713-the-owner-ruled-that-a-row-the-book-describes-nothing-in-is.md`
and in `docs/modules/sales-order.md` — `HC-SO-013160`, 「删掉啊 没写的也删掉」.

This one, same day:

> 「把SO2609-001 删掉 这是测试单来的」
>
> "Delete SO2609-001. It is a test order."

**It is scoped to a document the owner named, and to nothing else.** A test
order he identifies is not a class, and no later change may cite this for a
wider licence. If he has not asked for a document by name, cancel it.

### What the document held, so it can be re-keyed by hand

Captured by run `34220446297` before anything was written. The header is 130
columns; these are the ones that are not null or zero. The complete JSON is in
that run's log under `---8<--- capture begin ---8<---`.

| field | value |
|---|---|
| `doc_no` / `linked_ac_docno` | `HC-SO-2609-001` (the book took our own number) |
| `status` · `revision` · `version` | `CONFIRMED` · 1 · 1 |
| `so_date` · `created_at` | 2026-09-08 · 2026-09-08T06:06:50.746Z (14:06:50 MYT) |
| `debtor_name` | `ZZ TEST WRITEBACK 0908` |
| `agent` · `salesperson_id` | `Lim` · `ea5674f1-866a-7afa-adf8-e2a6d3ad7538` |
| `customer_id` · `customer_type` | `8eb3d79f-2558-4a29-a9f2-64390d4e7d00` · `NEW` |
| `branding` · `sales_location` | `AKEMI` · `KL WAREHOUSE` |
| `venue` · `venue_source` | `KUALA LUMPUR CONVENTION CENTRE` · `MANUAL` |
| `customer_state` · `customer_country` · `phone` | Kuala Lumpur · Malaysia · +60123456789 |
| money | `accessories_sen` 10000 · `local_total_sen` 10000 · `balance_sen` 10000 · `total_revenue_sen` 10000 |
| cost / margin | `accessories_cost_sen` 2160 · `total_cost_sen` 2160 · `total_margin_sen` 7840 |
| payment columns | `deposit_sen` 0 · `paid_sen` 0 · `payment_method` null — **untouched, and there was nothing to touch** |
| `proceeded_at` | null — never proceeded |
| `company_id` · `created_by` | 1 · `00000000-0000-4000-8000-000000000001` |

One line, `line_no` 0, id `3ae31f05-bc50-489d-90fd-f473099dcde0`:

| field | value |
|---|---|
| `item_code` · `description` | `AK- ESSENTIAL BOLSTER` · `AKEMI SOFT BOLSTER` |
| `item_group` · `uom` · `qty` | accessory · UNIT · 1 |
| `unit_price_sen` · `total_sen` · `total_inc_sen` | 10000 · 10000 · 10000 |
| `unit_cost_sen` · `line_cost_sen` · `line_margin_sen` | 2160 · 2160 · 7840 |
| `warehouse_id` | `e309c399-697c-4174-967f-ae2c888ad999` |
| `linked_ac_dtlkey` | `927334` |
| `variants` | `{}` — not a sofa, no build to reconstruct |
| `stock_status` · `stock_qty_ready` · `allocated_batch_no` · `po_qty_picked` | `PENDING` · 0 · null · 0 |

`payments: []`. `activity`: the table is not in this database.

**It moved no stock.** `scm.inventory_movements.source_doc_no` is one of the 107
columns the sweep counts, and it holds ZERO rows for this document — so this is
measured, not inferred from the line's `PENDING` status.

### The half the owner has not been told: AutoCount still holds it

**PROVEN.** The ERP sent it and the book accepted it under our own number —
`scm.autocount_outbox`: `HC-SO-2609-001  create_so  sent
ac_doc_no="HC-SO-2609-001"  08/09/2026, 14:06:53 MYT` (run `34220096163`). And
the live book was asked directly, read-only, one document, no scan
(`sqlcmd` over ZeroTier against `AED_HOUZS`, 2026-09-08):

```
HC-SO-2609-001|2026-09-08|cancelled=F|net=100.00|lines=1
```

So deleting it here leaves a live, uncancelled RM 100.00 test sales order in the
account book. **Somebody has to cancel it in AutoCount by hand.** Nothing in
this change touches the book — 「写回autocount的你不需要理了」, same day — and no
cancel was enqueued.

`scm.autocount_outbox` is in `AUDIT_KEEP` precisely so that this question stays
answerable after the ERP row is gone.

### A correction the reconcile deserves

`docs/cutover-so-do-remainder-2026-09-08.md` describes `SO phantom 1` as
*"`HC-SO-2609-001`, an ERP document the book does not have"*. **The book does
have it.** The reconcile's AutoCount side is the committed snapshot
`backend/scripts/data/ac-reconcile-truth.json.gz`, exported
`2026-09-08T00:03:44.762Z` — roughly six hours BEFORE the write-back at 06:06:53Z.
So the phantom is a snapshot artefact, not a statement about the book. Both
documents are corrected in this PR.

### Its first dispatch after merge then found two more, in the CONTROL

Run `34223295235`, `MODE=plan` against production, died on
`invalid input value for enum scm.mfg_so_status: ""` — the control concatenated
an ENUM as if it were text, and the pg fixture had declared that column `text`,
so a real-Postgres suite passed on SQL production rejects. The same control's
money column resolved to a name `scm.mfg_sales_orders` does not have, so its
money arm compared NULL to NULL and proved nothing. Nothing was written — plan
mode, before any write path.

Both are traced in `docs/bugs/0718-a-test-fixture-looser-than-production-let-a-delete-script-sh.md`.
**Ref.** `chore/remove-test-so`, 2026-09-08. Runs: `34220089049` (baseline),
`34220096163` (shape + outbox), `34218303185` (reconcile before),
`34220446297` (plan, refused).
