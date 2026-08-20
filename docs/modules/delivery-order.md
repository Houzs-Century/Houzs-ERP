# Module: Delivery Order (SCM)

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. Sibling of `sales-order.md`; the DO is a
faithful clone of the SO API (editable SO-style header, line CRUD, payments
ledger, `recomputeTotals`) with one thing the SO does not have: **it moves stock**.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.
>
> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Doc-flow position: **SO → DO → SI**, with **DO → DR** (Delivery Return) as the
reversal branch. The DO is the OUT half of the inventory ledger.

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx` | Server-paginated, `pageSize = 50` (`:834`), page in `?page=`. Sends the **bucket name** as `status` (`:854`). Revenue card is page-only; In-transit / Delivered cards read full-set `statusCounts` (`:878-880`). |
| Desktop detail | `frontend/src/pages/scm-v2/DeliveryOrderDetailV2.tsx` | Header + lines + payments + crew. |
| Desktop new | `frontend/src/pages/scm-v2/DeliveryOrderNewV2.tsx` | |
| Desktop from-SO | `frontend/src/pages/scm-v2/DeliveryOrderFromSo.tsx` | Line-level picker over `/deliverable-so-lines`. |
| Desktop report | `frontend/src/pages/scm-v2/DeliveryOrderDetailListing.tsx` | Detail-listing report. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | `MODULE_CONFIGS["delivery-orders-mfg"]` (`:1064-1106`). |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Config `:241`; status actions `:480-494`. |
| Mobile POD | `frontend/src/mobile/MobilePOD.tsx` | The driver screen — signature + photo + `PATCH /:id/status`. `signatureData` is sent **only when the customer actually drew** (gated on `hasSignature`, which the pad sets on the first pointerdown). It used to be gated on `canvas.toDataURL()`, which returns a valid non-empty PNG for an untouched transparent canvas — so every delivery stored a blank signature into `delivery_orders.signature_data`, indistinguishable from a real POD that failed to render. `podKey` and the GPS fields in the same payload were already gated on real capture. |
| Mobile convert (SO→DO) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "do"` (`:72`). |
| Mobile planning board | `frontend/src/mobile/MobileDeliveryPlanning.tsx` | |

Desktop routes: `frontend/src/App.tsx:654-657`, behind
`<ScmGuard area="scm.sales.delivery" allowSales>` for list + detail (read), and
without `allowSales` for new / from-so.

### Data hooks
`frontend/src/vendor/scm/lib/delivery-order-queries.ts`

- `useMfgDeliveryOrdersPaged({page,pageSize,status,q,sort})` (`:215`) — the desktop
  list. `queryKey: ['mfg-delivery-orders-paged', ...]`, `placeholderData: prev`,
  `staleTime: 30_000`.
- `useMfgDeliveryOrders(status?)` (`:198`) — legacy unpaginated,
  `['mfg-delivery-orders', status ?? 'all']`.
- `useMfgDeliveryOrderDetail(id)` (`:233`) — `['mfg-delivery-order-detail', id]`.
- `useDeliveryOrderPayments(id)` (`:370`) — `['mfg-delivery-orders', id, 'payments']`,
  `staleTime: 2 * 60_000` (longer than the rest).
- `useDeliverableSoLines*` (`:54`, `:116`) and `useSoConvertHeader` (`:101`) feed
  the SO→DO pickers.
- `useCreateMfgDeliveryOrder` (`:249`) takes an **optional `idempotencyKey`**,
  destructured out of the body so it is not posted as a DO field. The comment at
  `:239-248` says why it matters: a duplicate DO is not a duplicate row, it
  decrements stock again and carries into SI.

**`releaseSoSideQueries`** (`:190-196`) is the DO module's most important cache
rule: any mutation that moves an SO line's live remaining-to-deliver (create,
line qty change, line delete, cancel) must invalidate the SO lists, the SO
detail, and force-refetch `['mfg-delivery-orders','deliverable-so-lines']` —
otherwise a released qty looks stuck and the Issue-DO menu stays hidden until a
hard refresh.

`useUpdateMfgDeliveryOrderStatus` (`:264`) additionally invalidates
`['inventory']` (`:276`), because a shipped transition deducts stock.

### Caching / loading behaviour
Three layers as in `docs/modules/sales-order.md` §1. DO specifics:

- The **legacy** key `mfg-delivery-orders` is whitelisted for the localStorage
  snapshot (`frontend/src/lib/query-persist.ts:95`); the **paged** key is not
  (different first segment).
- The payments sub-key `['mfg-delivery-orders', <id>, 'payments']` is explicitly
  excluded from persistence (`query-persist.ts:100-133`). The comment there is a
  bug post-mortem worth reading before touching that file: a persisted payment
  ledger was rehydrated as fresh data and MobilePOD turned it into the balance a
  driver collects.

---

## 2. API surface

`backend/src/scm/routes/delivery-orders-mfg.ts`, mounted at
`/api/scm/delivery-orders-mfg` (`backend/src/scm/index.ts:257`) behind
`scmAreaGuard('scm.sales.delivery', { readInheritsFrom: 'scm.sales.orders' })`
(`:256`) — a salesperson may READ the DOs generated from their own SOs; writes
still need `edit` on `scm.sales.delivery`.

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/` | `:2188` | List. `?page=` opts into pagination + `statusCounts`. |
| GET | `/deliverable-so-lines` | `:2347` | SO lines with `remaining > 0` (qty − delivered + returned). |
| GET | `/so-source/:docNo` | `:2425` | SO header fields for the convert form. |
| GET | `/:id` | `:2451` | Header + items + `has_children` + `lifecycle_state` + crew. |
| POST | `/` | `:2591` | Create. `asDraft: true` → DRAFT (no stock); else born DISPATCHED. |
| POST | `/from-sos` | `:2976` | Line-level batch convert from SO picks. |
| PUT | `/:id/crew` | `:3314` | Driver / helper / lorry assignment + snapshot. |
| PATCH | `/:id` | `:3450` | Header edit (+ SO amend-field mirror). |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | `:3636` / `:3784` / `:4005` | Line CRUD. |
| GET/POST/DELETE | `/:id/payments[/:paymentId]` | `:4075` / `:4118` / `:4155` | Payments ledger. |
| PATCH | `/:id/status` | `:4359` (handler `:4166`) | **The stock chokepoint.** |

---

## 3. Backend

### The list handler — `deliveryOrdersMfg.get('/')` (`:2188-2336`)

1. **Row scope first** (`:2194-2201`). `canViewAllSales(c)` (permission
   `scm.so.view_all` or a director position) else `resolveSalesScopeIds` gives the
   caller's own + downline scm.staff uuids, applied as `.in('salesperson_id', ...)`.
   Pass the **Houzs** user id (`c.get('houzsUser')?.id`), not `user.id` — the
   comment at `:2191` records that this was the non-admin 500. No Houzs identity
   and no view-all ⇒ an explicit 403 with a readable message (`:2199`), never a
   silent empty list.
2. **Two paths, chosen by `page`** (`:2210-2211`).
   - Legacy (`:2220-2228`): `order do_date desc`, `.limit(500)`, `scopeToCompany`,
     raw `status` equality.
   - Paginated (`:2229-2296`): sort whitelist
     `do_date | do_number | debtor_name | status | customer_delivery_date` (`:2235`)
     + `do_number` tiebreaker; bucket resolution via `DO_STATUS_BUCKETS` (`:2180-2185`);
     `q` ilikes over `do_number, so_doc_no, debtor_name, debtor_code, ref,
     branding, sales_location, driver_name` plus normalized phone parts (`:2259-2264`);
     `from`/`to` on `do_date`.
   - `statusCounts` = five `head:true count:'exact'` in one `Promise.all` (`:2283-2289`),
     company- and scope-filtered so tab counts cannot leak the other company's totals.
3. **Enrichment — one parallel wave of THREE reads** (`:2309-2313`):
   non-cancelled `delivery_returns` by `delivery_order_id`, non-cancelled
   `sales_invoices` by `delivery_order_id`, and `computeDoLifecycle` (`:1999`).
   The first two collapse into `has_children`; the third gives
   `lifecycle_state` (`'shipped' | 'invoiced' | 'returned'`, `:1998`).
   A fourth, sequential batched read then pulls
   `mfg_sales_orders.processing_date` for the distinct `so_doc_no` set and
   stamps it on each row as **`so_processing_date`** — the linked SO's
   "Processing date" shown in the DO quick-view drawer (desktop
   `MfgDeliveryOrdersListV2` + mobile `MobileModuleList`).
   **This is a DERIVED response field, and both ends read it as a string** —
   mobile via `pick(r, "soProcessingDate", "so_processing_date")`
   (`MobileModuleList.tsx:1147,1198`; corrected 2026-08-14 — this line named
   `soInternalExpectedDd` / `so_internal_expected_dd`, retired by mig 0286). If
   the SO column is ever renamed, rename this response key on BOTH ends or
   neither: a backend-only rename blanks the "Processing" column with no error
   anywhere. See docs/modules/sales-order.md, "surfaces that read this date by
   NAME".
   The list also stamps **`source_pos`** per row via the ONE shared resolver
   (`scm/lib/source-po-trace.ts`, batched, one ledger pass): a DO is a sales-side
   doc, so its list + drill-down show the durable **Source PO** (`batch_no` =
   source PO on the OUT movements ∪ consumed FIFO lots, GRN-healed for NULL-batch
   lots), NOT an Assigned SO. Since 2026-08-01 each row/line also carries
   **`source_adj`** — shipped from a PO-less stock ADJUSTMENT lot, rendered as a
   "STOCK ADJ" chip (never a blank), on desktop AND the mobile detail
   (`MobileModuleDetail` line rows). **Since 2026-08-02 the header cell is
   `resolveDoHeaderSources` — the UNION of the DO's OWN physical lines' traces
   (services excluded, bound-PO fallback included), NEVER the raw `byDo` ledger
   rollup**: the old rollup surfaced orphan ledger buckets (re-pointed
   consumptions / drifted variant keys) as phantom chips no drill line could
   explain (`2990-DO-2607-017` showed a fourth PO its three items did not
   resolve). Header ≡ ∪(lines) is structural now; orphan buckets stay visible
   to `check-so-source-trace.mjs` section 6 only. The list column labelled
   "From SO" is the document-flow anchor; "Source PO" is the procurement trail.
   See `docs/modules/document-traceability.md` §2.5 + §2.8 + §2.9 (owner
   2026-07-31 / 2026-08-01 / 2026-08-02).
4. **Finance gate** (`:2322-2333`) — `canViewScmFinance(c)`; when false every
   `DO_FINANCE_KEYS` column (`:317-321`) is deleted from every row. Note
   `local_total_sen` is deliberately NOT in that list: the DO total is visible
   to everyone, cost and margin are not.

### Main mutation paths

- **Create** (`:2591`). Guards in order: item-code catalog check (`:2600-2604`), then
  the source-SO gate — every SO referenced by `soDocNo` or by any line's
  `soItemId` must be past `SO_UNDELIVERABLE_STATUSES` (`firstUndeliverableSo`,
  `:2146`). `asDraft === true` → `status: 'DRAFT'`, otherwise the DO is born
  **DISPATCHED** (`:2785`) and stock is deducted immediately (`:2842-2855`). The
  create path also fires `syncSoDeliveredFromDo` and the customer DO email.
- **`/from-sos`** (`:2976`). Same shape, `asDraft` respected at `:3185` / `:3283`.
- **Header PATCH** (`:3450`). Locked once a DR/SI exists (`:3544`). Strips the
  three amend fields out of the DO update and mirrors them onto the parent SO
  instead, writing a separate audit row on the **SO's** timeline
  (`prepareSoAmendMirrorAudit`, `:221-260`). `delivery_substatus` is whitelisted
  against `HC_SUBSTATUS_VALUES` (`:209-212`).
- **Line add** (`:3636`). Item-code guard, then `doHasDownstream`. If the DO is
  already shipped, the new line ships immediately via resync, so a stock
  availability check runs first unless the caller passes `confirmShortStock`
  (`:3658-3670`).
- **Line delete** (`:4005`). Deliberately **not** gated by the doc-level lock — it
  uses the per-line `doLineConsumedQty` (`:1468`) instead, so deleting a
  non-consumed line on a shipped DO is allowed and re-syncs inventory.
- **Status PATCH** (`patchDeliveryOrderStatusHandler`, `:4166`) — see §5 and §6.

---

## 4. Database

Schema `scm`. Baseline DDL `backend/scripts/scm-schema/2990s-full-schema.sql:176`
(`delivery_orders`) and `:148` (`delivery_order_items`); the authoritative in-code
column lists are `HEADER` (`delivery-orders-mfg.ts:292-310`), `ITEM` (`:333-337`),
`PAYMENT_COLS` (`:339-342`) and `crewSnapshotCols` (`:347-351`).

| Table | Role |
|-------|------|
| `scm.delivery_orders` | DO header. `do_number`, `so_doc_no`, `debtor_code/name`, `do_date`, `expected_delivery_at`, `customer_delivery_date`, `dispatched_at` / `signed_at` / `delivered_at`, `driver_id/name`, `vehicle`, `m3_total_milli`, address block, `salesperson_id`, `branding`, `venue_id`, per-category revenue + cost subtotals, `local_total_sen`, `total_cost_sen`, `total_margin_sen`, `line_count`, `warehouse_id`, `is_dropship`, `arrives_em_warehouse_date`, `pod_r2_key`, `signature_data`, `status`, `company_id`. |
| `scm.delivery_order_items` | DO lines. `so_item_id` (the SO link that drives warehouse resolution + remaining-qty caps), `item_code`, `item_group`, `qty`, `m3_milli`, `unit_price_sen`, `discount_sen`, `line_total_sen`, `unit_cost_sen`, `line_cost_sen`, `line_margin_sen`, **`ship_cost_sen`**, `variants`, `line_delivery_date`, `line_delivery_date_overridden`, `rack_id`, **`committed_po_batch_no`** (mig 0230 — the incoming PO this line shipped against before its goods arrived; the per-line claim signal the receipt reconcile reads). |
| `scm.delivery_order_payments` | Payments taken at delivery. `method`, `merchant_provider`, `installment_months`, `online_type`, `approval_code`, `amount_sen`, `account_sheet`, `collected_by`. |
| `scm.delivery_order_crew` | One row per DO (UNIQUE `do_id`): driver/helper/lorry FKs plus the assign-time name/IC/contact/plate snapshot. |
| `scm.inventory_movements` | Where the OUT lands. Keyed `(source_doc_type='DO', source_doc_id, item_code, variant_key, COALESCE(correction_seq,0))` by `uq_inv_mov_do_source_v2` (migration 0279; before that, `uq_inv_mov_do_source` without the correction slot), the partial unique index the reversal has to route around (`:4322-4328`). Full definition in §on idempotency below. |
| `scm.mfg_sales_order_items` | Upstream: `warehouse_id` is the **authoritative** ship-from warehouse per line. |

**Status vocabulary — read `backend/src/scm/shared/do-shipped-states.ts`, not
this paragraph.** Since 2026-08-13 that file is the single declaration of
`DO_SHIPPED_STATES`, `DO_STOCK_OUT_STATES`, `DO_PRESHIP_STATES` and
`DO_STATUSES`; `delivery-orders-mfg.ts` (`:402`, `:411`, `:413`, `:419`),
`consignment-notes.ts`, `lib/reconcile-ledger.ts`,
`services/agents/delivery-agent.ts` and seven audit scripts all read it through
`scripts/lib/do-shipped-states.mjs` or the TS module. This doc used to spell the
sets out here, which made it one more copy of a list that already stood in
eleven files — and copies of this particular list had already drifted: the
delivery agent's was missing `COMPLETED`, so its DO pipeline silently omitted
that bucket.

The shape, so the section still says something: `DO_SHIPPED_STATES` is the
**write trigger** (first entry fires the OUT — `COMPLETED` is deliberately
excluded, nothing ships *into* completion); `DO_STOCK_OUT_STATES` is the
**read predicate** ("has this stock already gone out?") and is
`DO_SHIPPED_STATES ∪ {COMPLETED}`. `tests/doShippedStatesMirror.test.ts` pins
that relationship and the .mjs mirror.

Filter buckets (`DO_STATUS_BUCKETS`): `open` = DRAFT+LOADED, `in_transit` =
DISPATCHED+IN_TRANSIT, `delivered` = SIGNED+DELIVERED+INVOICED, `cancelled` =
CANCELLED. Every member of `do_status` is in exactly one bucket, and no bucket
holds a non-member — pinned by `backend/tests/statusBucketsEnumMembership.test.mjs`.

> **FIXED 2026-08-17.** `delivered` carried `COMPLETED`, which is not an enum
> member, so `?status=delivered` answered **500 `invalid input value for enum
> do_status: "COMPLETED"`** and — worse — the delivered COUNT failed on the same
> label and was being served as **0**. Measured in production that day: company 1
> `all:27 open:0 in_transit:2 delivered:0 cancelled:0` (25 DOs in no tab),
> company 2 `all:36 in_transit:23 delivered:0 cancelled:1` (12 in no tab). A
> failed count now returns `500 status_counts_failed` instead of a zero.

### Who moves the DO status, and what each value blocks (2026-08-16)

DB type is the `scm.do_status` ENUM (base body in
`backend/scripts/scm-schema/2990s-full-schema.sql`; `DRAFT` added by
`migrations-pg/0040_scm_do_status_draft.sql`). Column default is `LOADED`.
**Every DO status move is MANUAL** — unlike PO and SI, nothing derives a DO
status from a child document.

| Value | Set by | What it does / blocks |
|---|---|---|
| `DRAFT` | create with `asDraft: true` | Not shipped. A DRAFT DO does NOT count as delivered anywhere — `so-stock-allocation.ts`, `soDeliverableRemaining` and MRP all exclude it (leak guard, audit D5). |
| `LOADED` | `PATCH /:id/status` ("Mark loaded") | pre-ship |
| `DISPATCHED` | create not-draft, or `PATCH /:id/status` | **The DRAFT-confirm hop, and the only status that emails the customer.** First entry into any shipped state fires the inventory OUT. |
| `IN_TRANSIT`, `SIGNED`, `DELIVERED`, `INVOICED` | `PATCH /:id/status`; mobile POD | shipped states; stock has already left |
| `COMPLETED` | **nothing writes it.** Still in the code vocabulary (`DO_STOCK_OUT_STATES`, `DO_STATUSES`) but NOT a member of the `do_status` enum in any schema file or migration. Removed from the `delivered` filter bucket 2026-08-17. **CORRECTED 2026-08-18** — this cell used to end "the JS-side sets compare a status already in hand, where a value that can never occur is inert", and that was FALSE: `services/agents/delivery-agent.ts` mapped `DO_STATUSES` into one `.eq('status', st)` query per entry, so `COMPLETED` *was* being handed to Postgres to parse. That consumer no longer enumerates the list at all (it counts the rows it reads), so the claim is now true of every remaining reader — but it was a second live 22P02 for a day, and it was found by a reviewer, not by the sweep that wrote the sentence | read-only |
| `CANCELLED` | `PATCH /:id/status`, atomic branch | **FINAL.** `A cancelled Delivery Order cannot be reactivated — its stock was already returned. Create a new DO to deliver again.` (409 `do_cancelled_final`) |

Refusals the operator sees, in the order they fire:

| Guard | Message |
|---|---|
| unknown target (input upper-cased first) | `"<x>" is not a valid Delivery Order status.` (400 `invalid_status`) |
| shipped → pre-ship | `This Delivery Order has already shipped, so it cannot be moved back to a not-shipped status. Cancel it and create a new Delivery Order instead.` (409) |
| over-delivery re-check on first ship (linked AND unlinked lines — PR #2522) | `This delivery would ship more than the Sales Order ordered — another DO already covers it. Refresh and check the Sales Order.` (409 `over_delivery`) |
| downstream lock (cancel, header PATCH, line add/edit) | `DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit` (409) |
| line shrink below consumption | `Cannot reduce qty to <n> — <m> unit(s) have already been invoiced or returned for this line. Cancel the related Invoice / Delivery Return first.` |
| source-SO gate | `so_not_deliverable` — the SO `is still a draft / has been cancelled / is on hold` |

`delivery_substatus` is a SEPARATE column with its own whitelist (Pending
Pickup, Done Shipout, Arrives EM Warehouse, Done Delivered, Confirm, House Not
Ready, Request Hold) — refusal: `delivery_substatus must be one of: … (or
blank).` It is not part of the lifecycle above.

> **BUG (partially fixed 2026-08-17): `COMPLETED` is in the code vocabulary but
> not in the DB enum.** `PATCH /:id/status {status:'COMPLETED'}` passes the
> app-side whitelist and would be rejected by Postgres — **still true**. What was
> fixed is the READ half: the value is out of `DO_STATUS_BUCKETS`, so the
> delivered tab and its count no longer fail on it. Verified by grepping every
> `CREATE TYPE` / `ADD VALUE` under `migrations-pg/` and `scripts/scm-schema/`,
> now pinned by `backend/tests/statusBucketsEnumMembership.test.mjs`.
>
> **The second READ site, found 2026-08-18 and now fixed.** The Delivery Agent's
> brief (`services/agents/delivery-agent.ts`, `collectDoStatusCounts`) imported
> `DO_STATUSES` and issued one `count:'exact'` query per entry with
> `.eq('status', st)` — so `COMPLETED` reached the enum column there too, and the
> await destructured only `count`, discarding `error`, so `(count ?? 0) > 0` left
> the failed bucket ABSENT from the pipeline. It now pages the `status` column
> and counts the rows it read: no vocabulary is sent to Postgres, and a failed
> read is reported as `doPipeline.unavailableReason` (with `byStatus` empty)
> instead of as a missing bucket. Statuses outside the vocabulary now appear too,
> under their own key or `UNKNOWN` for a blank — previously counted nowhere.
> `do-shipped-states.ts` itself is untouched by this branch.
>
> **BUG (reported, not fixed): the Consignment Note's status PATCH has NO
> whitelist.** `consignment-notes.ts`'s handler writes `body.status` verbatim —
> no `DO_STATUSES` check, no shipped→pre-ship guard, case-sensitive — even
> though it shares the `do_status` enum and the DO handler right beside it was
> hardened for exactly this. Only Postgres stops a garbage value, and only if
> the case matches. The same hole is open on `delivery-returns.ts` and
> `consignment-returns.ts`.

### `delivery_state` means THREE different things — do not read across them

| Field | Where | Values | Computed by |
|---|---|---|---|
| SO detail `delivery_state` | `mfg-sales-orders.ts` `GET /:docNo` | `none \| partial \| full` | quantity rollup: `totalDelivered <= 0 ? 'none' : totalRemaining > 0 ? 'partial' : 'full'` |
| Board `delivery_state` | `delivery-planning.ts` `derivePlanningState` | `PENDING_DELIVERY \| PENDING_SCHEDULE \| OVERDUE \| DELIVERED` | derived per request, see below |
| `delivery_state` COLUMN | `mfg_sales_orders` / `delivery_orders` (mig 0053) | same four as the board | a STORED manual OVERRIDE, not a cache of the derivation |

**`derivePlanningState` — pure, no I/O, first match wins:**

1. a valid `storedOverride` is returned **immediately**. A manual override beats
   every fact below it.
2. `status === 'DELIVERED'` OR (`delivered > 0 && remaining <= 0`) → `DELIVERED`.
3. `readiness.isShipReady` → `PENDING_SCHEDULE`. (`isShipReady`, never bare
   `isMainReady` — see `docs/modules/sales-order.md` §0.5.)
4. else `daysLeft = daysBetween(today, effectiveDD)` where `effectiveDD` is
   `amended_delivery_date ?? customer_delivery_date`; `daysLeft <= 3` →
   `OVERDUE`, otherwise `PENDING_DELIVERY`. **A null delivery date can never be
   OVERDUE** — it always lands `PENDING_DELIVERY`.

Written by `PATCH /delivery-planning/:type/:id/schedule`; cleared by
`reconcileStopsToBoard` (`scm/lib/tripReconcile.ts`) when a stop is removed —
the SO side goes through `advanceSoGeneration` so an active edit lease is not
clobbered. Two callers share the one definition: the board, and the SO list
(stamped as `planning_state`, alongside the raw override stamped as
`delivery_state` — so the SO list payload carries BOTH).

**The arrangement stage sits on top of it** (`scm/lib/arrangement-stage.ts`,
also pure, also first-match-wins): out of `PENDING_SCHEDULE` → `null`; on a live
(non-CANCELLED) trip → `TIME_ARRANGED`; a confirmed `amended_delivery_date` →
`PENDING_TIME`; else `PENDING_DATE`. A live stop deliberately DOMINATES a
missing date. Documented gap: a `type:'so'` schedule for an SO with no DO writes
no `trip_stop` at all, so it can never read `TIME_ARRANGED`.

---

## 5. Stock direction

**A Delivery Order moves inventory OUT.**

**When:** the FIRST transition into ANY status in `SHIPPED_STATES` (`:402`,
spread from `DO_SHIPPED_STATES`). This is deliberately a set, not a single
status, so a DO that jumps straight to SIGNED or DELIVERED still deducts exactly
once. There are two entry points to that same deduction:

- **Non-draft create** (`:2842-2843`) — the DO is born DISPATCHED, so
  `deductInventoryForDo` runs right after the item insert.
- **Status PATCH** — `if (SHIPPED_STATES.includes(body.status))`.
  A DRAFT confirm is exactly DRAFT→DISPATCHED, so the deduction skipped at
  draft-create fires here.

**Over-delivery cap at the confirm chokepoint (2026-07-25).** BEFORE that
first-ship deduction, the Status PATCH now re-derives `soRemainingByItemId` for
the DO's linked SO lines and returns **409 `over_delivery`** if any line's
about-to-ship qty exceeds its live remaining. This closes the DRAFT door: the
create-path cap is gated `if (body.asDraft !== true)`, so a DRAFT DO lands its
full qty uncapped — without this recheck, confirming it (or a second full draft)
shipped the SO line twice (BUG-HISTORY 2026-07-25). Pure invariant in
`lib/do-over-delivery.ts` (`findOverDeliveredSoItems`).

Since 2026-08-20 (PR #2522) the same block ALSO runs the unlinked check
(`findOverDeliveredUnlinkedItems`, keyed by `item_code`), so an unlinked line
for an item the named SO already fully delivered is refused too — see the
now-CLOSED blind-spot note below. A genuinely ad-hoc unlinked line (a code the
SO never ordered) still stays uncapped, exactly as at create.

> **Unlinked-line blind spot at this same chokepoint — CLOSED (wired 2026-08-20,
> PR #2522).** `findOverDeliveredSoItems` keys by `so_item_id`, so a DO line with
> NONE contributes nothing to the linked tally and is invisible to it, even
> though it still ships stock. That is the `2990-DO-2607-005` shape: six lines,
> all `so_item_id = null`, none counted against `2990-SO-2606-019`, so the
> order's own goods went out twice (`docs/unlinked-line-duplicate-coe.md`). The
> **create** and **add-line** paths already refused this (`findUnlinkedSoLines`);
> the **CONFIRM** path now does too. The Status PATCH builds
> `unlinkedByItemCode` from the DO's lines WITHOUT `so_item_id`, computes
> `openByItemCode` by aggregating `soDeliverableRemaining` for the header's named
> SO per ordered `item_code` (that engine excludes DRAFT + CANCELLED deliveries,
> so THIS draft being confirmed is already out of the tally), and calls
> `findOverDeliveredUnlinkedItems(unlinkedByItemCode, openByItemCode)` alongside
> the existing linked check — returning **409 `over_delivery`** on either. An
> unlinked line is flagged only when the named SO ordered that item code AND has
> no open qty left, so a legitimate partial / multi-DO split still ships and an
> ad-hoc line the SO never ordered is never flagged. Pinned end-to-end by
> `backend/tests/doOverDeliveryUnlinkedRoute.test.ts` (the pure guard by
> `lib/do-over-delivery.test.ts`).

`deductInventoryForDo` (`:831`) is idempotent by two mechanisms: a pre-insert
existence check on `(source_doc_type='DO', source_doc_id, movement_type='OUT')`
(`:832-839`), and a partial UNIQUE index as the hard backstop against a race. It
collapses identical `(warehouse_id, item_code, variant_key, batch_no)` lines
into one OUT row (`:881-905`).

**The index, verbatim.** Until migration **0279** this was prod-only DDL that
appeared in no file in the repo — read live from `pg_indexes` on 2026-08-11
(Actions runs 31417585775 and 31426819498):

```sql
CREATE UNIQUE INDEX uq_inv_mov_do_source
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, item_code, variant_key)
  WHERE (source_doc_type = 'DO'::text)
```

`0230:130-134` enumerates this table's indexes as the four NON-unique ones only,
which is how a reader concludes the backstop does not exist. **0279 ends that**:
it records all four unique indexes in the migration tree (`IF NOT EXISTS`, a
no-op against production) so the schema can be read from the repo again.

**Since 0279 the DO one is `uq_inv_mov_do_source_v2`:**

```sql
CREATE UNIQUE INDEX uq_inv_mov_do_source_v2
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, item_code, variant_key,
               COALESCE(correction_seq, 0))
  WHERE (source_doc_type = 'DO'::text)
```

`correction_seq` is `NULL` on the document's PRIMARY posting (the first ship) and
`1..N` on successive CORRECTIONS written by `resyncInventoryForDo`. The
`COALESCE` is load-bearing: a bare nullable column in a UNIQUE key would let two
NULL first-ship rows coexist (SQL NULLs are distinct) and the double-post
backstop would be silently gone. `uq_inv_mov_dr_source`,
`uq_inv_mov_cs_do_source` and `uq_inv_mov_cs_dr_source` keep the original
four-column shape — the DR resync solved the same collision its own way, and the
consignment paths write once.

**Edit-after-ship resync — fixed by 0279; before it, it never worked at all.**
`resyncInventoryForDo` writes DELTA rows (an extra OUT to take more, an IN to
give back) reusing the DO's `source_doc_id`. Because `movement_type` is not in
the key, every delta for a bucket the first ship had already written was a
duplicate key and was REJECTED — `writeMovements` returned `{ ok: false }` and
the ledger did not move. Measured on production 2026-08-11: **ZERO** movements
carried the function's own notes marker, so it had never landed one row. The
function now stamps `correction_seq = max_for_bucket + 1`, and the corrections
insert.

**A qty REDUCTION no longer takes that path at all (0286).** Once the deltas
could land, the second question became what the returning stock is WORTH, and
the answer was a weighted average — `round(out_total_cost / out_qty)` — which
blends units that have a cost with units that do not, then MINTS A LOT at the
invented figure. `fn_return_do_units_at_cost` replaces it: the partial form of
`fn_reverse_do_out`, unwinding the bucket's `inventory_lot_consumptions`
newest-first so each unit goes back to the lot that paid for it, restamping the
OUT's COGS from the consumptions that survive, and writing its own balancing IN
at cost 0 with the minted lot closed. Uncosted units — the "ship anyway"
oversell — return at nothing and are reported in `qty_uncosted`.

Three consequences worth knowing before touching this path:

- **LIFO is a decision, not a derivation.** Nothing in the data says which
  physical units came back. The migration header states the rule and the reason
  (a reduction is an undo; what an operator undoes is the most recent shipment).
- **A handled reduction contributes NO row to `writes`.** The function writes its
  own IN, so the route tracks those buckets separately — they still have to reach
  `reconcileUncostedAfterIn` (a restored lot can retro-cost an earlier oversell)
  and still count as "the ledger changed" for the restamp and allocation steps.
  Gating those on `writes.length` alone silently skips every reduction.
- **The old blended row still exists**, solely as a fallback for a database
  without 0286. A reduction that posts nothing leaves shipped stock permanently
  deducted, which is worse than an imprecise cost.

The rows stay `source_doc_type='DO'` **on purpose** — see the rejected
alternatives in `BUG-HISTORY.md`. Short version: `restampDoActualCost`,
`fn_reverse_do_out` (whose step (c) exists specifically to close lots minted by
this function's delta-INs), `fn_reconcile_uncosted_out` and
`fn_reconcile_dropship_batch` all key on `'DO'`, and both cancel-path
idempotency guards read "an ADJUSTMENT row exists for this DO id" as "already
reversed" — so re-tagging these rows `ADJUSTMENT` would make cancelling an
EDITED DO a silent no-op.

Idempotency is unchanged and comes for free: the corrections are still `'DO'`
rows, so they aggregate into `current_net_out` exactly like the first ship and a
re-run with no line changes computes delta 0.

What still lands outside all of this: a delta for a bucket whose recomputed
`variant_key` differs from the one it shipped under. That is how the MAKOTO
divergence produced an OUT that consumed no lot
(`docs/inventory-ledger-divergence-coe.md`) — a different bug in a different
place, untouched by 0279.

**Which warehouse:** `resolveDoLineWarehouses` (`:645`), in order —
(1) the linked SO line's `warehouse_id`, (2) the DO header's `warehouse_id`,
(3) the global default. A line that resolves to none is **skipped**, never
guessed. Stock never crosses warehouses.

**Reversal:** cancelling a DO restores its ORIGINAL lots at their ORIGINAL
per-lot cost and DELETES the DO's `inventory_lot_consumptions` rows —
`reverseInventoryForDo` (`:1328`, called at `:4330`) calls the SQL function
`scm.fn_reverse_do_out(p_do_id, p_performed_by, p_batched_only := FALSE)`
(migration 0198, audit R4), which per bucket restores the consumed lots, zeroes
the OUT cost stamps, and writes a balance-only **ADJUSTMENT** (`+net_out`) whose
own trigger-minted lot is immediately closed. So qty nets to 0 (movement ledger
via the ADJUSTMENT; lot ledger via the restored originals) AND the cancelled
sale's COGS leaves the ledger. Before 0198 the non-drop-ship path instead wrote a
positive average-cost ADJUSTMENT / batch-restoring IN and left the consumptions
stranded (R4). If the SQL fn is absent (pre-0198) or errors, the route FALLS BACK
to that legacy average-cost add-back (`buildDoReversalRows`, `lib/do-reversal.ts`)
so a cancel is never lost — the fallback still uses `source_doc_type='ADJUSTMENT'`
because a balancing IN would reuse the DO source key that the partial unique index
(`:4322-4328`) rejects. Rack stock is returned separately by
`returnDoRacksOnCancel` (`:1073`, called `:4336`).

**Drop-ship:** a DO flagged `is_dropship` ships against the expected PO batch
BEFORE any receipt, so its OUT consumes no lot. The GRN's
`reconcileDropshipBatches` settles that later (`grns.ts:460`). This is why
cancelling the PO is blocked while such an OUT is outstanding
(`mfg-purchase-orders.ts:252-283`). Its cancel reversal goes through
`fn_reverse_dropship_do_out` (batched buckets only), which since 0198 delegates
to `fn_reverse_do_out(..., p_batched_only := TRUE)` — the same audited body the
non-drop-ship path uses, so both share one implementation.

### Shipping before the goods arrive — the per-LINE commitment (mig 0230, 2026-07-31)

**Binding is a consequence of the line, not an answer to a dialog.** A DO line
that ships before its goods land and resolves exactly ONE live bound PO now
stores that PO number in `delivery_order_items.committed_po_batch_no`, whichever
guard the operator answered. `is_dropship` keeps the meaning migration 0057 gave
it — the UI badge.

> **LANDS WITH PR-4 (this branch, owner-gated — NOT on main until the flip
> merges): WHO resolves the PO changed.** Under the Decision (owner 2026-08-06,
> `docs/modules/purchase-order.md` §Decision — soft until DO, hard from DO),
> "resolves one live PO" no longer means the stored raise-link
> (`purchase_order_items.so_item_id` via `resolveExpectedBatchBySoItem`). It
> means **the LIVE allocator's pick**: `allocateExpectedBatches`
> (`backend/src/scm/lib/do-live-allocator.ts`) walks the DO's linked lines in
> the owner's DEMAND order (delivery date ascending nulls-last, then smaller
> doc number) over the pooled open-PO supply for the ship warehouse (supply
> order: earliest effective ETA nulls-last, then smaller PO number), with
> SOFA sets picked WHOLE — one covering PO for the entire set
> (`pickIncomingForSofaSet`; a module already holding a received
> `allocated_batch_no` contributes no need but anchors the set's batch
> preference), and every pick drawing down the pool before the next line
> looks. Outstanding ship-before-arrival commitments are SUBTRACTED from the
> pool first (`subtractOutstanding` over
> `lib/committed-shipments.loadCommittedShipments` — the SAME loader
> `computeMrp` deducts with), so committing the same incoming unit twice is
> structurally impossible. Ties auto-pick deterministically and the operator
> confirms in the EXISTING short-stock dialog — never a new refusal.
> The stored PO→SO link is **procurement provenance only**: it is still
> resolved, but only to log/persist stored-vs-allocator divergences as
> `BIND_SHADOW` evidence rows (a divergence is NOT a defect — the Decision
> says so), and for the provenance displays listed in
> `docs/modules/purchase-order.md`. `planSofaSetPoConflicts` stays ARMED as
> the backstop. TWO KNOWN SEAMS, flagged for the flip review: (1) the Type-A
> sofa no-batch guard's drop-ship waiver (`buildDropshipOffenders` +
> `allHavePo`) still resolves the STORED link, so its dialog can name a
> different PO than the allocator stamps; (2) `resolveDoSofaBatchMap`'s
> source 3 (the legacy pre-0230 `is_dropship` fallback) re-resolves the
> stored link at deduction time, so a post-flip drop-ship DO whose allocator
> bound NOTHING can still get a stored-link batch stamped on its OUT — kept
> because old drop-ship DOs need it to keep resolving their original bucket,
> and the code cannot tell old from new. Both are open review items on the
> flip PR.

The decision is a pure function, `planShipCommitments`
(`backend/src/scm/lib/ship-commitment.ts`), unit-tested as a table
("resolves … PO" = the allocator's pick once PR-4 lands; the stored link
before it):

| Line | Binds? | Why |
|---|---|---|
| resolves one live PO, nothing on hand | **yes**, to that PO's number | every shipped unit comes from that PO |
| resolves no live PO (pre-PR-4 also: >1 — ambiguous, audit H3; the allocator has no ambiguity, its ties auto-pick) | no | there is no incoming batch to name, and a guessed dye lot is worse than none |
| SOFA with no `allocated_batch_no`, one live PO | **yes** | a sofa OUT is batch-scoped by construction; this is the classic drop-ship |
| `allocated_batch_no` set | no | the allocator only sets it once a covering batch is PHYSICALLY received — a normal ship |
| non-sofa with SOME stock on hand (partial short) | no | a batch stamp routes the whole OUT through `fn_consume_fifo_batch`, which sees no lot for a batch that has not arrived, so the units that WERE on hand would stop being costed at ship time. Its shortfall is still repaired by `fn_reconcile_uncosted_out` (0154) |
| a qty-INCREASE on a line whose earlier units went out in ANOTHER batch bucket | no (`prior_ship_other_batch`) | the resync keys its delta on (warehouse, code, variant, BATCH), so a stamp added now would reverse a costed OUT and re-issue the whole line against goods that have not arrived — the temporal form of the partial short above. Binding to the SAME batch the earlier units carry is not a move, so that still binds |
| no `so_item_id` (ad-hoc line) / qty 0 | no | nothing to resolve a PO from |

Each binding also records **what kind of batch it is**:
`committed_batch_strict` is TRUE only for a sofa, whose batch is a dye lot that
must never be substituted. It is written from the same `isSofa` fact the decision
used, and it is the ONLY thing that excludes the OUT from the batch-agnostic
retro-cost — see *Receipt* below. `committed_variant_key` records the bucket, so
the claim can be scoped to the same variant the OUT loop is scoped to.

Resolved at WRITE time on all FOUR paths — `POST /`, `POST /from-sos`,
`POST /:id/items` and the `PATCH /:id/items/:itemId` qty-increase — the same
"decide at create, apply at confirm" model `is_dropship` has always used, so a
DRAFT DO carries its commitment to Confirm. `resolveDoSofaBatchMap` reads the
STORED value (source 2 of 3) at every later seam — resync delta, restamp, recost
— so a PO cancelled or added after the ship can never move the bucket an OUT was
already stamped with.

The DO detail SURFACES the stored anchor (2026-08-07): the detail GET's ITEM
columns already return `committed_po_batch_no`, and both surfaces render it per
line as an anchored solid "Committed PO" chip — desktop
`DeliveryOrderDetailV2.tsx` Item cell (`CommittedBatchCell`,
`components/DocumentLinesExpansion.tsx`), mobile `MobileModuleDetail.tsx` line
rows (`CommittedBatchRowMobile`, `mobile/source-chips.tsx`) — display-only,
rendered only when present (absent lines show nothing, no dash).

**A sofa SET binds ONE purchase order.** Owner, 2026-07-31: *"同一张 batch no 就
是 PO"* — one PO IS one batch number. The old gate (`allHavePo`) only asked
whether every module had *a* PO and never whether they were the SAME one, so a
set resolving two POs shipped stamped with two batch numbers and split the dye
lot. `planSofaSetPoConflicts` groups the DO's sofa lines by their SO `doc_no` —
the same set definition `findIncompleteSofaSets` uses — and returns a
`sofa_set_po_split` 409 naming each module and the PO it resolved. It is examined
only for sets where this write would COMMIT at least one module, so it cannot
refuse a shipment that works today, and a module that would go out UN-batched
alongside a bound sibling counts as a split too (plain FIFO picks its lot).

**Receipt.** `scm.fn_reconcile_dropship_batch` claims an OUT when the source DO
is not CANCELLED **and** (`is_dropship = TRUE` **or** one of its lines carries
`committed_po_batch_no` = this batch for this product **and this variant**). Two
consequences worth stating: a plain "Ship anyway" now nets on receipt, and one
unresolvable line on a mixed DO no longer denies the netting to the rest — the
old `allHavePo` header decision was all-or-nothing.

`fn_reconcile_uncosted_out` (0154) gained the mirror exclusion — **for STRICT
(dye-lot) commitments only.** A committed sofa OUT belongs to the batched
reconcile, because costing it from whatever lot is open means another dye lot. A
committed MATTRESS has no dye lot and stays eligible here, deliberately: its
bound PO can be cancelled, re-raised under a new number, or superseded by an
inter-warehouse transfer or a stock take, and if the OUT were excluded, no
reconcile would ever reach it and its COGS would sit at RM0 forever — a worse
version of the bug 0230 exists to end. A non-sofa binding is therefore belt AND
braces: the correct GRN nets it at the real batch cost, and any later stock-IN
repairs it if that GRN never comes. Both functions recompute
`ABS(qty) - SUM(consumed)` and the GRN post runs the batched one first, so a
doubly-eligible OUT can neither double-cost nor race.

**Asking once.** `short_stock` (a quantity fact) and `sofa_no_batch` (sofa set
batch integrity) remain two separate CHECKS — the second bites even when quantity
is sufficient but split across dye lots. What was collapsed is the QUESTION: the
`short_stock` 409 now carries `bindings` (the incoming PO + ETA per short line)
so the one "Ship anyway?" dialog names what will be bound, and
`vendor/scm/lib/authed-fetch.ts` sets the other flag silently once either has
been confirmed on the same request. The two guards fire in opposite order on
`POST /` and `POST /from-sos`, so that collapse works in both directions.

The IN counterpart of a DO is the **Delivery Return** (`/delivery-returns`),
a separate module.

---

## 6. What locks and when

| Trigger | What stops | Enforced at |
|---------|-----------|-------------|
| Any non-cancelled **DR or SI** on the DO | header PATCH, line add, line edit, and the CANCELLED transition | `doHasDownstream` (`:269-284`) called at `:3544`, `:3648`, `:3796`, `:4232` |
| Line already invoiced or returned | that line's DELETE | `doLineConsumedQty` (`:1468`), checked `:4014-4022` — per-line, deliberately finer than the doc-level lock |
| Status already CANCELLED | every further transition — **CANCELLED is FINAL** | `:4203-4209`. Un-cancelling would leave the cancel's add-back ADJUSTMENT standing while `deductInventoryForDo` no-ops, inflating stock by the whole DO. Re-deliver via a NEW DO. |
| DO has shipped (`DO_STOCK_OUT_STATUSES`) | moving back to DRAFT / LOADED | `:4219-4225`. A plain status write does not reverse the OUT, so the DO would read un-shipped while its stock stayed deducted. |
| Unknown status string | the whole request | `:4171-4176` — the handler historically wrote `body.status` verbatim. |
| An **unlinked line for an item the header's SO already orders** | `POST /` and `POST /:id/items` | `findUnlinkedSoLines` (`lib/do-unlinked-so-lines.ts`) → 409 `unlinked_so_lines`. See below — this is the guard that was missing when one SO shipped twice. |

**`so_doc_no` is free text, and that used to be a hole.** A DO line with no
`so_item_id` still deducts stock (`deductInventoryForDo` reads the DO's OWN
lines) but counts toward no SO line, so `soDeliverableRemaining` cannot see it
and the over-delivery guard cannot fire. Typing an SO number into the header and
adding the order's own items by hand therefore produced a DO that shipped the
order's goods and took nothing off its remaining — which is how
`2990-DO-2607-005` and `2990-DO-2607-017` both shipped `2990-SO-2606-019`
(`docs/unlinked-line-duplicate-coe.md`). `POST /from-sos` always writes
`so_item_id` and never had this problem.

The rule is deliberately narrow: an unlinked line is refused **only when the
named SO already orders that item code**. A replacement part or a sample riding
along on the same trip still passes, because it is not bypassing anything.
| Shipped statuses (frontend) | the line editor renders read-only | `DeliveryOrderDetailV2.tsx:1362` — `["dispatched","in_transit","signed","delivered","invoiced"]` |

**Amendment path — no, not on the DO itself.** There is no `do_revisions` table
and no revision counter (verified: no such table is referenced anywhere in
`backend/src/`). What exists instead is the **SO amend mirror**: the DO create and
PATCH handlers accept `amendDateFromCustomer` / `amendedDeliveryDate` /
`amendReason`, strip them from the DO update, and write them onto the parent
`mfg_sales_orders` row, logging the change on the SO's timeline
(`prepareSoAmendMirrorAudit`, `:221-260`; create-side mirror at `:2869-2874`).
`customer_delivery_date` is never overwritten by that mirror.

Corrections to a shipped DO go through cancel (which reverses stock) + a new DO,
or through a Delivery Return.

---

## 7. The cost / money columns — frozen vs live

Everything is integer sen.

| Column | Where | Frozen or live |
|--------|-------|----------------|
| `unit_price_sen`, `discount_sen`, `line_total_sen` | line | Live until the DO locks. |
| `unit_cost_sen`, `line_cost_sen`, `line_margin_sen` | line | **Live — overwritten in place.** `restampDoActualCost` (`:527`) re-derives them from the actual booked movement cost per `(warehouse, product, variant, batch)` bucket (bucket math `:563-598`), and it re-runs at ship, on line-set change, and again via `recost.ts` when a supplier PI lands. |
| **`ship_cost_sen`** | line | **FROZEN at ship.** `freezeShipCost(current, unitCost)` (`backend/src/scm/lib/fulfillment-costing.ts:44`) returns `undefined` — meaning "do not write the column" — whenever the value is already non-null. Called at `:615-616`. So the FIRST post-ship costing captures the true ship-time FIFO unit cost and no later recost can touch it. Column added by `backend/src/db/migrations-pg/0143_scm_do_ship_cost_snapshot.sql`. |
| `local_total_sen` | header | Derived by `recomputeTotals` (`:399`) from the lines. Visible to everyone. |
| per-category `*_sen` / `*_cost_sen`, `total_cost_sen`, `total_margin_sen`, `margin_pct_basis` | header | Derived; **finance-gated** (`DO_FINANCE_KEYS`, `:317-321`) on both list and detail. |
| `amount_sen` | `delivery_order_payments` | The ledger. Not rolled into the DO header. |

Why the freeze exists: the three-way cost comparison
① SO order-time cost → ② DO ship-time FIFO → ③ SI landed cost only survives if ②
is snapshotted, because the in-place restamp collapses ② into ③ after a PI
(`fulfillment-costing.ts:33-43`). `ship_cost_sen` is NULL on legacy DOs.

`recomputeTotals` (`:399`) **fails closed and never throws** (`:408-420`): a
failed read aborts the roll-up with a log rather than writing a zeroed header,
and it aborts by logging rather than throwing because it only ever runs after its
triggering line write committed — a throw would become a 500 the client retries
into a duplicate line.

---

## 8. Desktop and mobile files that must change together

| Concern | Desktop | Mobile |
|---------|---------|--------|
| List columns / filters / buckets | `pages/scm-v2/MfgDeliveryOrdersListV2.tsx` | `mobile/MobileModuleList.tsx` config `:1064` |
| Server pagination opt-in | `useMfgDeliveryOrdersPaged` | `mobile/MobileModuleList.tsx` `SERVER_PAGINATED` (`:325`) |
| Detail fields | `pages/scm-v2/DeliveryOrderDetailV2.tsx` | `mobile/MobileModuleDetail.tsx` config `:241` |
| Status ladder / who may advance it | `DeliveryOrderDetailV2.tsx` action bar | `mobile/MobileModuleDetail.tsx:480-494`, gated by `useMayOperateDoc` (`:454`) → `canOperateDeliveryOrders` (`frontend/src/auth/salesAccess.ts:200`) — the SAME helper the desktop uses |
| SO→DO conversion | `pages/scm-v2/DeliveryOrderFromSo.tsx` | `mobile/MobileConvertWizard.tsx` (`target: "do"`) |
| Proof of delivery / collect payment | `DeliveryOrderDetailV2.tsx` payments panel | `mobile/MobilePOD.tsx` |
| Cache invalidation after a write | the hooks in `vendor/scm/lib/delivery-order-queries.ts` | `mobile/sharedInvalidate.ts:69` (`DO_ROOTS` + `STOCK_ROOTS`) |

`canOperateDeliveryOrders` is worth singling out: Sales staff get view + Print but
no operate, on **both** surfaces, resolved through one helper. Controls must be
made ABSENT rather than disabled (`salesAccess.ts:183-186`).

---

## 9. Performance summary

Optimized:
- List enrichment is already **one parallel wave of three reads** (`:2309-2313`) —
  DR count, SI count, lifecycle — not a serial chain.
- Detail folds the DR/SI counts into a `Promise.all` (`:2473-2482`).
- Desktop list is server-paginated (50/page) with server-side search, sort and
  status counts.
- Phone search goes through `phoneSearchOrParts` + `normalizePhone` (`:2263`) so a
  formatted number still matches.

Watch as data grows:
- The legacy unpaginated path still `.limit(500)` (`:2222`); the mobile convert
  wizard fetches `/delivery-orders-mfg?limit=200` (`MobileConvertWizard.tsx:239`).
- `statusCounts` costs five `count:'exact'` queries per paginated request
  (`:2283-2289`), each of which also carries the sales-scope `.in(...)`.
- `resolveSalesScopeIds` runs on **every** list and detail request; a deep
  reporting-line downline makes the `.in('salesperson_id', ...)` array large.
- `deductInventoryForDo` and `restampDoActualCost` both read
  `inventory_movements` filtered by `source_doc_id` — fine per document, but they
  run inside the status transition's request.

Cross-module context: `docs/perf-optimization-plan.md`. Route/permission
inventory: `docs/generated/`.

## A migrated DO line's snapshot columns (2026-08-11)

`scm.delivery_order_items` carries `item_group`, `variants` and `description2`
alongside the quantity, and the UI writer (`delivery-orders-mfg.ts:3484`) has
always filled them. The **migrated** writer, `create-migrated-documents.mjs`,
did not: until 2026-08-11 it named seven columns and left all three NULL on the
entire company-1 cutover corpus.

What that cost, and why it stayed hidden: `WHERE item_group IN ('sofa',
'bedframe')` matched **zero** delivery-order lines, so every audit and report
written against the parent's vocabulary returned an empty set and reported it
as a clean chain. The GRN writer in the same file always copied `item_group`
and `variants`, which is why the asymmetry went unnoticed.

Both halves are fixed: the writer now copies all three, and
`backfill-do-line-snapshot.mjs` filled the rows already written, taking them
from the parent SO line — **a delivery order is a snapshot of the sales order
at dispatch**, so `so_item_id` is the parent, not the GRN. A line whose
`so_item_id` is NULL is reported and left alone; the product catalogue would
supply a group, but a guess written into a snapshot column is indistinguishable
from a fact afterwards.

If you are classifying DO lines, still infer defensively — own tag, then the SO
line, then `mfg_products.category` — because hand-made and pre-2026-08-11 rows
both exist. See `docs/sofa-document-chain-map.md`.
How this document's lines relate to the SO / PO / GRN / DO it was copied from,
which columns the migrated writer did and did not copy, and what a correction
applied upstream does NOT reach: `docs/sofa-document-chain-map.md`.

## The migrated DO writer inserted some lines twice (2026-08-11)

The same writer double-inserted delivery lines two ways, and both are fixed in
`create-migrated-documents.mjs`:

1. `targets` took `cands[0]` for **every** AutoCount row, so a second row of the
   same item code on one order produced a second delivery line pointing at the
   **first** sales-order line. Candidates are now consumed in order.
2. the sofa branch re-pushed **every compartment** of a build each time another
   AutoCount row named the same model. A build is now covered once per document.

A final guard refuses an identical `(so_item_id, item_code, qty)` on one
document outright, so a future mapping path cannot reintroduce the shape.

**The rows already written are still there**: 8 documents, 18 surplus lines, all
`migrated_no_stock = true`, **0 inventory movements** — so no stock moved twice.
What they do corrupt is the order's arithmetic: `soDeliverableRemaining` counts
non-cancelled DO lines by `so_item_id`, so **11 sales-order lines currently read
as over-delivered** (`HC-SO-001920` shows 1 ordered against 4 delivered).

They are **not** removed, and not because it was overlooked:
`scm.delivery_order_items` has no line-level cancel column, and adding one is
entangled with the deferred line-retirement work
(`docs/autocount-line-retirement-plan.md`). The exact 18 lines, the two options
and the recommendation are in `docs/migrated-do-duplicate-lines.md` — an owner
decision, laid out to be approved in one read.

**Decided 2026-08-11 — Option B: the surplus lines hold quantity 0.** The owner
chose "qty 改 0 + 审计备注" over adding a `cancelled` column, so
`backend/scripts/zero-duplicate-do-lines.mjs` (Actions → **Zero the duplicate
migrated DO lines (owner Option B)**) sets `qty = 0` on the surplus rows and
appends an audit note to the line's `description`. **The rows stay** — nothing
is deleted, which is the owner's standing rule.

What that means for anyone reading or writing this module:

- **A `scm.delivery_order_items` row with `qty = 0` is now a real, expected
  shape on migrated documents.** It is a retired duplicate, not a data error.
  The note in `description` begins `[ZEROED ` and names the original quantity
  and the twin row that carries the real delivery.
- Nothing had to change to make the arithmetic right: `delivered` is the line's
  own `qty` (`do-line-remaining.ts:199`) and every delivered sum is `SUM(qty)`,
  so a zero contributes nothing. No reader was taught a new flag, which is
  exactly why this was preferred over a half-converted soft-cancel.
- **A zero-quantity line still prints on the DO PDF** unless the renderer
  filters it. That is the accepted cost of Option B, recorded here so it is not
  rediscovered as a bug.
- When the line-retirement work lands for real, these rows are still present
  and can be flipped to `cancelled = true` in one statement.


## Coverage note (2026-08-12 verification sweep)

Two things the code carries that this guide did not mention, recorded so the
absence is a known gap rather than a silent one:

- `doHasDownstream` moved from the route file into
  `backend/src/scm/lib/downstream-lock.ts:129-143` — same behavior (any
  non-cancelled DR/SI blocks).
- The DO-time live allocator `backend/src/scm/lib/do-live-allocator.ts` runs
  **SHADOW-ONLY** inside `resolveShipCommitments`
  (`delivery-orders-mfg.ts:640-768`): it logs divergences to
  `entity_audit_log` and binds nothing — stored-link resolution still decides.
  (PR #1681 to flip it live is DRAFT, owner-gated.)

## The transfer says at SAVE time what it could not carry (2026-08-20)

This document reaches AutoCount by **TRANSFER**, not by a create, and the
transfer route applies a **strictly narrower** set of header fields than an edit
does — `SalesHeader` / `PurchaseHeader` only, plus one extra assignment on each
purchase arm. So the account book can hold this document and still be missing
fields it has: until 2026-08-20 the conversion payload carried the ERP's number
and the account and nothing else, so every one of these landed under the DRAIN's
date with a blanked reference.

The payload now derives from `AcDownstreamSpec.facts` — the ONE description of
this document, projected onto the keys this route can apply — so a field added
there reaches the transfer with no further edit. What it still cannot carry, or
what the ERP has no value for, is **said on the save**: the create handler
returns `acNotSent` on its 201 and the New screen calls `notifyAcNotSent` before
navigating, exactly as the sales- and purchase-order creates do (#2499). The
problems carry `AC_SENT_INCOMPLETE`, not `AC_NOT_SENT`, and their title says the
document ARRIVED and part of it did not — the other wording would send someone
to raise it a second time into a book that already holds it. It never blocks.

Full reasoning, and the per-field table of what each conversion used to drop:
`docs/modules/autocount-writeback.md` §7c5.
