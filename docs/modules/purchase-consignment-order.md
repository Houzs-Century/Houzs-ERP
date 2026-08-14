# Module: Purchase Consignment Order (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

An order to a supplier for goods held on **consignment** — the supplier's stock
parked in my warehouse. The goods stay the supplier's until a settlement turns
them into owned stock.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.

Written 2026-08-11 to close the gap CLAUDE.md names — the module lost an endpoint
that day and had no guide. Read this before changing the module; if your change
alters its SURFACE (an endpoint, a permission, a status, a field that starts or
stops being required, a lock), update this file in the same PR.

---

## 1. What it is for, and what it is NOT

A PC Order is a **clone of the owned-stock Purchase Order** with the owned-stock
pipeline stripped out. It orders goods the supplier still owns.

**ORDER-ONLY — a PC Order writes NO `inventory_movements`.** It is the paper
commitment, nothing more. Its children are the ones that touch the ledger (since
2026-06-05):

| document | ledger effect |
|---|---|
| PC Order | **none** |
| PC Receive (`purchase-consignment-receives`) | books stock **IN** |
| PC Return (`purchase-consignment-returns`) | books stock **OUT** |

What the clone deliberately DROPPED from the real PO, and must not grow back by
accident: the MRP shortage picker (`/outstanding-so-items`), the From-SO bulk
converter (`/from-sos`), per-line `so_item_id` linkage and `recomputeSoPicked`,
and the GRN-receipt rollups. None of them apply off the owned-stock pipeline.

**A PC Order never reaches AutoCount.** Mig 0277 pins
`scm.autocount_outbox.doc_type` to `SO / PO / DO / IV / GR / PI`; consignment
purchasing is not in that vocabulary.

---

## 2. The status model

`SUBMITTED → PARTIALLY_RECEIVED → RECEIVED`, plus `CANCELLED`.

**There is no DRAFT.** A PC Order is created as `SUBMITTED`. `PATCH /:id/submit`
survives only for legacy callers and is a **no-op**: already-SUBMITTED returns
200 unchanged, anything else 409s `cannot_submit`. Do not write code that waits
for a PC Order to be submitted.

**`CANCELLED` is terminal, and it is the ONLY way to retire a PC Order.**
`PATCH /:id/cancel` stamps `cancelled_at`. It is idempotent (already-CANCELLED
returns 200) and refuses a `RECEIVED` order with `cannot_cancel`.

**There is NO document delete** — see §5.

**Known gap: there is no Reopen.** The owned PO has `PATCH /:id/reopen`; this
module does not. A PC Order cancelled by mistake cannot be brought back through
the API. Not introduced by the delete removal (delete never un-cancelled
anything either), but worth knowing before you tell a user to just cancel it.

---

## 3. Surfaces

| Surface | File |
|---|---|
| Desktop list | `frontend/src/pages/scm-v2/PurchaseConsignmentOrders.tsx` |
| Desktop detail | `frontend/src/pages/scm-v2/PurchaseConsignmentOrderDetail.tsx` |
| Desktop new | `frontend/src/pages/scm-v2/PurchaseConsignmentOrderNew.tsx` |
| Query hooks | `frontend/src/vendor/scm/lib/purchase-consignment-order-queries.ts` |

**No dedicated mobile screen** — the generic `MobileModuleList` /
`MobileModuleDetail` render it under module key `purchase-consignment-orders`.
It is not in `statusActionsFor`, so mobile offers **no** status actions for it:
cancel is desktop-only today. The repo-wide "desktop and mobile change together"
rule has no paired file to apply to here.

The owned-stock `PurchaseOrder*.tsx` pages are a **different module** on
different tables. Do not change one expecting the other to follow — that
assumption is exactly how the deleted endpoint in §5 got here.

---

## 4. API surface

Mounted in `backend/src/scm/index.ts`:

```
scm.use("/purchase-consignment-orders/*", scmAreaGuard("scm.consignment.po_orders"));
scm.route("/purchase-consignment-orders", purchaseConsignmentOrders);
```

One guard, `scm.consignment.po_orders`, over the whole router — read and write.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List with filters |
| GET | `/:id` | Detail — header + items |
| GET | `/:id/linked` | Downstream receives / returns, for the detail's links |
| POST | `/` | Create — lands as `SUBMITTED` |
| PATCH | `/:id` | Update the header |
| POST | `/:id/items` | Add a line |
| PATCH | `/:id/items/:itemId` | Update a line |
| DELETE | `/:id/items/:itemId` | Remove a line (child-lock applies) |
| PATCH | `/:id/submit` | Legacy no-op (§2) |
| PATCH | `/:id/cancel` | → `CANCELLED`, terminal |

Handler file: `backend/src/scm/routes/purchase-consignment-orders.ts` (~660
lines). Use `docs/generated/route-locator.md` to jump to a handler.

---

## 5. The document delete, and why it is gone

`DELETE /purchase-consignment-orders/:id` used to hard-purge a `CANCELLED` PC
Order — the header, and by FK `ON DELETE CASCADE` every line with it. It was
removed 2026-08-11 under the owner's rule **不可以删只可以 cancel**.

It was the same endpoint #1939 removed from purchase orders, copied here
("mirror PO", as the frontend hook's own comment said), and it was **worse than
the PO one**: the PO at least wrote an audit row before the purge, so something
survived to say the document had existed. This one wrote nothing at all.

Removed with it: `useDeletePurchaseConsignmentOrder`, and the desktop
"Permanently delete" button that appeared on `CANCELLED`.

**What is NOT a violation and must stay** — the create-time rollback at
`purchase-consignment-orders.ts:371`. supabase-js has no transaction, so that
compensating delete is the only thing standing between a failed line insert and
a headerless orphan PC Order. It removes a document that never successfully
existed.

Full classification of every delete on the SCM route surface:
`docs/hard-delete-inventory.md`.

---

## 6. The downstream lock — read this before touching cancel or any edit path

`pcoHasDownstream()` is the Tier 2 lock. A PC Order becomes **read-only** — no
header edit, no line edit, no cancel — once it has **any non-CANCELLED PC
Receive**. Refusal is 409 `pco_has_downstream`.

It mirrors `poHasDownstream` in `mfg-purchase-orders.ts` but points at
`purchase_consignment_receives`, **not** the real `grns` table. A PC Order is
never on the GRN chain.

Note the consequence, since it now has no delete as an escape hatch: to retire a
PC Order that has already been received against, you cancel the **PC Receive**
first (itself cancel-only — it has no delete either), then the PC Order.

---

## 7. Data model

| Table | Role |
|---|---|
| `scm.purchase_consignment_orders` | Header (mig 0154) — uuid `id` PK, `pc_number TEXT UNIQUE`, `status`, `supplier_id`, `purchase_location_id`, `po_date`, `expected_at`, `currency`, `subtotal_centi` / `tax_centi` / `total_centi`, `submitted_at`, `received_at`, `cancelled_at`, `company_id` |
| `scm.purchase_consignment_order_items` | Lines — `binding_id`, `material_kind` (`mfg_product` / `fabric` / `raw`), `material_code`, `supplier_sku`, `qty`, `unit_price_centi`, `line_total_centi`, `received_qty` |

Numbering: `PCO-YYMM-NNN`, minted by `mintMonthlyDocNo` +
`insertWithDocNoRetry` — a unique-violation (23505) on `pc_number` re-derives the
next free number instead of 500ing.

Header dates `supplier_delivery_date_2/3/4` (mig 0181) are the supplier's
revised promises, kept alongside the original `expected_at`.

Currencies: `MYR`, `RMB`, `USD`, `SGD`.

Every read is company-scoped through `requireActiveCompanyId(c)` +
`scopeToCompanyId(...)`, returning `NOT_THIS_COMPANY` (404) rather than leaking
that the row exists in another company.

---

## 8. Traps, collected

- **No DRAFT.** Created as `SUBMITTED`; `/submit` is a no-op.
- **No document delete, and no Reopen.** `CANCELLED` is terminal in both
  directions.
- **Writes no inventory.** The receive and the return do; the order does not.
- **Not the owned PO**, despite being a line-for-line clone of it. The child
  lock points at PC Receives, not GRNs; there is no SO linkage.
- **Never syncs to AutoCount.**
- **Mobile offers no status actions** for this module.
- **The rollback delete at `:371` is not the document delete.** Leave it.

## See also

- `docs/modules/purchase-order.md` — the owned-stock original this clones
- `docs/hard-delete-inventory.md` — every SCM delete, classified
- `BUG-HISTORY.md` 2026-08-11, "Two more document-level hard deletes"
