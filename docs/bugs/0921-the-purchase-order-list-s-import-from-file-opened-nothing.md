## The purchase order list's Import from file opened nothing [low]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** On the Purchase Orders list, the arrow beside *New Purchase Order*
offers *Import from file*. Pressing it closed the menu, added `?import=1` to the
address, and did nothing else.

**Root cause (traced).** `PurchaseOrdersListV2.tsx` `goImport` navigated to
`/scm/purchase-orders?import=1`, and nothing in the frontend reads an `import`
parameter. `git grep -n "import=1" origin/main -- frontend/src` on 2026-09-15
returned only the six `goImport` / menu lines of six list pages (purchase orders,
delivery orders, delivery returns, purchase invoices, purchase returns, sales
invoices; the sales order list has the menu label too) and no reader. The menu
item was a placeholder that shipped.

**Fix.** On the purchase order list only, the item is now **Import lines** and
`?import=1` opens the PO line import (owner ruling 2026-09-15: edit the exported
PO lines in Excel, import them back; see `docs/modules/purchase-order.md`,
*PO line import*). The item is offered only to a user who may edit purchase
orders (`canOperatePurchaseOrders`). `PoLineImportModal.test.tsx` pins the flow
from file to preview to Confirm.

**Not fixed, on purpose.** The same dead item is still on the delivery order,
delivery return, purchase invoice, purchase return and sales invoice lists, and
the label on the sales order list. Each needs its own import to exist first.

**Ref.** feat/po-line-import, 2026-09-15.
