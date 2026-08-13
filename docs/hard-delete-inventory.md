# Hard-delete inventory — every `DELETE` on the SCM route surface, classified

**The rule this exists to enforce, in the owner's words: 不可以删只可以 cancel.**
Nothing is ever deleted, only cancelled. A cancelled document stays in the
database, leaves the working lists, and can still be reconciled against
AutoCount and audited. A deleted one cannot be reasoned about at all.

Written 2026-08-11, after the rule was broken three times and found three
separate times, one endpoint at a time:

| found | endpoint | fixed in |
|---|---|---|
| 2026-08-11 | `DELETE /mfg-purchase-orders/:id` | #1939 |
| 2026-08-11 | `DELETE /purchase-consignment-orders/:id` | this PR |
| 2026-08-11 | `DELETE /quotes/:id` | this PR |

Three ad-hoc discoveries mean nobody had looked systematically. This file is
that systematic look, so there is no fourth.

**Read this before adding any `DELETE` handler**, and add a row to it in the
same PR if you do.

There is already a mechanism that will make you notice: `npm --prefix backend
run audit:routes` fails on route drift, so a new `DELETE` route cannot merge
without someone regenerating `docs/generated/route-capability-matrix.csv` — the
same check that flagged #1939's removal. This file is what that person should
read when it fires.

---

## 1. How to read the classification

Not every `DELETE` is a violation. The rule is about **documents** — records of
something the business committed to. Three other things also use the DELETE
verb and are legitimate:

| class | meaning | verdict |
|---|---|---|
| **VIOLATION** | a business document is purged from the database | must be removed |
| **COMPLIANT** | either a soft delete, or a draft-equivalent discard, or not a document at all (master data, config, a child line, an asset) | leave alone |
| **ROLLBACK-KEEP** | a compensating `.delete()` inside a multi-step create, undoing a document that never successfully existed | **leave alone — removing these is a regression** |

**On ROLLBACK-KEEP, specifically.** supabase-js has no transaction. A create
that inserts a header and then its lines has no way to make the pair atomic, so
every such path deletes the header when the line insert fails. Without it a
failed create leaves a **headerless orphan document** in the table forever.
These deletes remove a document that never successfully existed; a violation
removes one that did. Do not "tidy" them.

**On draft-equivalents.** Discarding a DRAFT that was never confirmed is not
deleting a business record — nothing was committed to. `DELETE
/mfg-sales-orders/:docNo` is the canonical shape: DRAFT-only, refusing anything
else with `so_not_draft` — *"A confirmed order must be cancelled, not deleted."*
That is the rule being honoured, not broken.

---

## 2. Document-level deletes — the class the rule governs

This is the table that matters. Everything else on the SCM surface is in §3.

| endpoint | module | guard | reaches AutoCount | class |
|---|---|---|---|---|
| ~~`DELETE /mfg-purchase-orders/:id`~~ | Purchase Order | CANCELLED-only | yes (`PO`) | **REMOVED #1939** |
| ~~`DELETE /purchase-consignment-orders/:id`~~ | PC Order | CANCELLED-only | no | **REMOVED — this PR** |
| ~~`DELETE /quotes/:id`~~ | Quote | **none at all** | no | **REMOVED — this PR**, replaced by `PATCH /quotes/:id/cancel` |
| `DELETE /mfg-sales-orders/:docNo` | Sales Order | DRAFT-only, `so_not_draft` | yes (`SO`) | COMPLIANT — draft discard |
| `DELETE /stock-takes/:id` | Stock Take | OPEN-only (`not_open`) + assignee check + audit row | no | COMPLIANT — draft-equivalent |
| `DELETE /trips/:id` (default) | TMS Trip | soft cancel → `CANCELLED` | no | COMPLIANT |
| `DELETE /trips/:id?hard=true` | TMS Trip | **none** | no | **VIOLATION — open, see §5** |

`reaches AutoCount` is decided by mig 0277: `scm.autocount_outbox.doc_type` is
pinned to `SO`, `PO`, `DO`, `IV`, `GR`, `PI`. Nothing else in the ERP syncs
today. A purged document of one of those six types cannot be reconciled against
the AutoCount copy, which is what made the PO delete the worst of the three.

**Stock Take is the boundary case worth understanding.** `OPEN` is a stock
take's draft: no movements have been posted, so nothing has happened to
inventory yet. The handler additionally refuses a non-assignee and writes an
`entityType: 'STOCK_TAKE', action: 'DELETE'` audit row before the purge. It has
the same shape as the SO draft discard and is left alone on the same reasoning.
If stock takes ever gain a pre-OPEN state, revisit this row.

---

## 3. Everything else on the SCM route surface

All 70 `DELETE` handlers in `backend/src/scm/routes/` are accounted for.
§2 covers 7 of them; the remaining 63 fall into four classes, none of which the
rule governs.

### 3a. Child-line and payment deletes — document EDITING, not document deletion

Removing a line from a document is how a document is edited. These are governed
by the **Tier 2 downstream-lock** pattern (`...HasDownstream`) — a line cannot be
removed once a downstream document consumes it — and, on the money paths, by
status guards.

> **Corrected 2026-08-13.** Until `sweep/swallowed-error`, the "downstream-lock"
> guard in this column was weaker than the table claims: every implementation
> (`scm/lib/downstream-lock.ts` and the four route-local clones —
> `pcoHasDownstream`, `coHasDownstream`, `pcReceiveHasDownstream`,
> `noteHasDownstream`) destructured `count` / `data` without `error`, so a read
> that FAILED folded to "no downstream document" and the line delete went
> through. The guard is now fail-closed: an unreadable count returns
> `downstream_check_failed` and the call site 409s as it always did for a real
> lock. See BUG-HISTORY.md, "A guard that says all clear because it could not
> look".

| file | endpoint | guard |
|---|---|---|
| `mfg-sales-orders.ts:8404` | `/:docNo/items/:itemId` | `so_total_below_original` |
| `mfg-sales-orders.ts:10922` | `/:docNo/payments/:id` | payment/doc match + CAS version |
| `mfg-purchase-orders.ts:3145` | `/:id/items/:itemId` | downstream-lock (GRN exists) |
| `mfg-purchase-orders.ts:3416` | `/:id/items/:itemId/allocations/:allocationId` | allocation must exist |
| `grns.ts:3250` | `/:id/items/:itemId` | `grn_locked` |
| `delivery-orders-mfg.ts:4853` | `/:id/items/:itemId` | `line_has_downstream_consumption` |
| `delivery-orders-mfg.ts:5003` | `/:id/payments/:paymentId` | status guard, `do_cancelled_final` |
| `sales-invoices.ts:1820` | `/:id/items/:itemId` | `invoice_cancelled` / `invoice_issued` |
| `sales-invoices.ts:2038` | `/:id/payments/:paymentId` | `not_payable`, status guard |
| `purchase-invoices.ts:2236` | `/:id/items/:itemId` | not-found guard |
| `purchase-returns.ts:1339` | `/:id/items/:itemId` | downstream-lock |
| `delivery-returns.ts:1488` | `/:id/items/:itemId` | `dr_cancelled_final`, status guard |
| `consignment-orders.ts:1871` | `/:docNo/items/:itemId` | downstream-lock |
| `consignment-orders.ts:2275` | `/:docNo/payments/:id` | payment/doc match |
| `consignment-notes.ts:917` | `/:id/items/:itemId` | downstream-lock |
| `consignment-notes.ts:1007` | `/:id/payments/:paymentId` | `note_cancelled_final`, status guard |
| `consignment-returns.ts:885` | `/:id/items/:itemId` | `return_cancelled_final`, status guard |
| `purchase-consignment-orders.ts:555` | `/:id/items/:itemId` | downstream-lock |
| `purchase-consignment-receives.ts:1226` | `/:id/items/:itemId` | downstream-lock |
| `purchase-consignment-returns.ts:1037` | `/:id/items/:itemId` | downstream-lock |
| `trips.ts:671` | `/:id/stops/:stopId` | stop reconciled back to the board |
| `fleet-maintenance.ts:1817` | `/work-orders/:woId/parts/:partId` | part must exist |
| `suppliers.ts:825` | `/:id/bindings/:bindingId` | — |

All **COMPLIANT**. Note the class boundary: emptying a document of its lines is
not the same as deleting the document, and every one of these leaves the header
— and its doc number — in place.

### 3b. Soft deletes — already the rule, implemented

| file | endpoint | mechanism |
|---|---|---|
| `sofa-combos.ts:730` | `/:id` | sets `deleted_at` |
| `sofa-quick-picks.ts:167` | `/:id` | sets `deleted_at` |
| `personal-quick-picks.ts:171` | `/:id` | sets `deleted_at` |
| `venues.ts:266` | `/:id` | sets `active = 0` |

All **COMPLIANT**, and the pattern to copy.

### 3c. Master data and configuration

Not documents. Most carry an in-use lock, which is the correct guard for this
class — a row still referenced by a document cannot be removed.

| file | endpoint | in-use lock |
|---|---|---|
| `mfg-products.ts:480` | `/:id` | `sku_in_use` — **not even by `?force=true`** |
| `product-models.ts:997` | `/:id` | `model_in_use` |
| `categories.ts:387` | `/:id` | `category_in_use` |
| `addons.ts:201` | `/:id` | `in_use` |
| `inventory.ts:284` | `/warehouses/:id` | `in_use` |
| `warehouse.ts:299` | `/racks/:id` | `rack_not_empty` |
| `fabric-tracking.ts:244` | `/:id` | `fabric_in_use` |
| `delivery-planning-regions.ts:170` | `/:id` | `region_in_use` |
| `so-dropdown-options.ts:279` | `/:id` | `payment_method_locked` |
| `threepl-companies.ts:293` | `/:id` | detaches the fleet, never deletes it |
| `delivery-rate-cards.ts:312`, `:415` | `/:id`, `/:id/rules/:ruleId` | — |
| `delivery-residence-rules.ts:203` | `/:id` | — |
| `delivery-zones.ts:218`, `:764` | `/:id`, `/locks/:id` | — |
| `delivery-fees.ts:211` | `/special/:id` | — |
| `fabric-tier-addon.ts:163`, `:237` | `/special/:modelId`, `/compartment-special/:compartmentId` | — |
| `free-item-campaigns.ts:104` | `/:id` | — |
| `model-free-gifts.ts:94` | `/:modelId` | — |
| `pwp-rules.ts:220` | `/:id` | — |
| `pwp-codes.ts:383` | `/reserve` | releases a held code (a lock, not a record) |
| `special-addons.ts:215` | `/:id` | — |
| `state-warehouse-mappings.ts:84` | `/:state` | — |
| `localities.ts:225` | `/:id` | — |
| `hr.ts:437`, `:550`, `:702` | profiles / item-kpi / override-levels | — |
| `driver-leave.ts:134` | `/:id` | — |
| `lorry-service-records.ts:199` | `/:id` | — |
| `maintenance-config.ts:346` | `/changes/:id` | — |

All **COMPLIANT** against the document rule. Several have no in-use lock, which
is a *separate* question (orphaned references) and not what this file tracks.

### 3d. Asset deletes — R2 objects and photo keys

| file | endpoint |
|---|---|
| `categories.ts:83` | `/:id/hero-image` |
| `product-models.ts:1133`, `:1346` | `/:id/photo`, `/:id/photos/:photoId` |
| `sofa-compartment-photos.ts:257` | `/:code/photo` |
| `mfg-sales-orders.ts:10288` | `/:docNo/items/:itemId/photos/:photoKey` |
| `consignment-orders.ts:2118` | `/:docNo/items/:itemId/photos/:photoKey` |
| `fleet-maintenance.ts:1197` | `/compliance-attachments/:attId` |

All **COMPLIANT** — an image is not a business record.

---

## 4. ROLLBACK-KEEP — the create-time compensating deletes

These are **not endpoints**. They are `.delete()` calls inside a create path,
firing only when a line insert fails. Every one of them is load-bearing. Full
list, so nobody has to re-derive it:

| file:line | header table it rolls back |
|---|---|
| `mfg-purchase-orders.ts:1351`, `:2372` | `purchase_orders` (named in #1939) |
| `mfg-sales-orders.ts:5356` | `mfg_sales_orders` (also rolls back PWP claims) |
| `purchase-consignment-orders.ts:371` | `purchase_consignment_orders` |
| `purchase-consignment-receives.ts:778`, `:787`, `:895`, `:901` | `purchase_consignment_receives` |
| `purchase-consignment-returns.ts:520`, `:625`, `:710` | `purchase_consignment_returns` |
| `purchase-invoices.ts:1079`, `:1088`, `:1654`, `:1664`, `:1822`, `:1831` | `purchase_invoices` |
| `purchase-returns.ts:676`, `:819`, `:931` | `purchase_returns` |
| `sales-invoices.ts:1038`, `:1060`, `:1300`, `:1317` | `sales_invoices` |
| `delivery-orders-mfg.ts:3409`, `:3431`, `:3943`, `:3961` | `delivery_orders` |
| `delivery-returns.ts:1031`, `:1056`, `:1260`, `:1276` | `delivery_returns` |
| `grns.ts:1712`, `:1725`, `:1923`, `:1932`, `:2276`, `:2288` | `grns` |
| `consignment-notes.ts:748` | `consignment_delivery_orders` |
| `consignment-orders.ts:1004` | `consignment_sales_orders` |
| `consignment-returns.ts:720` | `consignment_delivery_returns` |
| `payment-vouchers.ts:308`, `:315` | `payment_vouchers` |
| `payment-vouchers.ts:553`, `:1038` | `journal_entries` (posting + reversal) |
| `stock-takes.ts:419` | `stock_takes` |
| `accounting.ts:172`, `:401`, `:571` | `journal_entries` |

Line numbers drift. Re-derive with:

```
grep -rn "\.from('\([a-z_]*\)')\s*\.delete()" backend/src/scm/routes/
```

and read the `if (…Err) {` above each one — a rollback is always inside a
failure branch.

---

## 5. Open, deliberately not removed

### `DELETE /trips/:id?hard=true` — TMS Trip

`backend/src/scm/routes/trips.ts:704`. The endpoint's DEFAULT behaviour is a
soft cancel (`status → CANCELLED`), which is correct. The `?hard=true` query
flag takes a second branch that hard-deletes the trip row, with **no status
guard of any kind**, cascading `trip_stops` away with it
(`trip_stops.trip_id ON DELETE CASCADE`, mig 0053).

Why it is a real violation:

- no guard at all — any trip, in any state, by id
- it is the same shape as the three already removed

Why it was not removed in this PR:

- **no caller uses it.** `?hard=true` appears nowhere in `frontend/src`. The
  flag is reachable only by hand-crafting the request.
- a trip never reaches AutoCount and carries no money — it is a logistics
  planning record, so the blast radius is a lost route plan, not a lost
  commitment.
- it is a **different module with its own guide**, and
  `docs/modules/delivery-tms.md:860` documents the flag explicitly. Removing it
  means changing the TMS surface and its guide. #1939 set the precedent of
  flagging a sibling module rather than smuggling it into another module's PR,
  and this follows it.

**Recommended fix**, when someone picks it up: delete the `if (hard)` branch and
the `hard` query read, keep the soft-cancel path and its `reconcileStopsToBoard`
call, and update `docs/modules/delivery-tms.md:860` plus the endpoint's header
comment. It is roughly a six-line change.

---

## 6. Scope boundary — what this sweep did NOT cover

This file covers `backend/src/scm/routes/` only. The **non-SCM routers** in
`backend/src/routes/` were not classified. Most of their 37 `DELETE` handlers
are plainly master data (departments, positions, roles, brands, venues,
event-types, organizers, labels, push devices, table layouts, UDF keys, logos,
profile pictures, invitations), but these are record-shaped and deserve the same
treatment by someone who knows PMS and HR:

| file:line | endpoint |
|---|---|
| `routes/projects.ts:3061` | `/finance/lines/:lineId` — a PMS P&L line |
| `routes/projects.ts:4522` | `/sales-reports/:reportId` — a roadshow sales report |
| `routes/projects.ts:3625` | `/stock-transfers/:tid` |
| `routes/projects.ts:4464` | `/defects/:defectId` |
| `routes/sales.ts:1111` | `/entries/:id` — a sales entry |
| `routes/assr.ts:3050` | `/:id/items/:itemId` — service case items |
| `routes/users.ts:1822` | `/:id` — deletes a user |

Not a claim that any of these is wrong. A claim that nobody has checked.

---

## See also

- `BUG-HISTORY.md` 2026-08-11 — both entries, the PO one and this one
- `docs/modules/purchase-consignment-order.md` — the PC Order guide
- `docs/modules/quote.md` — the Quote guide, and why cancel had to be built
- `docs/modules/purchase-order.md` — #1939's module, updated there
- `docs/modules/sales-order.md` — the draft-discard shape worth copying
