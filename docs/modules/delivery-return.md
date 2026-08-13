# Module: Delivery Return (SCM)

Goods coming BACK from a customer. The mirror of the Delivery Order: a DO moves
stock OUT, a DR brings it IN.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.

Written 2026-08-05 to close the gap CLAUDE.md names — the module gained guards on
2026-08-04 and had no guide. Read this before changing the module; if your change
alters its SURFACE (an endpoint, a permission, a status, a field that starts or
stops being required, a lock), update this file in the same PR.

---

## 1. What it is for

A customer returns delivered goods. The return names the Delivery Order it came
from, its lines name the DO lines, and posting it puts the stock back into a
warehouse at the cost it left at.

The two facts that make this module easy to get wrong:

1. **A return line MOVES STOCK.** It is not paperwork. Every non-service line
   with `qty_returned > 0` writes an inventory IN.
2. **A return line that names no DO line still moves that stock**, but counts
   toward no parent line — which is exactly the hole closed on 2026-08-04. See
   §5.

---

## 2. Surfaces

| Surface | File |
|---|---|
| Desktop list | `frontend/src/pages/scm-v2/DeliveryReturnsListV2.tsx` |
| Desktop detail | `frontend/src/pages/scm-v2/DeliveryReturnDetailV2.tsx` |
| Desktop detail listing | `frontend/src/pages/scm-v2/DeliveryReturnDetailListing.tsx` |
| Desktop new | `frontend/src/pages/scm-v2/DeliveryReturnNew.tsx` |
| Convert from a DO | `frontend/src/pages/scm-v2/DeliveryReturnFromDo.tsx` |

There is **no dedicated mobile screen**. The generic `MobileModuleList` /
`MobileModuleDetail` render it. That is worth knowing before assuming the
repo-wide "desktop and mobile are one product" rule implies a paired file here —
for this module it does not, and a change to the desktop detail has no mobile
twin to keep in step.

---

## 3. API surface

Mounted in `backend/src/scm/index.ts`:

```
scm.use("/delivery-returns/*", scmAreaGuard("scm.sales.returns"));
scm.route("/delivery-returns", deliveryReturns);
```

One guard, `scm.sales.returns`, over the whole router — read and write.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List. `?status=` filter; row-scoped by sales scope (see §4) |
| GET | `/returnable-do-lines` | DO lines still returnable — the picker behind "from DO" |
| GET | `/:id` | One return, header + lines |
| POST | `/` | Create |
| POST | `/from-do`, `/from-dos` | Convert DO line(s) into a return. Same handler (`convertDoLinesToReturn`) under both paths — the plural came later and the singular is kept for callers already on it |
| PATCH | `/:id` | Update the header |
| POST | `/:id/items` | Add a line |
| PATCH | `/:id/items/:itemId` | Update a line |
| DELETE | `/:id/items/:itemId` | Remove a line |
| PATCH | `/:id/status` | Status transition, incl. CANCEL (`patchDeliveryReturnStatusHandler`) |

Handler file: `backend/src/scm/routes/delivery-returns.ts` (~1,600 lines — grep
`docs/generated/route-locator.md` for a path and jump to the line rather than
reading it whole).

---

## 4. Row scope

The list and the detail are scoped by the **sales** scope, not by a returns-
specific one:

- `resolveSalesScopeIds(sb, env, houzsUser.id, canViewAllSales(c))` on the list
- `salesDocOutOfScope(...)` on the detail, which 404s a return belonging to a rep
  outside the caller's own+downline

Note `c.get('houzsUser')?.id` — **never** `c.get('user').id`. Inside `/api/scm/*`
the latter is the bridge's pinned identity, not the caller's. The file comments
this at the callsite because it has been got wrong before.

---

## 5. The unlinked-line guard — read this before touching create/add-item

`scm.delivery_returns.delivery_order_id` names a DO, but
`scm.delivery_return_items.do_item_id` is **nullable**. A line with a null link
still brings goods back IN, yet counts toward no DO line, so the pool that
governs the chain (`delivered − invoiced − returned`) never moves and the same
goods can be returned twice.

`backend/src/scm/lib/return-unlinked-lines.ts` (`findUnlinkedDrLines`,
`unlinkedReturnResponse`) applies the same narrow rule as the delivery and
receiving chains — one definition of "the same item", one shape of refusal:

| situation | outcome |
|---|---|
| header names no DO | allowed — nothing to bypass |
| item is NOT on the named DO | allowed — genuinely ad-hoc / goodwill |
| item IS on the named DO but the line does not link to it | **REFUSED** — link it |

A production scan on 2026-08-04 found **zero** rows of this shape, so the guard
is preventative. It was added anyway because the cost is one query on a path
already doing several, and the cost of not having it on the delivery side was
three weeks of a double deduction nobody could see
(`docs/unlinked-line-duplicate-coe.md`).

---

## 6. Inventory — `resyncInventoryForReturn`

The single most important function in the file (`delivery-returns.ts:437`). It
is a **delta walk to a target**, not an incremental adjustment, which is what
makes edits and cancels safe:

1. Compute the TARGET net IN per `(warehouse, product, variant_key, batch_no)`
   bucket from the return's CURRENT lines. `batch_no` is in the bucket key on
   purpose — a sofa line must target its own dye-lot.
2. A **CANCELLED** return has a target of zero: every bucket drains back out.
3. Write only the difference between target and what is already there.

Two exclusions that will bite if you forget them:

- **SERVICE lines never write IN**, on create or in the resync. Including them in
  the target would make the delta walk write a phantom IN to "catch up".
- Lines with `qty_returned <= 0` are skipped.

Per-line warehouse and batch come from `resolveDrLineWarehouses` /
`resolveDrLineBatches`, falling back to the header's `warehouse_id` — a line can
return to a different warehouse than the header names.

The resync is called **best-effort** after item writes (`try { … } catch {}`), so
an inventory hiccup does not fail the line edit. That is deliberate, and it means
a failed resync is silent: if stock looks wrong after an edit, re-running the
resync is the first thing to try, not the last.

---

## 7. Data model

| Table | Role |
|---|---|
| `scm.delivery_returns` | Header — `return_number`, `status`, `delivery_order_id`, `warehouse_id`, `company_id` |
| `scm.delivery_return_items` | Lines — `do_item_id` (nullable, §5), `item_code`, `qty_returned`, `item_group`, `variants`, `unit_cost_centi` |

Status is compared **case-insensitively** in the resync
(`(status ?? '').toUpperCase()`), so do not assume the column is already
normalised. `CANCELLED` is the value that matters — it is what drives the
drain-to-zero path, and the cancel handler is idempotent (cancelling an already-
CANCELLED return returns success without rewriting).

---

## 8. Traps, collected

- **`do_item_id` is nullable and always will be** — goodwill lines are
  legitimate. The guard is what keeps that from being a bypass; do not "fix" it
  by making the column NOT NULL.
- **The resync is a target walk.** Never add an incremental `+qty` write beside
  it; the two would double-apply.
- **SERVICE lines are excluded from stock, everywhere.** Check
  `isServiceLine({ itemGroup, itemCode })`, not the category string — and note
  that the payload signal is only half the guard. `findServiceLineCodes` also
  reads `mfg_products.category`, because a crafted payload can lie about both
  `item_group` and the code prefix. **Corrected 2026-08-13:** that catalog read
  used to drop its `error`, so a failed lookup returned the same empty list as
  "all clear" and the SERVICE line was admitted. It now returns
  `{ ok: false, reason }` and all four DR write paths 409 with
  `service_check_failed` rather than saving an unchecked line. See
  BUG-HISTORY.md, "A guard that says all clear because it could not look".
- **`houzsUser.id`, not `user.id`**, for anything scope-related.
- **No mobile twin.** Do not go looking for one.

## See also

- `docs/modules/purchase-return.md` — the mirror module, same shape
- `docs/unlinked-line-duplicate-coe.md` — why the guard exists
- `BUG-HISTORY.md` 2026-08-04, "The two RETURN chains had the same nullable-link
  hole"
