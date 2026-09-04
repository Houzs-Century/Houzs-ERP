## The purchase-order line had no remarks field at all, so the AutoCount wording copied into it was invisible [medium]

**Symptom.** The owner, 2026-09-04: 「那个 description 2 也要记录进我们的 remarks
里面」, and when asked where: 「SO line 和 PO line 的 remarks」. On the sales side
that is a data problem (`docs/bugs/0639-*`). On the purchase side the data was
already there and **no screen rendered it** — desktop or phone.

**Measured on production, 2026-09-04** (read-only `claude_ro`), over the 1,117
migrated company-1 purchase-order lines:

| | lines |
|---|---|
| `notes` byte-identical to `description2` | 891 |
| `notes` contains `description2` plus a suffix | 32 |
| **`notes` non-empty — carries the book's wording** | **923** |
| `description2` set, `notes` blank | 4 |
| both blank | 190 |

Samples: `col:PC-151-03/m.gap:12inch/divan:8inch+2inchleg`,
`Col:PC151-01/Gap:14 inch/Divan:10 inch+I inch leg/1 pair side drawer`. That is
the customer's own spec text, in the salesperson's words.

**Root cause (traced, not inferred).** Three surfaces, none of which read the
column:

- `frontend/src/vendor/scm/components/PoLineCard.tsx` — the shared inline line
  editor for PO Edit, PI Edit and PC Order Edit. A case-insensitive grep for
  `notes` and `remark` over the whole file returned **nothing at all**. There
  was no field, so `notes` could be neither read nor written from the editor.
- `frontend/src/pages/scm-v2/PurchaseOrderDetailV2.tsx` — the live read-only PO
  detail (`App.tsx` routes `/scm/purchase-orders/:id` here). Its `notes` render
  is `purchaseOrder.notes`, the **header** field. The line table had no remark
  cell.
- `frontend/src/mobile/MobileModuleDetail.tsx` — the phone's PO surface. Its
  `mfg-purchase-orders` line adapter emitted `name` / `sub` / qty / price only,
  while `MobileSODetail` has rendered the SO line's `remark` all along.

The backend was never the gap: `ITEM_COLS`
(`backend/src/scm/routes/mfg-purchase-orders.ts:370`) already selects `notes`,
the item POST already persists `it.notes`, the item PATCH field map already
carries `['notes','notes']`, and `NewPoItem` already declares `notes?: string`.

**Why `notes` and not `description2`.** `description2` on a PO line is
server-owned: the item PATCH recomputes it from `buildVariantSummary` on every
write, exactly as the SO route does. `notes` is not recomputed, and it is not on
the AutoCount write-back path — `PO_ITEM_COLS`
(`backend/src/scm/lib/autocount-outbox.ts:396-397`) is `id, item_code,
item_group, description, description2, qty, unit_price_sen, variants,
linked_ac_dtlkey, warehouse_id, delivery_date, photo_urls` and does not select
it. The only `notes` the write-back sends is the **header**'s
(`purchase_orders.notes` → `Description`, `autocount-outbox.ts:1478`). So a PO
line's remark survives every save and never reaches the account book.

**Fix.** A Remarks box on the PO line editor bound to `notes`, seeded from the
stored value and sent on both add and update; the text rendered under the item
on the read-only detail plus a hidden-by-default searchable/exportable Remark
column (the exact twin of `SalesOrderDetailV2`); the same text on the phone's PO
line. `PoLineCard`'s box is **opt-in** (`showRemarks`) because the same card is
reused by the Purchase Invoice and Purchase-Consignment Order details, whose
parents enumerate the fields they send — an unwired box would accept typing and
discard it on save, which is worse than no box.

**Ref.** `feat/po-line-remarks`, 2026-09-04. Sales-side twin:
`docs/bugs/0639-*`.
