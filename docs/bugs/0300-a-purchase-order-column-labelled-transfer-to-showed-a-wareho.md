## A purchase-order column labelled "Transfer to" showed a WAREHOUSE, one click from a "Transfer To (GRN)" that meant the next document [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Found while auditing the convert/transfer vocabulary for the
owner's question 2026-08-17, not reported from the floor. On the default
purchase-order screen (`/scm/purchase-orders/:id`, `PurchaseOrderDetailV2`) the
line grid carried a column headed **"Transfer to"** whose value was the
destination **warehouse name**. Add `?edit=1` to the SAME url and the inline
editor (`PurchaseOrderDetail`) heads a table **"Transfer To (GRN)"**, meaning the
downstream goods-received note. One document, one route, two meanings for the
same two words, one click apart.

**Root cause (traced, not guessed).** Two vocabularies grew independently and
met in this module. `getValue` on the column is
`warehouseNameById.get(l.warehouse_id)` — it never read a document. Meanwhile
nine other live screens use "Transfer From/To (`<Doc>`)" for document lineage,
which is also what AutoCount's SDK calls a conversion (`TransferFrom` is a
first-class SDK type; `SalesDocument.FullTransfer` / `PartialTransfer` are the
primitives) and what the mirror column `sales_orders.transfer_to` holds. So the
warehouse column was the outlier, and nothing flagged it because a label is not
type-checked against the value it renders.

Verified live, not assumed: `PurchaseOrderDetail` is NOT dead code — it is the
inline editor, lazily imported by `PurchaseOrderDetailV2` and rendered whenever
`?edit=1` lands on the route. `git grep -n 'import("./PurchaseOrderDetail")' -- frontend/src`
is the check. (`docs/transfer-from-to-vocabulary.md` had recorded it, and two
sibling editors, as dead; that came from looking for a route in `App.tsx`, which
cannot see a lazy `import()` inside a sibling page. Corrected in that file.)

**Fix.** The column is relabelled **"To Warehouse"**, matching what
`StockTransferNew` / `StockTransferDetail` already call the same concept, which
frees "Transfer to" for the document sense the rest of the system now uses. The
column `key` stays `transferTo` deliberately: `DataTable` persists column
visibility, order and width per `tableId` in localStorage, so renaming the key
would silently reset every operator's saved layout for that grid. The key is
listed for the identifier stage instead.

**Ref.** PR for the owner-approved transfer-vocabulary Stage 1, 2026-08-17.
Audit and staging in `docs/modules/document-conversion.md` §9.
