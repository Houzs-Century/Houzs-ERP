## The migrated delivery orders never recorded which branch shipped them [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** Company 1 go-live. Open any migrated delivery order and the
ship-from branch is blank — the ERP holds the delivery but cannot say whether
the goods left KL, PG, SBH or SRW, while AutoCount has recorded it on every one
of those documents all along.

**Root cause (traced).** `backend/scripts/lib/migrated-do-writer.mjs`
`insertMigratedDo()` names eleven header columns:

```
(do_number, so_doc_no, debtor_code, debtor_name, status, do_date, currency,
 company_id, created_by, notes, migrated_no_stock, linked_ac_docno)
```

`warehouse_id` and `sales_location` are not among them. Both already exist on
`scm.delivery_orders` (`warehouse_id` is read at `delivery-orders-mfg.ts:871`
and travels in the detail payload; `sales_location` came in with the baseline),
so the omission cannot fail — the columns simply stay NULL, on every migrated
document, silently. This is the same shape as
`docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md`: a
writer that names a subset of the columns its documents need, where the
un-named ones default rather than refuse.

**Why it is not only cosmetic.** `resolveDoLineWarehouses`
(`delivery-orders-mfg.ts:645`) resolves a line's ship-from warehouse in order:
(1) the linked SO line's `warehouse_id`, (2) **the DO header's**, (3) the
company default. A migrated line with no `so_item_id` — which is exactly the
shape the substitution ruling introduces
(`docs/bugs/0674-*`) — skips (1), finds (2) NULL, and lands on a
company-blind default. No stock is at risk on these documents (`migrated_no_stock`,
zero movements by construction), but the warehouse a person READS is wrong, and
step (2) is the step that was supposed to answer.

**Fix.** Owner ruling 2026-09-07 — *"记在单头就好"*, the location goes on the
HEADER, not on a per-line column. Measured before asking, which is why the
question was worth asking: a line's `Location` equals its header's
`SalesLocation` on **46,182 of 46,194** non-blank book lines, and only
**2 of 11,134** documents span two locations (`DO-000140` PG+HQ, `DO-000153`
KL+SUNWAY — both NAMED in every run, neither in the migrated corpus). A per-line
column would carry 46,194 values to express 11,134 facts.

- `backend/scripts/lib/ac-do-location.mjs` is the ONE rule, shared by the
  writer's caller and the backfill so a document stamped as it is written and
  one stamped later cannot land on different branches. It uses the **shared**
  `SALESLOC` from `lib/ac-stock-compare.mjs` — the map the PO importer's
  `whId()` already uses — and resolves through `lib/resolve-warehouse-location.mjs`,
  the tested spec of migration 0309's backfill.
- Sources, in order, never guessed: the book's own DO header; where that
  snapshot runs behind the book (19 of the cutover cut's 84 documents), the
  document's own lines and **only** when unanimous; otherwise NULL, reported and
  left alone. Where both sources exist they agree on **65 of 65**.
- `sales_location` and `warehouse_id` are written from the SAME answer, so the
  stored text and the stored id can never tell a reader different things — the
  read-back asserts exactly that, on a fresh connection, alongside re-asserting
  that these documents still carry **zero** inventory movements.
- Shown on both surfaces: a *Ship-from warehouse* field on the desktop DO detail
  (`DeliveryOrderDetailV2.tsx`, labelled through the shared `warehouseLabel`
  rule) and the mobile DO detail's own row (`MobileModuleDetail.tsx`).

**No migration.** Both columns already existed; this writes them.

**Ref.** PR (2026-09-08). Tests: `backend/tests/acDoLocation.test.mjs` — 12
cases pinning the source order and, more importantly, every refusal: lines that
disagree, a book with no location, and a location that maps to no warehouse in
this company.
