## Import SKUs silently skipped a category typed as its label or in lower case [medium]

<!-- area: Products + SKU master -->

**Symptom.** Owner, 2026-09-15:
「我 import 的话肯定可以把 SKU 改成分类啊，要不然我怎么去 batch edit 呢？」

Import SKUs is his batch edit for category and description. A category cell typed
the way the screen shows it ("Sofa Accessory", "Mattress") or in lower case
changed nothing. The result still said "Saved — N SKUs updated", because the rest
of the row saved.

**Root cause (traced).** `POST /mfg-products/batch-import` accepted only the exact
stored code. At `backend/src/scm/routes/mfg-products.ts:358` (merge base
`404c434b5`):

`if (VALID_CATEGORIES.has(category)) row.category = category;`

Anything else was dropped without a failure row.

**Fix.**

- **Reads what people type.** `parseMfgCategory` in
  `shared/product-categories.ts` reads the stored code in any case, or the label.
- **Reports what it cannot read.** A filled cell it cannot read is reported per
  row ("category "Chair" is not a category — use one of: …") and that row is not
  written.
- **Blank still means keep.** A blank cell still leaves the category alone.
- **No new block.** Import still changes the category and the name (the screen's
  Description) of an existing SKU.

The import handler is exported (`batchImportMfgProductsHandler`) so this is
testable. Pinned in `backend/tests/skuCategoryChangeAndImport.test.ts`. With the
old category rule put back, 2 of 7 fail (label / lower case, unreadable
reported); with the fix all 7 pass.

**Ref.** fix/sku-master-edit-filter-category, 2026-09-15.
