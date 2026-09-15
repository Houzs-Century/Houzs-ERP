## Import SKUs moved a modelled SKU away from its model and siblings [medium]

**Symptom.** Importing a sheet that gave one SKU of a model a new category moved
that SKU only. The model and the model's other SKUs kept the old category, so the
SKU Master showed one model's SKUs under two categories — something neither edit
screen allows (owner 2026-09-15: 「导入时如果改到有型号的 SKU 的分类，就连型号和它底下
所有 SKU 一起换，保持一致」).

**Root cause (traced).** `batchImportMfgProductsHandler`
(`backend/src/scm/routes/mfg-products.ts`) wrote `row.category` straight onto the
one `mfg_products` row by code. PR #3911 made it take the category on existing
SKUs but never looked at `model_id`, while `PATCH /mfg-products/:id` refuses a
modelled SKU (409 `category_on_model`) and `PATCH /product-models/:id` moves the
model with all its SKUs. The import was the one path with neither rule.

**Fix.** The model move lives in one helper, `moveModelCategory`
(`backend/src/scm/lib/model-category-move.ts`), used by both
`PATCH /product-models/:id` and the import. Before writing, the import's
`planModelCategoryMoves` reads which rows touch a modelled SKU (company-scoped);
a model the file gives more than one category has all of those rows refused with
a per-row reason; otherwise the model and every SKU of it move once, and the
response's `modelsMoved` names the model, from/to and SKU count, shown in the
import dialog with "orders already written keep the old category". Order lines'
`item_group` is unchanged. `backend/tests/skuCategoryChangeAndImport.test.ts`
(six new cases: cascade, agreeing rows move once, conflicting rows refused,
restating row counts as a conflict, model-less unchanged, other company
untouched) — proved RED on the unfixed tree (6 failed / 10 passed), GREEN after.

**Ref.** fix/import-category-moves-model, 2026-09-15.
