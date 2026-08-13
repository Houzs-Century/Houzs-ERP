# Module: Purchase Return (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Goods going BACK to a supplier. The mirror of the Goods Received Note: a GRN
moves stock IN, a PR sends it OUT.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.

Written 2026-08-05 to close the gap CLAUDE.md names — the module gained guards on
2026-08-04 and had no guide. Read this before changing the module; if your change
alters its SURFACE (an endpoint, a permission, a status, a field that starts or
stops being required, a lock), update this file in the same PR.

---

## 1. What it is for

Stock received from a supplier is sent back — damaged, wrong, or surplus. The
return names the GRN it came from, its lines name the GRN lines, and posting it
takes the stock out at the cost it came in at. A credit note reference closes it.

---

## 2. The status model — and the thing that will surprise you

`DRAFT → POSTED → COMPLETED`, plus `CANCELLED`.

**But a PR is created as POSTED.** The DRAFT stage was removed: `POST /` writes
the row as `POSTED` with the inventory OUT **already written**. `PATCH /:id/post`
survives only for backward compatibility with callers that still call it, and it
is deliberately **idempotent** — an already-POSTED or COMPLETED row returns 200
without re-writing movements, because re-writing them would double-debit
inventory. Anything else 409s `cannot_post`.

So: do not write code that waits for a PR to be posted, and do not add a second
"post" path. If you need a not-yet-real return, that is a different concept and
this module does not have one.

`PATCH /:id/complete` moves POSTED → COMPLETED and takes an optional
`creditNoteRef`. Its tenancy check runs **before** the state guard on purpose, so
a same-company return that simply is not POSTED gets the honest "not posted"
message rather than a company-mismatch 404.

---

## 3. Surfaces

| Surface | File |
|---|---|
| Desktop list | `frontend/src/pages/scm-v2/PurchaseReturnsListV2.tsx` |
| Desktop detail | `frontend/src/pages/scm-v2/PurchaseReturnDetailV2.tsx` |
| Desktop new | `frontend/src/pages/scm-v2/PurchaseReturnNew.tsx` |

**No dedicated mobile screen** — the generic `MobileModuleList` /
`MobileModuleDetail` render it. The repo-wide "desktop and mobile change
together" rule has no paired file to apply to here.

The consignment variants (`PurchaseConsignmentReturn*.tsx`) are a **different
module** on different tables. Do not change one expecting the other to follow.

---

## 4. API surface

Mounted in `backend/src/scm/index.ts`:

```
scm.use("/purchase-returns/*", scmAreaGuard("scm.procurement.pr"));
scm.route("/purchase-returns", purchaseReturns);
```

One guard, `scm.procurement.pr`, over the whole router — read and write.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List |
| GET | `/:id` | One return, header + lines |
| GET | `/:id/linked` | The GRN and PO behind this return, for the detail's links |
| POST | `/` | Create — **lands as POSTED with inventory OUT written** (§2) |
| POST | `/from-grn`, `/from-grns` | Convert GRN line(s) into a return |
| PATCH | `/:id/post` | Back-compat, idempotent (§2) |
| PATCH | `/:id/complete` | POSTED → COMPLETED, optional `creditNoteRef` |
| PATCH | `/:id/cancel` | `cancelPurchaseReturnHandler` |
| PATCH | `/:id` | Update the header |
| POST | `/:id/items` | Add a line — 201 `{ item, movementErrors? }` (§4a) |
| PATCH | `/:id/items/:itemId` | Update a line — 200 `{ ok, movementErrors? }` (§4a) |
| DELETE | `/:id/items/:itemId` | Remove a line — 200 `{ ok, movementErrors? }` (§4a) |

Handler file: `backend/src/scm/routes/purchase-returns.ts` (~1,400 lines — use
`docs/generated/route-locator.md` to jump to a handler instead of reading it
whole).

`GET /:id/linked` has a Supabase-specific trap worth knowing: **typegen returns
joined rows as arrays even for to-one FKs**, so `grn` and `purchase_order` come
back as arrays and the handler unwraps them. Any new join here needs the same
unwrap.

### 4a. `movementErrors` — a SUCCESS that moved no stock

Every write on this module that touches inventory answers with the document AND
an optional **`movementErrors: string[]`**, one entry per refused movement,
shaped `OUT|IN <returnNumber>: <reason>`. It is the same field and the same
shape on `POST /` (create) and on all three line verbs, so a client handles ONE
shape for one concept.

Why it exists: `writeMovements` **never throws** — it logs and returns
`{ ok:false, reason }` — so a `try{}catch{}` around it catches nothing and the
result must be READ. Until 2026-08-13 the three line verbs discarded it, so a
line add / qty edit / delete moved `qty_returned`, `grn_items.returned_qty` and
the refund rollup while the compensating movement was refused, and answered a
clean 201 / 200 / 204.

The policy is **best-effort, and the write COMMITS** — an edit is not rolled back
for a ledger hiccup. Three things happen instead:

1. the response carries `movementErrors`;
2. a `RECOUNT_FAILED` row lands on `scm.entity_audit_log` under entity type
   `PURCHASE_RETURN` (the shape `grns.ts` and `delivery-orders-mfg.ts` already
   use). It is written for an investigator and for `GET /inventory/reconcile`,
   not for a tab — the frontend History drawer does not render this entity type,
   exactly as it does not render `DELIVERY_ORDER`;
3. the frontend raises it: `reportMovementErrors` in
   `frontend/src/vendor/scm/lib/purchase-return-queries.ts` calls the shared
   `writeFailedAs` for create / line-edit / line-delete.

**`DELETE /:id/items/:itemId` answers 200, not 204** — a 204 has no body and so
cannot carry the failure at all. Every sibling line-delete
(`consignment-notes.ts`, `consignment-returns.ts`, `delivery-returns.ts`) already
answered 200 `{ ok, movementErrors? }`.

---

## 5. The unlinked-line guard — read this before touching create/add-item

`scm.purchase_returns.grn_id` names a GRN, but
`scm.purchase_return_items.grn_item_id` is **nullable**. A line with a null link
still sends goods OUT, yet counts toward no GRN line, so the pool that governs
the chain (`qty_accepted − returned_qty`) never moves and the same goods can be
returned twice. The file's own comment used to record the gap plainly: *"Manual
lines (no grnItemId) stay uncapped."*

`backend/src/scm/lib/return-unlinked-lines.ts` (`findUnlinkedPrLines`,
`unlinkedReturnResponse`) applies the same narrow rule as the other three chains:

| situation | outcome |
|---|---|
| header names no GRN | allowed — nothing to bypass |
| item is NOT on the named GRN | allowed — genuinely ad-hoc |
| item IS on the named GRN but the line does not link to it | **REFUSED** — link it |

A production scan on 2026-08-04 found **zero** rows of this shape, so the guard
is preventative (UNVERIFIED as of 2026-08-13: needs production data). It was
added anyway because the cost is one query on a path already doing several, and
the cost of not having it on the delivery side was three weeks of a double
deduction nobody could see (`docs/unlinked-line-duplicate-coe.md`).

**Unlike Delivery Return, this narrow rule is the ONLY link guard here.** The DR
side additionally refuses every unlinked line outright (409 `do_link_required`);
purchase returns have no equivalent, so the two "allowed" rows above really are
reachable and `grn_item_id` NULL rows really do get written.

---

## 6. Data model

| Table | Role |
|---|---|
| `scm.purchase_returns` | Header — `return_number`, `status`, `grn_id`, `posted_at`, `company_id` |
| `scm.purchase_return_items` | Lines — `grn_item_id` (nullable, §5), item, qty, cost |

Every read is company-scoped through `requireActiveCompanyId(c)` +
`scopeToCompanyId(...)`, returning `NOT_THIS_COMPANY` (404) rather than leaking
that the row exists elsewhere. Unlike Delivery Return, there is **no sales-scope
row filter** here — procurement is not scoped own+downline.

---

## 7. Traps, collected

- **Created as POSTED.** Inventory OUT is written at create. Anything that
  assumes a DRAFT stage is wrong.
- **`/:id/post` is idempotent by design.** Do not "fix" it into a real
  transition; re-writing movements double-debits inventory.
- **`grn_item_id` is nullable and always will be** — ad-hoc lines are
  legitimate. The guard is what keeps that from being a bypass.
- **Tenancy check before state guard** on `/complete`, so error messages stay
  honest.
- **`writeMovements` never throws.** Capture and read its result, or the failure
  is invisible — see §4a. The same is true of `writePrLineDeltaMovement`, which
  now returns the error array rather than void.
- **The desktop detail page has no line editor.** `useUpdatePurchaseReturnItem` /
  `useDeletePurchaseReturnItem` exist in `purchase-return-queries.ts` with no
  consumer, and the list/detail "Edit" buttons navigate to `?edit=1`, a param
  `PurchaseReturnDetailV2.tsx` reads nowhere. `POST /:id/items` has no frontend
  caller at all. The line verbs are reachable by API only today, so the
  `movementErrors` wiring in the hooks is what a future editor inherits.
- **Joined to-one FKs come back as arrays** from Supabase typegen.
- **Consignment returns are a different module.**
- **No mobile twin.**

## See also

- `docs/modules/delivery-return.md` — the mirror module, same shape
- `docs/unlinked-line-duplicate-coe.md` — why the guard exists
- `BUG-HISTORY.md` 2026-08-04, "The two RETURN chains had the same nullable-link
  hole"
