## The special-order text reached the supplier PDF but was invisible on every cost document [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner, 2026-09-10, immediately after the Custom / other free
text opened on the Sales Order: 「你确定是 CS order 有而已，还是全部吗？我们的包括
DO 等等，全部都是要带过去的哦，要不然你有 column 的话也带不过去。POGR 是不是也是要
能看得到这些数据？…简单来说，它的跑法应该跟正常的 bed frame 和 sofa 是一样的」

He is right, and the shape is worth stating precisely because half of it was
already working:

- the text DID reach the supplier's purchase order. `description2` is stamped
  server-side from `buildVariantSummary`, which appends the `SPECIAL:` segment
  AFTER the per-group attribute branch, so a category contributing no attributes
  still carries its note.
- the text was NOT visible on any cost document's screen. The buyer could
  neither read it nor correct it, and had no way to know it was there.

**Root cause (traced).** `SpecialOrders` is the one shared editor (owner
2026-07-20), but every caller decides for itself whether to render it, and every
cost document gated that decision on bedframe or sofa:

| file | gate |
| --- | --- |
| `frontend/src/vendor/scm/components/PoLineCard.tsx:229` | `showVariants = ['sofa','bedframe'].includes(l.category) && maint` |
| `frontend/src/pages/scm-v2/PurchaseOrderNew.tsx:1014` | same expression |
| `frontend/src/pages/scm-v2/GrnNew.tsx:1022` | `isManualLine && (bedframe \|\| sofa) && maint` |
| `frontend/src/pages/scm-v2/PurchaseInvoiceNew.tsx:827` | `grnItemId === null && (bedframe \|\| sofa) && maint` |
| `frontend/src/pages/scm-v2/PurchaseReturnNew.tsx:443` | `isManualLine && (bedframe \|\| sofa) && maint` |
| `frontend/src/pages/scm-v2/GoodsReceivedDetail.tsx:723` | `isEditing && !source_po_number && (bedframe \|\| sofa) && maint` |

Each of those also requires `maint` (the maintenance config) because the variant
GRID needs it. `SpecialOrders` does not — so a mattress or accessory line was
excluded twice over.

**Fix.** The same shared module the Sales Order and both mobile surfaces already
read — `frontend/src/vendor/scm/lib/special-order-surface.ts` — now decides on
the cost documents too, and each one renders the panel for the categories with no
variant grid. The pool passed is EMPTY on purpose: a cost document carries no
add-on catalogue for those categories, and choosing WHAT to build belongs to the
sales order, not the buyer.

That empty pool exposed a second defect in the shared component, fixed here:
`retired` was computed as "picked and not in `options`", so with no catalogue
EVERY carried pick was labelled *"retired — untick to remove"* — telling the
buyer that what the factory is building is dead, and inviting them to delete it.
A catalogue we do not have cannot call anything retired. With no pool the picks
now render read-only under *"from the Sales Order"*. Proved RED on the unfixed
tree: `1 failed | 8 passed` in `SpecialOrders.test.tsx`.

**Checked and NOT changed, with the reason:**

- **Delivery order — already correct.** `backend/src/scm/lib/do-item-row.ts:124`
  copies the sales-order line's `variants` wholesale onto the DO line and stamps
  `description2` from `buildVariantSummary`, and
  `frontend/src/pages/scm-v2/DeliveryOrderDetailV2.tsx:952` renders that same
  summary. The note carries and displays for every category today.
- **Goods-received DETAIL already SHOWED it** — `variantSummary` at line 609 is
  `buildVariantSummary(...)` for every line, whatever the group. What was added
  there is the ability to TYPE it on a MANUAL line, not to see it.
- **Stock adjustment — deliberately left alone.** It is not a supplier-facing
  document and the note is not part of a lot's identity (`extraAddonNote` is read
  by no branch of `computeVariantKey`), so a special order there would be a field
  with no reader. Reversible in one block if the owner wants it.
- **The mattress ADD-ON PICKER is not reintroduced on the purchase order.** The
  owner removed the mattress VARIANT editor in 2026-05 (「mattress variant 还有
  branding 为什么要带出来呢？不需要带出来啊」) because size and branding are already
  in the SKU code. That ruling stands; this adds the special-order TEXT only.

**Ref.** fix/special-carry-through, 2026-09-10.
