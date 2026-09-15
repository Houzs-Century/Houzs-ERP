## A sort or funnel clicked on one document's lines re-ordered or hid the lines of every document of that kind [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, 2026-09-15, asking whether the SKU Master jump (0940) happens
elsewhere:
「全套系统会不会有这种问题呢？我看到的东西，我要去 edit 的时候，突然它位置不见了。」

The audit found it on the eight document detail pages: Sales Order, Delivery
Order, Purchase Order, Goods Received, Purchase Invoice, Sales Invoice, Delivery
Return and Purchase Return. The line table can differ from what Edit opens:

- **Order.** A header sort clicked on one document's line table re-sorted the
  lines of every later document of that kind. The editor behind Edit shows the
  document's own line order.
- **Visible lines.** A funnel ticked on one document hid lines on the others.

**Root cause (traced).** Each detail page renders its lines with
`layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.<kind>Lines}`. One layout is shared by
every document of the kind, which is right for columns and widths.

DataTable keys the saved sort (`dt:sort:<idKey>`, `DataTable.tsx:743` at
`31352ebe3`) and the saved funnels on that same `idKey = layoutFamily ||
tableId`. So a sort or funnel became a standing setting for every Sales Order,
every Purchase Order, and so on.

The editors never read either. They render the server's line array:

- `SalesOrderDetail.tsx` → `detail.data.items`
- `PurchaseOrderDetail.tsx` → `setEditLines(items.map(draftFromItem))`
- `GoodsReceivedDetail.tsx` → `visibleItems = items`
- `PurchaseInvoiceDetail.tsx` → `items.map(draftFromItem)`
- `DeliveryOrderNewV2.tsx` → `doDetail…items.map`

Same class as the stuck list sort cleared on 2026-08-05 (`lib/staleSortReset.ts`)
and the stuck SKU funnel (0917).

**Fix.**

- **New DataTable option.** `persistSort={false}` mirrors `persistFilters={false}`:
  the sort lasts for the visit and any saved one is erased.
- **All eight line tables use both options.** A document now always opens in its
  own line order with every line showing, the same order its editor, PDF and
  AutoCount use.
- **Columns, widths and pinning stay shared** across the kind.

Pinned by:

- `frontend/src/components/DataTable.test.tsx` ("persistSort={false} sorts for
  this visit only"). On the unfixed DataTable a stored `desc` sort was replayed
  (`Order 3, 2, 1` against the expected `1, 2, 3`), so it was RED; it is GREEN
  after.
- `frontend/src/components/dataTableLayoutFamilies.test.ts`. It fails when a line
  table using a document family omits either option. `persistSort` did not exist
  on `origin/main` (`git grep persistSort` returned nothing).

**Still open, for the owner.** Sorting a document's lines and then pressing Edit
in the same visit still opens the editor in document order. The editors are
separate screens whose line order is the document's, so this was left as a
choice (see the PR).

**Ref.** fix/edit-order-and-mrp-colours, 2026-09-15.
