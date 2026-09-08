## The goods-receipt reshape wrote AutoCount's own item code on every unattributed line, and the reconcile printed it against itself [high]

**Symptom.** `check-ac-erp-reconcile.mjs`, run **34178538830**, 2026-09-08:
`GR DATA ... item code: 103` for company-1 goods receipts. Every sample printed
two strings that read as identical:

```
GR-004474|PO-008483 DtlKey 801854: AutoCount "HOK-1007 (HF)(W) (SP)" vs ERP "HOK-1007 (HF)(W) (SP)"
```

That looks like a checker bug and is not one. Two separate defects meet in that
line — a DATA defect that put the book's code on an ERP document line, and a
REPORTING defect that hid what the checker had actually compared. **This entry
owns the DATA half only.** The reporting half is fixed in PR #3167
(`fix/so-po-item-code-audit`), which rewrites the item-code reporting inside
`check-ac-erp-reconcile.mjs`; nothing in this change touches that file.

**Root cause (traced).**

1. **The data.** `backend/scripts/reshape-migrated-grns.mjs`, in `lineRows`:

   ```js
   const code = poi ? poi.item_code : i.book.itemKey;
   ```

   The first arm copies the purchase-order line's code, which
   `import-ac-outstanding-po.mjs` had already translated through
   `backend/scripts/data/autocount-erp-mapping-1561.csv`. The second arm is
   taken whenever the receipt line is deliberately left UNATTRIBUTED —
   `GRDTL.FromDocDtlKey` is 0 on all 21,746 AutoCount rows, so a purchase order
   carrying the same item code on more than one line leaves the receipt line's
   purchase-order link unset (owner, 2026-09-07: 「跟 autocount 一样」). That arm
   resolved nothing at all: it wrote AutoCount's raw `ItemCode`.
   `material_name: poi?.material_name ?? code` inherited it, so the product NAME
   became the book's code too.

   The mapping file has the answer for every one of them —
   `HOK-1007 (HF)(W) (SP)` → `CODY 2.0 (F)-(SP)`, `HOK-2006(A) (Q)` →
   `REGAL (A)-(Q)`, `NK-1046 (Q)` → `MINI-(Q)`. Measured on the committed cut:
   **567 in-scope (receipt × purchase order) lines over 142 distinct book codes,
   and all 567 have a mapping row** — nothing here was unanswerable.

2. **The report** (diagnosed here, FIXED ELSEWHERE — PR #3167).
   `backend/scripts/check-ac-erp-reconcile.mjs` compares
   `mapped(al.itemKey) !== norm(el.item_code)` (`const mapped = (s) =>
   codeMap.get(norm(s)) ?? norm(s)`) and then printed `al.itemKey` — the RAW
   book code. A translated-vs-untranslated difference is therefore rendered as
   the same string twice, which is unreadable and reads as a false positive. The
   sofa arm had the same hole in its no-model case, where the CODES are what get
   compared. It is recorded here because without it the symptom above is
   unreadable, not because this change repairs it: `check-ac-erp-reconcile.mjs`
   is untouched on this branch, and PR #3167 owns that file.

**Fix.**

- `reshape-migrated-grns.mjs` resolves the fallback through the same mapping
  file, with the two rules every other CSV item-code writer applies: the **sofa
  alias fold at read time** (`aliasFoldsForCatalog` — only a mapped code the
  catalogue LACKS folds, and only onto one it HAS; `5535` is its own model and
  never folds) and the **catalogue guard at write time** (`nonCatalogRefs` +
  `formatNonCatalogRefusal` + a non-zero exit, placed before the dry-run return
  so an operator learns the plan is unwritable while reading it).
  `material_name` now comes from the ERP product where the code resolves.
  Two lookups keep following the RAW code on purpose: the money carry
  (`carryByPo`) and the invoiced-quantity carry (`billed`) are keyed on what is
  ON DISK, and rows written before this fix hold the untranslated code — a
  translated key would have missed them and silently re-derived the price from
  the book.
- `backend/scripts/repair-migrated-grn-item-codes.mjs` +
  `.github/workflows/repair-migrated-grn-item-codes.yml` repair the rows already
  written: company-scoped, `migrated_no_stock`, AutoCount-linked, and only where
  `purchase_order_item_id IS NULL`. A row is rewritten only when the mapping
  gives a translation AND that code is one `scm.mfg_products` carries; anything
  else is left and counted, because replacing a wrong-but-traceable code with an
  orphan is a worse row, not a repaired one (docs/bugs/0577). PLAN by default;
  `APPLY=1` + `CONFIRM="REPAIR GRN ITEM CODES"` writes.
- **Not fixed here:** the reconcile's print. PR #3167 rewrites the item-code
  reporting in `check-ac-erp-reconcile.mjs`, and this branch deliberately leaves
  that file at `main` so the two changes cannot conflict. Until #3167 lands, a
  reconcile sample on this finding still shows the raw code on both sides.

**Why an item_code rewrite cannot move stock.** The FIFO trigger is
`AFTER INSERT ON scm.inventory_movements`, not on `grn_items`; migrated receipts
carry `migrated_no_stock` (migration 0276) and have zero movements, which
`check-stock-vs-autocount.mjs` asserts. No movement row is written, no quantity,
price, discount, line total, date or status column appears in the repair's
`UPDATE`, and the balance snapshot that supplied the on-hand was keyed on the
AutoCount item, never on this text column. The repair asserts the zero before it
writes and re-asserts it on a fresh connection afterwards, and compares
`SUM(qty_accepted)`, `SUM(unit_price_sen)` and `SUM(line_total_sen)` across the
write rather than resting on the claim.

**Convergence, and the property that gives it.** The repair writes the
translated code back into the column it reads, so a mapping chain `X -> Y -> Z`
would flip those rows on every run. Measured on
`autocount-erp-mapping-1561.csv`: **171 ERP codes are also AutoCount codes and
every one of the 171 maps to ITSELF — zero chains.** The script re-checks that
against the live file and refuses if a future edit breaks it, and
`backend/tests/catalogCodeGuard.test.mjs` pins it too.

**Tests.** `reshape-migrated-grns.mjs` joins `CSV_ITEM_CODE_WRITERS`, so the two
source-level properties (folds the alias; refuses and exits) are now enforced on
four writers instead of three. The repair is in a new list beside it,
`CSV_ITEM_CODE_REPAIRS`, because its refusal is to LEAVE A ROW rather than to
stop — it has no plan to abandon, and exiting on one untranslatable line would
withhold the repair from every other. Its property is stronger than the exit and
is tested as such: a code the catalogue lacks can never enter the write set, and
the `UPDATE` names only `item_code` and `material_name`.

**NOT UN-RUN. UNTESTED against production.** No workflow was dispatched and no
production query was made from this branch. Every count above comes from the
committed AutoCount cut and the mapping file in the tree; the number of rows the
PLAN would actually rewrite is unknown until somebody runs
**Repair migrated GRN item codes** in PLAN mode.

**Ref.** fix/gr-itemcode-0908, 2026-09-08. Related: docs/bugs/0577 (the orphan
item_code this guard class was built from), docs/bugs/0686 (the fold belongs at
READ time, and the membership rule is "writes an item_code from the mapping
CSV"), docs/bugs/0674 (the unattributed-line ruling this defect rides on).
