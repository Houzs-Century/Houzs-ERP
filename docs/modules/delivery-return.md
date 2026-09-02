# Module: Delivery Return (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

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
   toward no parent line. The write paths now refuse such a line outright
   (409 `do_link_required`), on top of the narrower cross-chain guard added
   2026-08-04. See §5.

---

## 2. Surfaces

| Surface | File |
|---|---|
| Desktop list | `frontend/src/pages/scm-v2/DeliveryReturnsListV2.tsx` |
| Desktop detail | `frontend/src/pages/scm-v2/DeliveryReturnDetailV2.tsx` |
| Desktop detail listing | `frontend/src/pages/scm-v2/DeliveryReturnDetailListing.tsx` |
| Desktop new | `frontend/src/pages/scm-v2/DeliveryReturnNew.tsx` |
| Convert from a DO | `frontend/src/pages/scm-v2/DeliveryReturnFromDo.tsx` |

> **This picker is SCOPED since 2026-08-22.** It reads `doToDr` through
> `readConvertScope`, so the Delivery Order list's right-click "Transfer to
> Delivery Return" opens on the note the operator came from — pre-ticked at each
> line's full remaining — instead of on every returnable delivery in the
> company. With no parameter it is still the full picker, which is what this
> module's own "From Delivery Order" button wants. It read NO parameter at all
> until that date, which is why the menu entry could not be added without
> building the destination half. Contract and guard:
> `docs/modules/document-conversion.md` §4a, §8a.

> **The Salesperson picker names the person the source document already carries
> (2026-08-21).** It reads `usePickableStaff({ onlySales: true, include: [<the
> source doc's salesperson_id>] })`. `onlySales` narrows to Sales positions
> (owner 2026-07-22), and `include` is what stops that narrowing labelling a
> sitting employee **"(former staff)"** — the label is now reachable only for a
> row that genuinely is gone. Contract: `team-members.md`, *"`GET
> /staff/pickable` ALWAYS holds the caller"*. Trace:
> `docs/bugs/0504-the-salesperson-picker-hid-the-person-using-it-so-the-so-sai.md`.

### The desktop list has a right-click menu (2026-08-22)

Open · Edit · Print, then **Cancel Delivery Return** alone at the bottom in red.
Built by `deliveryReturnRowMenu` in `frontend/src/pages/scm-v2/row-menus.ts`, on
the shared `buildRowMenu`, so its shape is the one every other document list has
(`document-conversion.md` §8a).

**Cancel was NEW to the list and NOT a new capability.** It sends `CANCELLED`
through `useUpdateDeliveryReturnStatus` — the same status PATCH this list was
already using for Inspected, Refunded and Reopen, and the same one the detail
page's own Cancel calls. Its confirmation repeats the detail page's words
because the consequence is the same one: creating the return put the goods back
INTO stock, so cancelling reverses that via a negative ADJUSTMENT (§6).

**There is no Confirm entry, and that is not an omission** — a Delivery Return
is RECEIVED on create and has no draft step, so there is no "make this real"
transition for a person to perform.

**Inspected and Refunded stay OFF the menu**, on the row drawer where the
figures that justify them are on screen. Only Confirm, Hold and Cancel are ever
offered to a person (`document-status-vocabulary.md` §1b). Hold is not here yet;
it lands when Hold becomes a flag rather than a status.

**Cancelling is FINAL**, so an already-cancelled row is offered no second
Cancel — the server refuses to un-cancel (§7), which would otherwise leave the
cancel's stock drain in place.

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

**A LOADED delivery order is NOT returnable, and that is now a stated choice
rather than a shared default (2026-08-20).** The picker and the Pending engine
behind it (`lib/do-line-remaining.ts`) take a REQUIRED `DoPendingBasis`, and this
module passes `'delivered'`: goods still on the lorry never left, so nothing can
come back. The Sales-Invoice side passes `'invoiceable'` and DOES offer a LOADED
delivery — the owner ruled on 2026-08-20 (不要拦 —— 人自己知道) that a person
raising an invoice by hand knows whether the goods arrived. The two bases differ
by exactly that one status; see `docs/bugs/0480` before collapsing them.
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
| header names no DO | passes THIS guard |
| item is NOT on the named DO | passes THIS guard |
| item IS on the named DO but the line does not link to it | **REFUSED** 409 `unlinked_so_lines` — link it |

**But a second, blanket guard runs right after it and refuses every unlinked
line anyway.** "Bug #16 — no DO, no Return" (Commander 2026-05-31): `POST /`
(`delivery-returns.ts:1012-1020`) and `POST /:id/items` (`:1363-1370`) both 409
`do_link_required` when a line carries no `doItemId`, whatever the header names.
So the two "passes" rows above are unreachable through the API — the narrow
guard only decides WHICH refusal you get. `convertDoLinesToReturn` always writes
`do_item_id`, so `/from-do` and `/from-dos` never reach either guard.

A production scan on 2026-08-04 found **zero** rows of the narrow shape, so that
guard is preventative (UNVERIFIED as of 2026-08-13: needs production data). It
was added anyway because the cost is one query on a path already doing several,
and the cost of not having it on the delivery side was three weeks of a double
deduction nobody could see (`docs/unlinked-line-duplicate-coe.md`).

Two more refusals live on the same write paths, both 409: SERVICE lines are not
returnable goods at all (`serviceLinesNotReturnableResponse`, `:1005`, `:1383`),
and `checkDrOverRemaining` (`:653`) caps every DO-linked line at its live
remaining-to-return pool, with a post-insert re-derive + rollback closing the
read-before-write race (`:1047-1060`).

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

**`variant_key` in that bucket key is composed from the line's STORED
`item_group`, so the group is the SKU's, not the request's (2026-08-23).**
`computeVariantKey(item_group, variants)` folds a sofa's / bedframe's attributes
into the key only for a sofa or bedframe group; for `others` or null it returns
`''`, so a return line that arrived with a blank or wrong group puts the goods
BACK into the unclassified bucket, where no order looking for that sofa can see
them. The three request-sourced paths — `POST /` (bulk create),
`POST /:id/items` (single add) and the identity half of
`PATCH /:id/items/:itemId` (only when the patch names `itemGroup` or `itemCode`)
— now rewrite the group from `mfg_products.category` by item code, company-scoped,
through `resolveItemGroups` (`lib/sku-category.ts`). The convert-from-DO path is
unchanged and was already correct: it copies the source DO line's row.

This stops NEW rows only; existing lines are not repaired (that needs the
read-only probe's count first — PR #2671). Trace:
`docs/bugs/0524-the-delivery-order-let-the-client-decide-which-stock-bucket.md`.

The resync is called **best-effort** after item writes (`try { … } catch {}`), so
an inventory hiccup does not fail the line edit. That is deliberate, and it means
a failed resync is silent: if stock looks wrong after an edit, re-running the
resync is the first thing to try, not the last.

---

## 7. Data model

| Table | Role |
|---|---|
| `scm.delivery_returns` | Header — `return_number`, `status`, `delivery_order_id`, `warehouse_id`, `company_id` |
| `scm.delivery_return_items` | Lines — `do_item_id` (nullable, §5), `item_code`, `qty_returned`, `item_group`, `variants`, `unit_cost_sen` |

> **Source-cost reads are company-scoped (2026-08-21, docs/bugs/0501).**
> `lib/source-cost.ts sourceUnitCostByItemId` now takes a REQUIRED `companyId`
> and predicates the line read on it — the link ids are caller-supplied and the
> client is service-role, so an unscoped read resolved the OTHER tenant's stored
> cost. This router already refused foreign ids upstream
> (`crossCompanySourceRefusal`); the consignment clones
> (`consignment-notes.ts` / `consignment-returns.ts`) did NOT, and gained the
> full guard set in the same change: `assertSourceLinesInCompany` on the create
> and add-line paths, a company-scoped `consignment_so_doc_no` existence check
> on the note create, and a company predicate on the note's CO-line warehouse
> resolver (a foreign CO line id used to deduct stock out of the other
> company's warehouse under this company's stamp).
>
> **And their "live documents" reads page + scope (2026-08-21, docs/bugs/0503).**
> `checkCrOverRemaining`, `/returnable-note-lines` and
> `/deliverable-order-lines` fetched non-cancelled documents with one un-paged,
> company-blind read — silently capped at 1000 rows, past which the over-return
> guard passed a second full return. The three reads now go through
> `paginateAll` + `scopeToCompany` with errors bound.

Status is compared **case-insensitively** in the resync
(`(status ?? '').toUpperCase()`), so do not assume the column is already
normalised. `CANCELLED` is the value that matters — it is what drives the
drain-to-zero path, and the cancel handler is idempotent (cancelling an already-
CANCELLED return returns success without rewriting; the CANCELLED update is also
conditional on `.neq('status','CANCELLED')` so a lost race echoes instead of
reversing twice). **CANCELLED is FINAL**: any other transition out of it is 409
`dr_cancelled_final` — the drain already ran, so un-cancelling would leave the
books saying "returned" with an empty shelf. Raise a new return instead.

### The incoming status is normalised before any gate reads it (2026-08-18)

`patchDeliveryReturnStatusHandler` now folds the request's status once —
`String(body.status).trim().toUpperCase()` — and every gate below reads the
folded value. Before, the READ side uppercased the PERSISTED status while the
gates compared the INCOMING one verbatim, so a client sending lowercase
`cancelled` missed the idempotent echo, missed the atomic
`.neq('status','CANCELLED')` single-flight, and **never called
`resyncInventoryForReturn`** — the document read cancelled while the stock it
returned stayed on the shelf. `delivery_return_status` is an enum, so in practice
that request 500'd rather than persisting; the operator simply could not cancel.
Same class as `SI_STATUS_CANON` on Sales Invoices, with stock in place of revenue.

No status whitelist was added — see the caveat below; the enum is the vocabulary.

### The status set, and who writes it (2026-08-16)

DB type is the `scm.delivery_return_status` ENUM; column default is `PENDING`.

| Value | Set by |
|---|---|
| `RECEIVED` | **the create insert** — stock IN is written at create, so a DR is never "pending" in practice. Also settable through the status PATCH |
| `PENDING` | the DB default **only**. No code path writes it |
| `INSPECTED` / `REFUNDED` | `PATCH /:id/status` (stamps `inspected_at` / `refunded_at`) |
| `CREDIT_NOTED` / `REJECTED` | valid enum members, settable through the same PATCH with no timestamp and no special handling |
| `CANCELLED` | the status PATCH, atomic branch. FINAL — see above |

> **TWO GAPS, reported 2026-08-16, NOT fixed.** Both are the shape this repo has
> already paid for once on the Sales Invoice.
>
> 1. **No status whitelist.** `patchDeliveryReturnStatusHandler` builds
>    `{ updated_at, status: body.status }` and writes it verbatim — no canonical
>    map, no legal-transition table, case-sensitive. A lowercase `'cancelled'`
>    slips past the `body.status === 'CANCELLED'` reversal gate and is stopped
>    only by the Postgres enum. This is precisely the bug that was fixed for SI
>    (`canonicalSiStatus`, which runs before any branch) and for the DO
>    (uppercase-normalise + `DO_STATUSES` check) and never here. The same hole is
>    open on `consignment-notes.ts` and `consignment-returns.ts`.
> 2. **No line-level status lock.** `POST /:id/items`, `PATCH /:id/items/:itemId`
>    and `DELETE` have no equivalent of `purchase-returns.ts`'s `prLineLock` or
>    `consignment-returns.ts`'s `returnLineLock`, so a CANCELLED or REFUNDED
>    return's lines are still editable. Both siblings have one.
>
> Note also that this module's cancel-final refusal puts its sentence in
> `reason`, while the DO / CN / PC siblings use `message` — a surface reading the
> body raw will show a blank for one of them.

---

## 8. Traps, collected

- **`do_item_id` is nullable in the DDL, but no write path will produce a NULL
  one** — `do_link_required` refuses it on create and on add-item. The column
  stays nullable for legacy / migrated rows; the guards are what keep it from
  being a bypass.
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

## Right-click Print, for the whole chain (owner ruling, 2026-08-22)

**The list's right-click Print prints the chain (2026-08-23).** A DR row offers
`Print`, `Print Sales Order <no>` and `Print Delivery Order <no>` in place — the
row already carries `so_doc_no` and `delivery_order_id` + `do_doc_no`, so no
payload change was required. The list's batch export now reads its bundle from
`lib/printDocumentPdf.ts`'s `deliveryReturnPdfBundle`, the one home for the
DR-record → DR-generator mapping. `document-conversion.md` §8b has the rule.

## Drill-down columns and "still loading"

A cell fed by a SECOND query renders **WORKING…** while that query is in flight
and **NOT LOADED** if it fails — never `STOCK` or a bare dash, which are
answers. `coverage` is a required prop on the shared drill-down; the rule, the
five surfaces that fetch separately, and how to add a sixth are in
`docs/modules/coverage-state.md` (trace: `docs/bugs/0603-a-drill-down-printed-stock-while-the-answer-was-still-loadin.md`).
