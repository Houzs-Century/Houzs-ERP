## The migrated goods receipts were built from the ERP's own received_qty, so a purchase order AutoCount received after the migration has no receipt document [high]

**Symptom.** `check-gr-fidelity.mjs`, corrected run **34136172380** (2026-09-08
early hours local): of 574 migrated purchase orders, **89 have receipts in
AutoCount and no ERP goods receipt at all**. The business effect is concrete —
the outstanding-purchase-order list still shows those goods as not arrived, so
we chase a supplier for furniture that is already in the warehouse.

The same run proved the direction is uniform: **0 of 320 migrated goods receipts
were INVENTED** — there is no case of the ERP claiming more received than the
book recorded. Stock is not overstated. The ERP is simply behind.

**Root cause (traced to the line, two halves).**

*Half one — the migration never read AutoCount's receipts at all.*
`backend/scripts/create-migrated-documents.mjs:79` selects the purchase-order
lines it will mirror with

```sql
WHERE p.company_id = $1 AND p.linked_ac_docno IS NOT NULL
  AND COALESCE(i.received_qty,0) > 0
```

— the ERP's OWN `received_qty` column, never `GRDTL`, never
`PODTL.TransferedQty`. A purchase order whose `received_qty` was 0 on the day the
migration ran produced no goods receipt, whatever the book held. `:81` then
collects every purchase order it has already mirrored into a `done` set and skips
it, so a later run cannot top one up. This is not an accident of that script: it
is the design recorded in `backend/scripts/lib/ac-scope.mjs`, whose
`MIGRATION_SOURCE.GR` states in its own words that the ERP carries "a POINTER on
the purchase order (`purchase_orders.linked_ac_grn_docnos`), not a GRN document".

*Half two — the delta sync raises the number and creates no document.*
`backend/scripts/sync-ac-delta.mjs` lane `recv` (plan ~:856-874, write
**:1385-1399**) is a single statement:

```js
UPDATE scm.purchase_order_items SET received_qty = ${u.to} WHERE id = ...
```

The SO to DO side of that same script HAS a document-creating lane — `do`,
through `lib/migrated-do-writer.mjs`, which writes real delivery documents. The
PO to GR side has no counterpart. So a receipt AutoCount made after the migration
reaches the ERP as a raised number on a purchase-order line with nothing behind
it. The asymmetry is visible in the script's own header comment, where `recv` is
described as "copy ... onto the matching ERP purchase-order line's received_qty"
and `do` as "create the delivery documents".

**The detector in that script cannot see its own gap, and gets blinder with every
run.** `sync-ac-delta` does count "AutoCount goods receipts behind them the ERP
has no mirror for" (`c2.grAbsent`). It fills that set only *after*

```js
if (Math.abs(bookTq - erpRecv) < 1e-6) { c2.agree++; continue; }
```

Once the `recv` lane has raised `received_qty` to match the book, the quantities
agree, the loop `continue`s, and the missing DOCUMENT is never looked at. `recv`
is in the DEFAULT lane string (`desc,pay,links,recv,do,dedi`), so every ordinary
`apply` dispatch shrinks that count without fixing anything. This is the same
false negative CLAUDE.md names and that PR #3076's guard hit once already —
a clean result that is also true of the case you are hunting. It is why the
attribution below was added to `check-gr-fidelity.mjs` and not to `sync-ac-delta`.

**Fix.** No new writer. `backend/scripts/reshape-migrated-grns.mjs` — merged as
PR #3123 and, as measured by `gh run list --workflow=reshape-migrated-grns.yml`,
**never dispatched** — already plans from the BOOK's own (receipt x purchase
order) pairs rather than from `received_qty`, so it creates a document for a
purchase order that has none. The gap was a run that was never made, not a
missing remedy.

What this PR adds is the attribution that proves it, `check-gr-fidelity.mjs`
**TEST 2B** (read-only): every missing receipt is split into COVERED (the reshape
plans a document) and RESIDUAL (it does not), the residual is sub-attributed, and
each is further split by whether the ERP's `received_qty` is already above zero —
which separates "the delta lane raised the number and left no document" from "the
migration's WHERE clause excluded it and never came back". The section also
recomputes the reshape's own population from the same snapshot, so the two
drifting apart is visible rather than assumed.

**Measured before that, offline from the committed snapshots alone** (no database,
no AutoCount connection): in-scope 214 goods receipts over 484 purchase orders;
the reshape's population is 400 (receipt x purchase order) pairs over 318
purchase orders; and of every AutoCount purchase order carrying
`TransferedQty > 0` in the live cut, **0 have a receipt that is out of scope and
0 have no receipt document at all**. So at the BOOK level the reshape's
population has no residual — every in-scope purchase order the book received
against is in its plan. Whether that covers all 89 depends on which purchase
orders the ERP is holding, which is the DB half TEST 2B measures.

**UNTESTED as a remedy.** Nothing in this PR writes a goods receipt, and
`reshape-migrated-grns` has still not been run. "Dispatching the reshape will
bring the 89 in" is a REMEDY CLAIM and it is **UNTESTED** until its apply run
exists and its output is pasted. What IS proven here is the cause and the
attribution.

**The constraint any future run must keep.** Migrated receipts are stamped
`migrated_no_stock` and write NO inventory movement, because the AutoCount
balance snapshot already counts those units as IN. `reshape-migrated-grns.mjs`
re-asserts that with a COUNT before it writes and refuses if it is not zero, and
`check-stock-vs-autocount.mjs` carries a permanent detector for it. A receipt
created without that flag double-counts the stock.

**Ref.** fix/link-identity-and-gr-backfill, 2026-09-08.
