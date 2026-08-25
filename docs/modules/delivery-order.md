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
| Desktop new | `frontend/src/pages/scm-v2/DeliveryOrderNewV2.tsx` | **Customer and salesperson are captured by CODE, like SO/SI** (2026-08-21). Customer is the debtor autocomplete (`useDebtorSearch` + `DebtorSuggestList`) and sets `debtorCode` alongside the name; typing a fresh name CLEARS the stale code. Salesperson is a `SelectInput` over `usePickableStaff({ onlySales: true })` valued on `salespersonId`, so a uuid can no longer leak into a name string the way the old free-text input allowed — legacy `agent` is DERIVED from the picked staff on submit, never typed. Both prefill paths seed both fields: from-SO (`:696/:701`) and edit-existing (`:756/:761`). Note the asymmetry behind this: `POST /` and `PATCH /:id` take `debtorCode`/`salespersonId` from the BODY, but `POST /from-sos` does not — it copies them off the SO header, so the form's values never reach it. The Sales-location dropdown labels each option with the ONE warehouse rule — `warehouseLabel`, code first then name (`frontend/src/vendor/scm/lib/warehouse-label.ts`, a byte-identical mirror of the backend module; 2026-08-21). It printed the NAME first. Do not hand-write the order — see `docs/modules/warehouses.md`. |
| Desktop from-SO | `frontend/src/pages/scm-v2/DeliveryOrderFromSo.tsx` | Line-level picker over `/deliverable-so-lines`. |
| Desktop report | `frontend/src/pages/scm-v2/DeliveryOrderDetailListing.tsx` | Detail-listing report. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | `MODULE_CONFIGS["delivery-orders-mfg"]` (`:1064-1106`). |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Config `:241`; status actions `:480-494`. |
| Mobile POD | `frontend/src/mobile/MobilePOD.tsx` | The driver screen — signature + photo + GPS, through the **shared hook** (`useUpdateMfgDeliveryOrderStatus`, `evidence` parameter). It used a raw `authedFetch` until 2026-08-21; see "Who may attach proof of delivery" below. `signatureData` is sent **only when the customer actually drew** (gated on `hasSignature`, which the pad sets on the first pointerdown). It used to be gated on `canvas.toDataURL()`, which returns a valid non-empty PNG for an untouched transparent canvas — so every delivery stored a blank signature into `delivery_orders.signature_data`, indistinguishable from a real POD that failed to render. `podKey` and the GPS fields in the same payload were already gated on real capture. |
| Mobile convert (SO→DO) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "do"` (`:72`). Posts **`asDraft: true`** → the DO lands DRAFT and the operator confirms it; the phone never ships. Same shape as the wizard's GRN arm. CTA reads "Create draft Delivery Order". |
| Mobile planning board | `frontend/src/mobile/MobileDeliveryPlanning.tsx` | Driver run-sheet. "Take POD photo — complete" **navigates to Mobile POD** (`onPod`); it does not write a status. It used to PATCH `DELIVERED` directly with no evidence, while telling the driver to "open the order afterwards to attach the POD photo" — which MobilePOD refuses once the DO is delivered. |
| Mobile "Delivery details" card | `frontend/src/mobile/MobileDeliveryFieldsCard.tsx` | Split out of the run-sheet on 2026-08-21 (that file sits under a 2,449-line ceiling). Edits the HC delivery fields via `PATCH /delivery-planning/:type/:id/fields`. The DO-execution half — time window, arrival/departure, shipout, port, `delivery_substatus` — writes the **latest DO** and is hidden until one exists; the SO-context half writes the SO header and needs no DO. `replacement_disposal` is the one field that does not always take the direct write: on a locked SO it is refused 409 `so_locked_processing` and is raised as an SO Amendment instead. Rules and rationale in `docs/modules/delivery-tms.md` §1. |

### Who may attach proof of delivery (2026-08-21)

`delivery_orders` carries six evidence columns — `signature_data`, `pod_r2_key`,
`pod_lat`, `pod_lng`, `pod_accuracy_m`, `pod_located_at` — and the status PATCH
has accepted all six since migration 0249, writing each **only when present** so
a plain status change never blanks a POD already on the row.

Reaching them from the client is the shared hook's `evidence` parameter
(`DoDeliveryEvidence` in `vendor/scm/lib/delivery-order-queries.ts`). Before that
parameter existed the hook was typed `{ id, status }`, which is why MobilePOD
bypassed it with a raw fetch and why every other surface closed deliveries with
nothing attached.

**"Mark signed" was REMOVED on 2026-08-21 (owner decision).** It was the office
button that closed a delivery with no evidence, and the confusing twin of
"Transfer to Sales Invoice" in the same corner. So the office surfaces no longer
CLOSE a delivery at all — a shipped DO's next office action is its Sales Invoice,
and the DO stays `DISPATCHED` until a driver closes it. `DISPATCHED` still
invoices (siTransferBlockReason allows it), so the money flow is unaffected; only
the `DELIVERED` tracking status is no longer reached from the office.

| Surface | Closes a delivery (writes DELIVERED/SIGNED)? | Evidence |
|---|---|---|
| Mobile POD (driver) | **Yes — the ONLY closer now** | pad, photo, GPS; confirm warns if no signature, still allowed |
| Mobile planning board | No — routes to Mobile POD | n/a — writes no status |
| Desktop detail / list drawer | **No** — "Mark signed" removed 2026-08-21; only DRAFT → Confirm remains | n/a |
| Mobile shell action bar | **No** — the "Mark Signed" rung was removed 2026-08-21; its no-evidence hole (`docs/bugs/0481`) is closed with it. It still offers DRAFT→Confirm, LOADED→"Confirm Loaded", DISPATCHED→"Mark In Transit" | n/a |

Evidence is now captured on the one path that closes a delivery (the driver's
POD), which signs it. The office's old permissiveness — closing a delivery it did
not attend, with no proof and no word — is gone because the office no longer
closes deliveries. Deliveries a driver never signs (2990's imported style) simply
stay `DISPATCHED`; the standing rule to loosen rather than restrict is served by
DISPATCHED remaining fully invoiceable, not by a bare status button.

Census of the historical population: `backend/scripts/check-pod-evidence.mjs`,
dispatchable via the **DO integrity check (read-only)** workflow. It counts
`SIGNED + DELIVERED + INVOICED` (all three are closed) and reports signature
BYTE LENGTH, because `signature_data IS NOT NULL` overstates the evidence — the
pre-`hasSignature` blank-pad bug stored a valid but empty PNG on every delivery.
Four more sections were added on 2026-08-21, each because the one before it
would have read the same on a different world: the WHOLE table rather than the
closed slice; `scm.consignment_delivery_orders` and `public.trip_stops`, the two
other tables in this database with proof-of-delivery columns; whether a closed
row was created already-closed by an import (`migrated_no_stock`, mig 0276); and
every closed row listed in closing order with its company NAME.

### What the census actually answers (run 32459661813, 2026-08-21)

**No delivery order has ever carried a signature, a photo or a GPS fix** — any
status, either company, all time, in all three tables. Not one row.

`scm.delivery_orders` holds **39 rows in total**, all of them `2990's Home`:
25 `DISPATCHED` (newest created 2026-08-20), 12 `DELIVERED`, 2 `CANCELLED`.
There are **no Houzs delivery orders at all**.

**The zero is disuse, not breakage.** The only twelve rows ever closed were
created `DISPATCHED` over four weeks and flipped to `DELIVERED` inside a
**single minute** on 2026-07-24 — the exact set and fingerprint of
`backend/scripts/backfill-2990-delivered-dos.mjs`, which exists because 2990's
source system has no "delivered" step on a DO at all. No driver closed them and
no screen closed them, so nothing was skipped and there is nothing to backfill.

The corroboration that MobilePOD's Confirm has never fired in production: the
backend has persisted `signature_data` since 2026-07-14, and until the
`hasSignature` fix on 2026-08-14 that screen sent a blank PNG on **every**
confirm. One POD confirm anywhere in those five weeks would have left a non-null
value. There are none.

**Why nobody opens it, stated plainly and not as a complaint about drivers.**
`DISPATCHED` is a member of `DO_SHIPPED_STATES` *and* of
`SI_TRANSFERABLE_DO_STATES` (`backend/src/scm/shared/do-shipped-states.ts`), so
by the time a DO is dispatched the stock is out, the SO counts the lines as
delivered, and the Sales Invoice can be raised. (Since 2026-08-22 all three are
true one rung EARLIER, at `LOADED` / Confirmed — which sharpens this point
rather than changing it.) Every rung above it —
`IN_TRANSIT`, `SIGNED`, `DELIVERED`, and therefore the whole POD capture — is
optional, and the desktop's one-click control for it is *labelled* "Mark
signed". Capturing proof buys the office nothing the system asks for. That is a
business decision to take, not a defect to fix.

**What the census cannot tell you, ever:** which of the five closing screens was
used. `patchDeliveryOrderStatusHandler` writes no `entity_audit_log` row, so
that fact is not in this database. Do not infer it from these counts.

**Nobody is being chased about it, and that was measured rather than assumed.**
Exactly one thing CONSUMES these columns instead of writing them — the Delivery
Agent's `POD_CHASE` proposal (`backend/src/services/agents/delivery-agent.ts`),
which lists deliveries closed 1 to 90 days ago with neither photo nor signature
and is ON by default. Every closed delivery here qualifies and none could ever
be satisfied, so the obvious worry was that it had been raising unfixable
proposals for a month. It has not: `delivery_agent_proposals` holds **no
`POD_CHASE` row of any status, ever**. Section 6 of the census is that count.

**What a non-null column would still not prove.** The signature is stored inline
(base64 PNG in `signature_data`), so a non-null value there IS the image. The
PHOTO is not: `pod_r2_key` is an R2 object key, written after the upload but in
a separate round trip, so a non-null key is evidence an upload was reported, not
that the object is in the bucket.

Desktop routes: `frontend/src/App.tsx:654-657`, behind
`<ScmGuard area="scm.sales.delivery" allowSales>` for list + detail (read), and
without `allowSales` for new / from-so.

### The list's right-click menu (owner ruling, 2026-08-22)

His words, looking at this list's menu: 「DO 这一边没有问题，可是为什么没有
Cancel 呢？By right 每一个 Transaction Record 应该都可以右键（Right click）Move
to Cancel，或者在 Draft 那边右键 Confirm 之类的」 and 「我的 DO 也应该有右键
Transfer to Delivery Return，对吧？」

The menu is built by `deliveryOrderRowMenu` in
`frontend/src/pages/scm-v2/row-menus.ts` and wired in
`MfgDeliveryOrdersListV2.tsx`. It offers five things, and every one of them
calls a handler this page or its drawer already had:

The list's own status vocabulary — the tab buckets, the pill tones, and
`doCancellableStatus` — lives beside it in
`frontend/src/pages/scm-v2/do-list-status.ts`, lifted out because the list file
sits at its size ceiling.

| entry | shown when | what it does |
|---|---|---|
| Open · Edit · Print | always | navigation only |
| Transfer to Sales Invoice | `doCountsAsInvoiceable(status)` | `convertToLink('doToSi', id)` |
| Transfer to Delivery Return | `doCountsAsDelivered(status)` | `convertToLink('doToDr', id)` |
| Confirm | `doAdvanceStep(status)` is non-null, i.e. DRAFT | `PATCH /:id/status` → `LOADED` (it wrote `DISPATCHED` until 2026-08-22 — the target was the wrong half of the control) |
| Cancel Delivery Order | status is neither `CANCELLED` nor `INVOICED` | in-app confirm, then `PATCH /:id/status` → `CANCELLED` |

Everything above additionally requires `canWriteDo`
(`canOperateDeliveryOrders`).

**Cancel asks first because it reverses stock.** `doCancelDo` goes through
`useConfirm` — the same shape the Sales Order list uses — and posts the DETAIL
page's endpoint, not a new one. What the list CANNOT see is the route's second
refusal: `doHasDownstream` blocks a cancel once a live Sales Invoice or Delivery
Return points at this DO, and no list row carries that fact. That refusal
therefore arrives as the mutation's error notice
(`useUpdateMfgDeliveryOrderStatus`'s `onError`) rather than as a missing entry.

**Which returnable statuses.** `doCountsAsDelivered` is the SHARED predicate,
the same one `resolveCandidateDoIds(…, 'delivered')` applies server-side
(`backend/src/scm/lib/do-line-remaining.ts`): DRAFT, LOADED and CANCELLED are
out — goods still on the lorry never left, so nothing can come back. The menu
cannot advertise a delivery the picker would then not list.

**Only ONE status entry.** The rest of the ladder stays off this menu: the DO is
the one document where a status move writes inventory OUT, and `DELIVERED`
belongs to the driver's Proof-of-Delivery screen, which closes it with a
signature. `Reopen` is absent for a harder reason — see "Who moves the DO status"
below; every transition out of `CANCELLED` is refused.

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

> **Right-click on a list row** opens the same actions — see
> `docs/modules/document-conversion.md` §8a for the shape, the table of what
> every list offers, and the two absences that are deliberate.

## 2. API surface

`backend/src/scm/routes/delivery-orders-mfg.ts`, mounted at
`/api/scm/delivery-orders-mfg` (`backend/src/scm/index.ts:257`) behind
`scmAreaGuard('scm.sales.delivery', { readInheritsFrom: 'scm.sales.orders' })`
(`:256`) — a salesperson may READ the DOs generated from their own SOs; writes
still need `edit` on `scm.sales.delivery`.

> **Per-position capability gate on `PATCH /:id/status` (2026-08-25).** The
> mount in `backend/src/scm/index.ts` (`backend/src/scm/middleware/area-guard.ts`)
> also carries a `writeBypass` so a position holding the
> operational capability `scm.do.load` or `scm.do.dispatch` (the editable Roles
> & Permissions matrix, `position_capabilities`, mig 0322) reaches the status
> endpoint WITHOUT `scm.sales.delivery` edit — a storekeeper scan-confirms
> (→`LOADED`, the stock OUT) and a driver dispatches (→`DISPATCHED`). The guard
> only proves the caller holds one of the verbs; `patchDeliveryOrderStatusHandler`
> then binds it via `statusCapabilityRefusal` (`backend/src/scm/lib/do-status-capability.ts`):
> `LOADED`⇒`scm.do.load`, `DISPATCHED` **and the POD chain (`IN_TRANSIT` /
> `SIGNED` / `DELIVERED`)**⇒`scm.do.dispatch`, everything else 403
> `capability_required`. A caller with real delivery access is unflagged and
> skips the gate — nothing existing changes. The scan page `/scm/do-load`
> mirrors the load half (`ScmGuard … allowCapability="scm.do.load"`); the
> endpoint is the boundary.
>
> **Driver POD (2026-08-25).** The POD chain additionally requires OWNERSHIP,
> checked once the DO's crew is known: `resolveDeliveryScope` self-scopes a
> linked driver and `scopeMatchesAssignment(scope, fetchDoCrewAssignment(id))`
> must match — a driver completes only their OWN job (an admin acting on behalf
> resolves to `all` and passes), and only when the DO is ALREADY shipped
> (`prev ∈ DO_STOCK_OUT_STATES`), so a POD never triggers a first ship / stock
> OUT — it records arrival. Frontend: the POD entry in
> `frontend/src/mobile/MobileApp.tsx` + the `MobileDeliveryPlanning` run-sheet
> steps open for `canDriverCompleteDelivery` (`frontend/src/auth/salesAccess.ts`,
> holds `scm.do.dispatch`); Convert-to-DO stays Office-only. Pinned by
> `backend/tests/doStatusCapabilityGate.test.ts` +
> `backend/tests/driverPodOwnership.test.ts`.

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/` | `:2188` | List. `?page=` opts into pagination + `statusCounts`. |
| GET | `/deliverable-so-lines` | `:2347` | SO lines with `remaining > 0` (qty − delivered + returned). |
| GET | `/so-source/:docNo` | `:2425` | SO header fields for the convert form. |
| GET | `/:id` | `:2451` | Header + items + `has_children` + `lifecycle_state` + crew. |
| POST | `/` | `:2591` | Create. `asDraft: true` → DRAFT (no stock); else born **LOADED** (Confirmed) with the stock deducted. |
| POST | `/from-sos` | `:2976` | Line-level batch convert from SO picks. Same `asDraft` rule as `POST /` — **omitting the field means LOADED (Confirmed)**, i.e. stock OUT + SO synced to delivered + customer email. Callers that want a reviewable document must send it explicitly. |
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
  **LOADED** (= Confirmed; `DISPATCHED` until 2026-08-22) and stock is deducted
  immediately. Both are gated on `asDraft`, not on the status, so the rename
  moved no deduction. The create path also fires `syncSoDeliveredFromDo` and the
  customer DO email.
- **`/from-sos`** (`:2976`). Same shape, `asDraft` respected at `:3185` / `:3283`.
- **Header PATCH** (`:3450`). **FIELD-LEVEL lock since 2026-08-20 (§8 GAP-1):** a
  live DR/SI no longer freezes the whole header — only the columns that child
  snapshots freeze (`DO_IDENTITY_LOCK_COLS` in `lib/do-audit-fields.ts` =
  `debtor_code` / `debtor_name` / `currency` / `sales_location` / `branding`),
  via `changedLockedCols` (`shared/header-inherited-lock.ts`) + `doHasDownstream`,
  409 `do_identity_locked`. The DO's own delivery dates, dispatch/POD, addresses
  and notes stay editable with a child present. Strips the three amend fields out
  of the DO update and mirrors them onto the parent SO instead, writing a separate
  audit row on the **SO's** timeline (`prepareSoAmendMirrorAudit`, `:221-260`).
  `delivery_substatus` is whitelisted against `HC_SUBSTATUS_VALUES` (`:209-212`).
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

**The frontend twin, and who actually holds it.** The browser cannot import from
`backend/src`, so `frontend/src/vendor/shared/do-shipped-states.ts` is a
byte-identical vendored copy. It is held there by
`frontend/src/vendor/shared/do-shipped-states.canonical.test.ts`, NOT by
`check-shared-mirrors.mjs --strict` — that script defers to a text heuristic
which an unrelated test satisfied, so a corrupted twin passed it at 0 DIVERGED.
See BUG-HISTORY "A mirror pin that was refereeing a different pair".

**`SI_TRANSFERABLE_DO_STATES`** lives in the same file and is the server's answer
to "may this delivery be invoiced" — every CONFIRMED delivery, `LOADED`
included, and the gate is enforced at both Sales-Invoice entry points rather
than only in the client. `docs/modules/sales-invoice.md` carries the three 409
codes.

**THE OWNER RULED ON `LOADED`, 2026-08-20 — 不要拦 —— 人自己知道.** Asked directly
whether the system should refuse to invoice a delivery still marked LOADED, he
said no: 「发票是invoice？等送完货了我们才自己convert to invoice啊」 /
「我们自己开啊 manually开的不是吗」. The invoice is raised by hand, by someone who
knows whether the goods arrived, so the system does not second-guess them.

Read this before "unifying" the two status sets, because they differ by exactly
LOADED and look like one rule written twice:

| question | declaration | LOADED |
| --- | --- | --- |
| may this be BILLED? | `DO_NOT_INVOICEABLE_STATES` = DRAFT, CANCELLED | **invoiceable** |
| have the goods LEFT? | `DO_NOT_DELIVERED_STATES` = DRAFT, LOADED, CANCELLED | not delivered |

The Pending engine (`do-line-remaining.ts`) takes a REQUIRED
`DoPendingBasis` of `'invoiceable' | 'delivered'` so no caller inherits the wrong
one. **#2485's own justification does not reach LOADED** — it argued "stock was
already deducted at dispatch", true of DISPATCHED/IN_TRANSIT and false of LOADED.
The rule holds because the owner chose it, not because that argument covered it;
`backend/tests/loadedStaysInvoiceable.test.ts` pins it, and pins that #2557's
DELIVERED exclusion is still intact.


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

> **FIXED 2026-08-24, and it is the SAME SHAPE seven days later.** The `on_hold`
> tab and its overlay count were passing `document-hold.ts`'s shared
> `HELD_OR_TERM` (`on_hold.is.true,status.eq.ON_HOLD`). That term's legacy arm
> is right on the four documents whose enums carry `ON_HOLD` permanently, and
> poisonous here: `do_status` never had the label, so the count read answered
> **400 `22P02`**, and — because a failed count is now correctly reported rather
> than zeroed (the 08-17 fix above) — the route returned `500
> status_counts_failed` for the WHOLE page. `/scm/delivery-orders` was dead in
> both companies from 2026-08-22 to 2026-08-24: "Failed to load — on_hold count
> failed: unknown error".
>
> **The rule this leaves behind: nothing but a `do_status` MEMBER may be
> compared against `status` on this table.** Hold is a marker here and is read
> as `.eq('on_hold', true)` — never through the shared term, which the other
> four documents keep. Pinned by `backend/tests/doListOnHoldEnumSafe.test.ts`
> as a source scan, since a plain string cannot be typechecked and every one of
> the five tables does have the `on_hold` column. See `docs/bugs/0530-*`.

### The list shows ONE TAB PER STATUS (owner ruling, 2026-08-21)

Until this date the list had **four tabs over eight statuses** — Open, In
Transit, Delivered, Cancelled — so the screen could not tell a DRAFT from a
LOADED delivery, or a DISPATCHED one from an IN_TRANSIT one. The owner:
「draft和load要分开吧？」and「怎么定义这几个状态呢？我不明白」. He asked for the
shape the Sales Order list already has: 页签＝状态.

| tab | status | what it means |
|---|---|---|
| Draft | `DRAFT` | not confirmed. Stock untouched, counts as delivered nowhere |
| Confirmed | `LOADED` | **the first entry here writes the inventory OUT**, once. The stock has left, and the customer email goes out here |
| Loaded | `DISPATCHED` | **relabelled from "Shipped" on 2026-08-26** — the goods are ON the lorry, not gone. Stock already out. Written by the storekeeper's scan (§ below) or by hand. Holds the 30 delivery orders raised before 2026-08-22, when a create landed here; it drains as they age out |
| In transit | `IN_TRANSIT` | the lorry has left; identical to Loaded for stock |
| Delivered | `DELIVERED` (and `SIGNED`, folded) | the customer has it. A RECORD of arrival, not a stock event |
| Invoiced | `INVOICED` | a legal enum value that **nothing in this repo writes** |
| Cancelled | `CANCELLED` | final; stock returned |

`DO_STATUS_BUCKETS` is still the one source for both the tab filter and the
counts, and the counts are now DERIVED from that map rather than hand-listed —
so a bucket added there cannot be left without a count. Every enum member is in
exactly one bucket and every bucket value is a member, pinned by
`backend/tests/statusBucketsEnumMembership.test.mjs`. That pin is not
decoration: `COMPLETED` once sat in `delivered` while not being an enum member,
and the tab 500'd with `22P02` while its count silently read 0.

**The two KPI cards deliberately did NOT split with the tabs.** "On the road" is
`dispatched + in_transit` and "Delivered" counts `delivered + invoiced` — an
invoiced delivery was delivered. Splitting them the way the tabs split would
have quietly halved both numbers on the owner's dashboard.

### SIGNED is merged into DELIVERED (owner ruling, 2026-08-21)

「SIGNED 和 DELIVERED 意思几乎重叠 … 这个整合」. The two agree on every question
this system asks of a delivery order's status — both are in
`DO_STOCK_OUT_STATES`, both in `SI_TRANSFERABLE_DO_STATES`, both outside
`DO_NOT_DELIVERED_STATES` — and nothing in the tree branches on one and not the
other.

**The label cannot be removed.** Postgres has no `DROP VALUE` for an enum, so
`SIGNED` stays in `scm.do_status` for ever. The app therefore keeps folding it
into the `delivered` bucket and rendering it as "Delivered", permanently, so a
row written by anything outside this repo still lands in a tab and still shows a
word rather than a raw slug.

**The DATA move is separate and gated**:
`backend/scripts/merge-do-signed-into-delivered.mjs` +
`.github/workflows/merge-do-signed-into-delivered.yml`. Dry-run is the default
and performs the real UPDATE inside a transaction it rolls back.

### Who moves the DO status, and what each value blocks (2026-08-16)

DB type is the `scm.do_status` ENUM (base body in
`backend/scripts/scm-schema/2990s-full-schema.sql`; `DRAFT` added by
`migrations-pg/0040_scm_do_status_draft.sql`). Column default is `LOADED`.
**Every DO status move is MANUAL** — unlike PO and SI, nothing derives a DO
status from a child document.

| Value | Set by | What it does / blocks |
|---|---|---|
| `DRAFT` | create with `asDraft: true` | Not shipped. A DRAFT DO does NOT count as delivered anywhere — `so-stock-allocation.ts`, `soDeliverableRemaining` and MRP all exclude it (leak guard, audit D5). |
| `LOADED` | **a non-draft create**, the office/phone **Confirm** button, or the print's loading QR (§ below) | **THE STOCK CHOKEPOINT since 2026-08-22.** The create deducts on arrival here; a Confirm from DRAFT deducts on entry. Either way the OUT is written, the lines count as delivered, and the customer is emailed. Reads as **Confirmed** on every screen. |
| `DISPATCHED` | the **storekeeper's scan** (§ below, 2026-08-26); `PATCH /:id/status` — the row menu's "Mark Loaded", the phone's "Confirm Loaded" rung | Reads **Loaded**: the goods are on the lorry. Stock already left at Confirm. **No longer a create landing status** (2026-08-22). |
| `IN_TRANSIT` | the **driver's departure scan** (§ below, 2026-08-26); `PATCH /:id/status`; the row menu's "Mark In Transit" | the lorry has left; stock has already gone |
| `DELIVERED` | the **driver's arrival scan** (§ below — status only, NO evidence); mobile POD (status **with** signature / photo / GPS); the row menu's "Mark Delivered" | arrival recorded; stock has already gone |
| `SIGNED`, `INVOICED` | `PATCH /:id/status` only | **Nothing writes `SIGNED` since 2026-08-21**, and the scan ladder cannot produce it — its target type excludes it. `INVOICED` is written by nothing in this repo. |

### The loading QR — how a warehouse actually reaches LOADED (2026-08-21)

The DO print's header carries a **"SCAN · MARK LOADED"** QR encoding
`/scm/do-load?id=<do uuid>`. The warehouse scans the paper that travels with
the goods; the landing page (`frontend/src/pages/scm-v2/DoLoadScan.tsx`,
routed in `App.tsx` behind `scm.sales.delivery`) shows the DO and one action.
On a `DRAFT` that action is **Confirm loading**, the ordinary status PATCH to
`LOADED` (audited; the illegal-transition guard owns legality, so a shipped DO
can never be pulled back by a stray scan). **Since 2026-08-26 the same QR also
carries the next two rungs** — see *THE THREE SCANS* below; a re-scan is never
an error, it simply shows whatever step that document is now on.

**SINCE 2026-08-22 THIS SCAN MOVES STOCK.** It did not before, and this
paragraph said so. `LOADED` is now a member of `DO_SHIPPED_STATES`, so pressing
**Confirm loading** writes the inventory OUT for the whole delivery order. A
repeat scan still writes nothing — the page short-circuits on `LOADED`, and the
deduction's existence check plus `uq_inv_mov_do_source_v2` make a second one
impossible regardless. The page copy was corrected in the same change, because
the person reading it is standing at the dock deciding whether to press it.

> **KNOWN WORDING GAP — fix before the QR goes into use.** The PRINT still says
> **"SCAN · MARK LOADED"**, and scanning it now takes the goods out of stock —
> and since 2026-08-26 the same code is also the loading, departure and delivery
> scan, so the caption names one of four things it does. Still deliberately NOT
> changed here: print text is the owner's to word.
> The owner's position is that the QR feature stays, Confirmed is the stock-out
> point, and the QR is not in use yet: 「QR 跑 可是confirmed就出货 QR之后才用」.
> So this is a wording change to make before anyone scans a printed DO in
> anger — deliberately NOT made here, because changing print text is a separate
> decision from moving the deduction.

### THE THREE SCANS — one QR, three steps (owner, 2026-08-25/26)

**The scan page above did ONE rung until 2026-08-26.** Once the delivery order
was Confirmed — which is what the office raising it already makes it — scanning
the paper that travels with the goods did nothing at all. The owner's flow:

> 「(a) Storekeeper 扫码确认货物装上罗里 (b) 司机出发（IN TRANSIT）(c) 送达
> （DELIVERED）」

and the rule that shapes the screen:

> 「就是我状态只要一点，它基本上都只能剩最后一个状态（下一个状态）」

`DoLoadScan` now shows the NEXT rung and only the next rung:

| document is | button | writes | shows as |
|---|---|---|---|
| `DRAFT` | Confirm loading | `LOADED` | Confirmed |
| `LOADED` | Confirm Loaded | `DISPATCHED` | **Loaded** |
| `DISPATCHED` | Confirm Departure | `IN_TRANSIT` | In Transit |
| `IN_TRANSIT` | Confirm Delivered | `DELIVERED` | Delivered |
| `SIGNED` / `DELIVERED` / `INVOICED` | none — "Nothing left to do on this document." | — | — |
| `CANCELLED` | none — a refusal naming the office | — | — |
| on hold | none — it says it is on hold | — | — |

No picker, no skipping, no way back — and after a rung is written the page shows
a confirmation and NO button until the paper is scanned again. One scan is one
step, which is the physical shape of the rule above.

**Stock is untouched by every rung past the confirm.** 「只要我一开 DO，我就扣库
存。In transit、Delivered，这些都只是状态，看一下情况而已。」 `LOADED` is already a
`DO_SHIPPED_STATES` member, so the deduction is done before the second scan.

**The ladder is `doScanStep` / `doScanBlockReason` in
`frontend/src/vendor/scm/lib/do-next-step.ts`**, beside the office's
`doAdvanceStep` rather than as a second copy of it. The two are deliberately
separate: the office at a desk is offered the confirm and then pointed at the
Sales Invoice; the person at the lorry is offered the one physical step in front
of him. Each rung carries its own `note` — the line under the button — so adding
a rung cannot leave one behind.

**`SIGNED` cannot be produced, and the COMPILER enforces it.**
`DoScanStep['status']` is `Extract<DoStatus, 'LOADED' | 'DISPATCHED' |
'IN_TRANSIT' | 'DELIVERED'>`, so a fifth target does not typecheck. `SIGNED`
counts as delivered everywhere (`doCountsAsDelivered`), which is why the bare
button writing it was `docs/bugs/0481`; nothing has written it since 2026-08-21.
A row that already holds it is answered as finished. The same type answers
`docs/bugs/0530`'s class: a label `scm.do_status` does not define is a 22P02 and
a 400, never an empty match.

**THE THIRD SCAN IS NOT A SIGNED RECEIPT, AND THE SCREEN SAYS SO.** It writes
`DELIVERED` and captures **no signature, no photo and no location**. Compared to
the driver's Proof-of-Delivery screen:

| | the scan | `frontend/src/mobile/MobilePOD.tsx` |
|---|---|---|
| status written | `DELIVERED` | `DELIVERED` |
| customer signature → `signature_data` | **no** | yes, gated on a real pointerdown |
| delivery photo → `pod_r2_key` | **no** | yes, uploaded to R2 first |
| GPS → `pod_lat/lng/accuracy_m/located_at` | **no** | yes, sent only when captured |
| what the screen says | names all three losses BEFORE the press | warns when no signature was captured |

`DO_SCAN_DELIVERED_EVIDENCE_NOTE` is that sentence. Capturing evidence here
instead was rejected on `docs/bugs/0480`'s reasoning — five surfaces PATCH this
endpoint and a second capture path is the divergence that entry was written
about. Evidence stays allowed everywhere and required nowhere; what was wrong
there was the silence, so this screen is not silent.

**The on-hold refusal is the SCREEN's, not the server's.** `PATCH /:id/status`
does not read `on_hold` — mig 0324 gave the delivery order the marker columns and
left the handler alone. Do not cite this page as the guarantee.

Pinned by `frontend/src/pages/scm-v2/DoLoadScan.ladder.test.tsx`, which mounts the
real page and presses the real button rather than calling the helper the page is
supposed to call.

### The three manual status moves on the row menu (2026-08-22)

`Mark Loaded`, `Mark In Transit` and `Mark Delivered` are offered on the
delivery-order list's right-click menu (`frontend/src/pages/scm-v2/row-menus.ts`,
`deliveryOrderRowMenu`). The owner maintains those three by hand until their
machines exist: 「保留全部状态 我可以convert，可是库存当我开了DO 就是confirmed的时候
就直接扣。然后我的shipped in transit delivered 我手动维护，之后我才弄自动」, and
「是的 因为现在完全没有这些功能 提前铺路而已」.

This is a **named, dated exception** to the rule that a machine-derived status is
never offered to a person, and the reasoning, the end state each entry is
temporary against, and what retires each one live in
`docs/modules/document-status-vocabulary.md` §1b. Read that before changing this
menu.

**They cannot move stock.** The entries are gated on `DO_STOCK_OUT_STATES`, so
they appear only where the OUT has already been written — never on a `DRAFT`
(where they WOULD be the deducting hop, which belongs behind the Confirm control
with its own words) and never on a `CANCELLED` delivery order (which the server
refuses every transition out of). The status a row already holds is omitted, and
a read-only user gets no status entries at all.

**`Mark Invoiced` is deliberately absent** and is not to be added: nothing in
this codebase writes `delivery_orders.status = 'INVOICED'`, so the label means
"somebody clicked it", not "this was billed".

### A HELD delivery order can still be confirmed, and its stock still ships

**FINDING, 2026-08-22 — reported, not fixed here.** #2661 turned Hold into a
marker on `scm.delivery_orders` (mig 0324: `on_hold`, `hold_reason`, `held_at`,
`held_by`). Since this change makes entering `LOADED` write the inventory OUT,
the obvious question is whether a hold stops that. **It does not.**

- **The server does not look.** `PATCH /:id/status` is 284 lines and contains
  ZERO references to `on_hold` / `isDocumentHeld` / `held`, and its scoped load
  selects `status, so_doc_no` — the hold column is not even in the projection.
  By #2661's own rule ("the hold column is SELECTED, never inferred; an
  unselected column reads `undefined`, which is not held, which is the permissive
  answer"), this is precisely the silently-open-gate shape that header warns
  about.
- **The gates that DO read a hold answer a different question.**
  `lib/source-document-gates.ts` covers SO→DO, SO→PO, PO→GRN and GRN→PI — may
  this document be the SOURCE of a downstream one. A held Sales Order cannot
  raise a delivery order. But once the delivery order EXISTS, holding it gates
  nothing on the delivery order itself.
- **The block is client-side only.** The list menu ANDs `!rowIsHeld(r)` into
  `canConfirm`, `canInvoice`, `canReturn` and (since this change)
  `canSetStatus`, so a held row is not OFFERED a confirm. Any other caller — the
  phone, an integration, a stale bundle — is not refused.

**No gate is built here, deliberately.** Whether a hold should block the confirm
is a business decision (it would make Hold a hard stop on stock rather than a
marker, which is the opposite of what 「我们的hold是给我们知道一个 order hold这的」
asks for), and it belongs to whoever owns the hold work. It is written down so
the next reader does not have to re-derive it.

### FOLLOW-UP — the consignment note has the same shape and was NOT changed

`backend/src/scm/routes/consignment-notes.ts` spreads the same
`DO_SHIPPED_STATES` into its own `SHIPPED_STATES` — on purpose, and its comment
says why — so promoting `LOADED` widens that module's shipped set too. No
consignment file was edited here; that inheritance is the whole of the effect,
and it is traced rather than assumed:

- A consignment note is CREATED at `DISPATCHED` (`:797`) and deducts on the
  create path, so no note is ever born into the promoted state.
- The status PATCH runs `resyncNoteInventory` on entry to a shipped state. That
  function is a SELF-HEALING resync — it drives the net OUT per bucket to match
  the note's current lines — so on a note whose stock already went out at create
  it computes a zero delta and writes nothing. Where it does change behaviour it
  changes it in the safe direction: a note sitting at `LOADED` used to have the
  resync bail out at `:323`, so line edits made there never reached the ledger.
  Now they do.
- **PROVEN, and it makes the whole question academic for now:**
  `scm.consignment_delivery_orders` holds **no rows at all** in production —
  `backend/scripts/check-consignment-status-census.mjs`, run `32576078732`,
  2026-08-22, both companies. The same run confirms the column is the SAME
  `scm.do_status` enum the delivery order uses. So this inheritance lands on
  zero existing documents.

Whether a consignment note's stock should ALSO leave at Confirm — the same
question the owner answered for delivery orders — has not been asked, and it
belongs to the consignment owner rather than to this change.

The QR is armed by an **explicit `loadScanId`** on the PDF header (never a
generic id): the Consignment Note print reuses this renderer
(`delivery-order-pdf.ts`), and a CN must never grow a control that flips a
DELIVERY ORDER's status. The three DO surfaces (detail, list export, mobile)
stamp it; `ConsignmentNoteDetail` deliberately does not. Vector-drawn via
`vendor/scm/lib/pdf-qr.ts` (frontend twin of the ASSR print's `qrSvg`).
Pinned by `pages/scm-v2/do-load-scan.test.ts` + `lib/pdf-qr.test.ts`.
| `COMPLETED` | **nothing writes it.** Still in the code vocabulary (`DO_STOCK_OUT_STATES`, `DO_STATUSES`) but NOT a member of the `do_status` enum in any schema file or migration. Removed from the `delivered` filter bucket 2026-08-17. **CORRECTED 2026-08-18** — this cell used to end "the JS-side sets compare a status already in hand, where a value that can never occur is inert", and that was FALSE: `services/agents/delivery-agent.ts` mapped `DO_STATUSES` into one `.eq('status', st)` query per entry, so `COMPLETED` *was* being handed to Postgres to parse. That consumer no longer enumerates the list at all (it counts the rows it reads), so the claim is now true of every remaining reader — but it was a second live 22P02 for a day, and it was found by a reviewer, not by the sweep that wrote the sentence | read-only |
| `CANCELLED` | `PATCH /:id/status`, atomic branch | **FINAL.** `A cancelled Delivery Order cannot be reactivated — its stock was already returned. Create a new DO to deliver again.` (409 `do_cancelled_final`) |

Refusals the operator sees, in the order they fire:

| Guard | Message |
|---|---|
| unknown target (input upper-cased first) | `"<x>" is not a valid Delivery Order status.` (400 `invalid_status`) |
| shipped → pre-ship | `This Delivery Order has already shipped, so it cannot be moved back to a not-shipped status. Cancel it and create a new Delivery Order instead.` (409) |
| over-delivery re-check on first ship (linked AND unlinked lines — PR #2522) | `This delivery would ship more than the Sales Order ordered — another DO already covers it. Refresh and check the Sales Order.` (409 `over_delivery`) — and until 2026-08-20 a LOADED DO tripped this against ITSELF, see below |
| downstream lock (cancel, header PATCH, line add/edit) | `DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit` (409) |
| line shrink below consumption | `Cannot reduce qty to <n> — <m> unit(s) have already been invoiced or returned for this line. Cancel the related Invoice / Delivery Return first.` |
| source-SO gate | `so_not_deliverable` — the SO `is still a draft / has been cancelled / is on hold` |

> **THE DELIVERY ORDER HAS A HOLD OF ITS OWN SINCE 2026-08-22 (mig 0324).**
> The owner asked for one on 2026-08-21 (「再加到一个 Hold」) and it was missed
> while the PO, GRN and PI got theirs. `scm.delivery_orders` carries `on_hold` /
> `hold_reason` / `held_at` / `held_by`, written by `PATCH /:id/hold`, and
> **`scm.do_status` is untouched** — which is the plainest illustration of why a
> marker beats a status: the other three each cost an irreversible
> `ALTER TYPE ... ADD VALUE`.
>
> A held DO keeps its real stage — LOADED, DISPATCHED, IN_TRANSIT — because that
> is the fact the warehouse and the driver need, and carries a Hold chip beside
> it. The list gained an **On Hold** tab that reads the flag and deliberately
> overlaps the stage tabs. A held DO is not invoiceable (`canInvoice` ANDs
> `!rowIsHeld(r)` with the shared `doCountsAsInvoiceable`).
>
> It is also the ONE status-shaped entry the DO row menu accepts. That menu
> refuses status moves because a DO status move writes an inventory OUT; a hold
> writes no movement at all, so the objection does not apply.

> **Which sales orders may raise a delivery order — ONE home since 2026-08-21.**
> The set is `SO_UNDELIVERABLE_STATUSES` = `{DRAFT, CANCELLED, ON_HOLD, CLOSED}`
> in `backend/src/scm/shared/so-deliverable-states.ts`, with
> `soCanRaiseDo(status, onHold)` as the predicate — the second argument is the
> mig-0324 marker and is REQUIRED, because a held SO now keeps its real status
> and the deny-list alone would wave it through; this router imports it instead of declaring its own `Set`,
> and the frontend runs a byte-identical vendored twin
> (`frontend/src/vendor/shared/so-deliverable-states.ts`, refereed by
> `so-deliverable-states.canonical.test.ts`).
>
> **`CLOSED` joined the set on 2026-08-22**, when the status came back on the
> Sales Order meaning **stop chasing the remainder** — the customer took 7 of the
> 10, or the supplier cannot supply the last 3, and the delivered part stands
> (owner, asked whether that case happens here: 「有的」). If the remainder is not
> coming there is nothing left to deliver, so no NEW delivery order may be
> raised; a DO already raised is untouched. It is the one shape a deny-list can
> get wrong — a status that READS as forward and would otherwise sail through —
> which is why it is stated here and not left to be noticed. `CLOSED` is not
> `CANCELLED`: a cancelled order is void, a closed one is a real sale that came
> up short. Definition: `backend/src/scm/lib/so-lifecycle-guards.ts`.
>
> **It is a DENY-list and it must stay one.** Every forward status — CONFIRMED,
> IN_PRODUCTION, READY_TO_SHIP, SHIPPED, DELIVERED, INVOICED — is deliverable,
> because this business ships one order in several batches. The Sales Order
> list's row-drawer CTA had written the same rule as an ALLOW-list of one value
> (`s === "confirmed"`), so the Transfer button was absent on READY_TO_SHIP —
> a status `recomputeSoStockAllocation` writes BY ITSELF when the goods land.
> `docs/bugs/0504-transfer-to-delivery-order-vanished-the-moment-stock-arrived.md`.
>
> A blank or unreadable status returns `true` on purpose, on both sides: the
> server is the gate, the predicate only decides whether to OFFER, and offering
> something the server then refuses in plain language beats hiding something it
> would have accepted.

> **"Has this delivery counted?" is ONE predicate now (2026-08-20).**
> `doCountsAsDelivered(status)` and `DO_NOT_DELIVERED_STATES` live in
> `backend/src/scm/shared/do-shipped-states.ts`, with a PostgREST literal
> (`DO_NOT_DELIVERED_IN_LIST`) and a `.mjs` mirror for the audits, all BUILT
> from one array. The set is `DO_PRESHIP_STATES` + CANCELLED = the exact
> complement of `DO_STOCK_OUT_STATES` over the eight-label vocabulary.
>
> It was written by hand in NINE places and every one read `{CANCELLED, DRAFT}`:
> `lib/do-unlinked-coverage.ts` (twice), `lib/so-delivery-sync.ts`,
> `lib/so-stock-allocation.ts`, `lib/do-line-remaining.ts` (twice),
> `routes/inventory.ts`, `routes/delivery-orders-mfg.ts` and
> `scripts/check-do-integrity.mjs`. LOADED is PRE-SHIP — the inventory OUT only
> fires on ENTRY to a shipped state — so all nine counted a delivery that is
> still on the lorry, and the confirm gate one row above then refused a LOADED
> DO against its own lines whenever `2 x own_qty > ordered_qty`, which is every
> full delivery. Goods on the lorry, button returns 409; and because the OUT had
> not fired, stock on hand read too high, MRP did not reorder, and the way out
> an operator reaches for is cancel-and-re-raise — the path that minted the
> DO-005 duplicate delivery.
>
> `routes/unbilled-deliveries.ts` was the tell: the one consumer that had LOADED
> right, and it had it right BY HAND.
>
> **PROVEN 2026-08-20** (`check-do-integrity.mjs` R4/R4b against production, run
> 32368212535): **0** delivery orders are in LOADED in either company and **0**
> would be refused, so nothing was stuck when this was fixed. Not proof the state
> is unreachable — the column is `DEFAULT 'LOADED' NOT NULL` and
> `PATCH /:id/status` accepts every `DO_STATUSES` member.
>
> `routes/delivery-planning.ts` keeps the two-state pair ON PURPOSE: it asks
> which DO is the LIVE one for an order so a board write lands somewhere, not
> whether it shipped, and a LOADED delivery IS live. The reason is written
> beside the exemption in `backend/tests/doDeliveredOneHome.test.ts` rather than
> at the two sites, because that router is already over its file-size ceiling
> and a ceiling may only fall. That test is also what stops the tenth copy — it
> scans for the hand-typed pair per MATCH (a window about delivery orders), not
> per file, self-tests its own regexes first, and names that one exemption.

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

### The bucket it ships from is the SKU's, not the request's (2026-08-23)

**白话.** 出货单以前是「客户端说这行是什么类别，就当它是什么类别」。类别不是标签
——它决定这行货算在哪一格库存里。客户端讲错或漏讲，系统就会去**空的那一格**看有没有
货，回答「没货，还要出吗？」，然后又从**空的那一格**扣。货明明在仓库里。

从这个 PR 起，出货单自己去产品档案查 SKU 的类别，不再相信送进来的那一个字。

**The mechanism.** `item_group` is an input to the stock bucket:
`computeVariantKey(item_group, variants)` composes a sofa's fabric / seat / leg
(a bedframe's fabric / gap / divan / leg) into the key **only** for a sofa or
bedframe group — for `others`, `accessory`, `service`, `mattress` or null it
returns `''` by design (`shared/variant-key.ts`). PR #2660 closed this on the
INBOUND documents (SO / PO / GRN / CO). The outbound side still read
`it.itemGroup` straight off the request body, so a delivery order **chose which
bucket to check and to deduct from using a category the client supplied** — the
identical shape #2660 removed from the purchase side.

**The rule now.** Every request-sourced delivery line has its `itemGroup`
rewritten to `mfg_products.category` for its item code — company-scoped, because
`code` is shared between the two organisations (the reason `grns.ts:287` gives)
— **once, above every reader**, by `resolveItemGroups` (`lib/sku-category.ts`).
The caller's value survives only where the catalogue has no row or no category
for that code. Owner 2026-08-22: 「正常来说就跟着 PO 里面的 SKU 啊，我的 SKU 也绑定
跟 category 了啊」.

**Why a rewrite and not a lookup at each reader — this is the outbound
difference.** An inbound document reads the group in ONE place: the row it
writes. A delivery order reads it in three — the pre-flight stock CHECK, the
ship-commitment planner (mig 0230), and the row it stores, whose stored value is
what `deductInventoryForDo` / `resyncInventoryForDo` key the OUT from later.
Three lookups can disagree; one assignment cannot. A line that passed the check
against the bedframe bucket and then deducted from the unclassified one would be
worse than the bug being fixed: the operator's "ship anyway?" answer would have
been about a bucket the goods never left.

The rewrite also reaches the readers a per-row helper would have missed —
`isServiceLine`, the sofa dye-lot guard and the whole-set guard read `itemGroup`
off the same line objects. **Consequence worth knowing:** a sofa that used to
arrive mis-declared as `others` bypassed the dye-lot guards; it now meets them,
so such a line can be refused at ship time where it previously was not. That is
the guard working, not a new refusal.

**Where it is applied, and where it deliberately is NOT.**

| path | source of the group | changed |
|---|---|---|
| `POST /` (bulk create) | request body | YES — resolved after `fillMissingSoItemIds` |
| `POST /:id/items` (single add) | request body | YES |
| `PATCH /:id/items/:itemId` | request body | YES, **only** when the patch names `itemGroup` or `itemCode` |
| `POST /from-sos` (convert) | `soDeliverableRemaining` reads `mfg_sales_order_items` | NO — it inherits a group the server already resolved |
| `deductInventoryForDo` / `resyncInventoryForDo` / `restampDoActualCost` | the STORED `delivery_order_items.item_group` | NO — reading the stored value is what makes it agree with the check |

The same rewrite landed on the three sibling outbound documents, which key their
movement from the stored group the same way: Delivery Return, Consignment Note,
Consignment Return (create, single-add and the identity half of the line PATCH
on each). Their convert-from-source paths copy DB rows and were left alone.

**This stops NEW rows only.** Document lines already carrying a category that
disagrees with their SKU are not repaired here — that is a write-shaped job that
needs the read-only probe's count first (PR #2671). Trace:
`docs/bugs/0524-the-delivery-order-let-the-client-decide-which-stock-bucket.md`,
and the inbound half at
`docs/bugs/0514-the-so-to-po-hop-lost-the-category-so-received-sofa-stock-wa.md`.

**Guard.** `backend/tests/doLineCategoryFromSku.test.ts` drives the real
add-line handler and pins both readings in one request: the short-stock 409 the
operator is shown names the SKU's bucket, and the row stored carries the SKU's
group. Proved RED on the unfixed tree — 3 of its 4 cases fail, reporting
`variantKey ''` and `item_group 'others'`.

### THE STOCK LEAVES AT CONFIRM (owner ruling, 2026-08-22)

> 「once confirmed就代表出货了 就是直接扣库存」
> 「draft 没出货，Confirmed就代表出货了 然后delivered只是记录而已，记录送到了」

In plain terms: a draft has not shipped; **confirming a delivery order is what
takes the goods out of stock**; and Shipped / In transit / Delivered are the
office's record of where those goods have got to. The whole ladder is kept —
「保留全部状态 我可以convert」 — and the three tracking rungs are moved by hand
until their machines exist.

`LOADED` (rendered **Confirmed**) therefore joined `DO_SHIPPED_STATES`, and
`DO_PRESHIP_STATES` is now `DRAFT` alone. The office **Confirm** button also
changed target: it wrote `DISPATCHED` — which every screen renders as
"Shipped" — while calling itself Confirm, so pressing it skipped the Confirmed
state entirely. It writes `LOADED` now (`do-next-step.ts`).

**Why this could not re-deduct anything that had already shipped**, measured
rather than argued:

- **Nothing was in the promoted state.** Production census, run `32573972467`
  (2026-08-22): 44 delivery orders — 30 `DISPATCHED`, 12 `DELIVERED`, 2
  `CANCELLED`, and **zero** in `DRAFT` / `LOADED` / `IN_TRANSIT` / `SIGNED` /
  `INVOICED`. The 30 dispatched rows are not touched: the OUT fires on a
  TRANSITION, and none of them transitions.
- **The deduction is idempotent, at two levels.** In the application,
  `deductInventoryForDo` opens with an existence check — any
  `source_doc_type='DO'`, `movement_type='OUT'` row for this DO and it returns
  without writing. In the database, run `32574476216` (2026-08-22, read from
  `pg_indexes`) confirms `uq_inv_mov_do_source_v2` is live: UNIQUE over
  `(source_doc_type, source_doc_id, item_code, variant_key,
  COALESCE(correction_seq,0)) WHERE source_doc_type='DO'`. `movement_type` is
  not in the key, so a second primary posting is refused by Postgres. That run
  also reports **zero** multi-row DO buckets in production.

**When:** the FIRST transition into ANY status in `SHIPPED_STATES` (`:402`,
spread from `DO_SHIPPED_STATES`). This is deliberately a set, not a single
status, so a DO that jumps straight to SIGNED or DELIVERED still deducts exactly
once. There are two entry points to that same deduction:

- **Non-draft create** — the DO is born LOADED (Confirmed) since 2026-08-22, so
  `deductInventoryForDo` runs right after the item insert. This is the path every
  live delivery order took; the status name changed, the timing did not.
- **Status PATCH** — `if (SHIPPED_STATES.includes(body.status))`.
  A DRAFT confirm is exactly DRAFT→LOADED, so the deduction skipped at
  draft-create fires here.

### THE CREATE IS THE PATH THAT MATTERS, and it lands on Confirmed too

The status PATCH is the MINORITY path. **Every live delivery order in production
was raised by a plain non-draft create** — run 32573972467 — which deducts at
creation and performs no status transition at all. The owner:
「我们是只要出DO就扣了库存了不是吗？」 — raising a DO already takes the stock out.
The code has said so since 2026-05-29: *"a DO means goods are OUT the moment it's
created"*.

So both create paths land `LOADED` (Confirmed) rather than `DISPATCHED`:
`status: (body.asDraft === true) ? 'DRAFT' : 'LOADED'`. Raising a delivery order
IS the confirm, so it belongs on Confirmed, and `DISPATCHED` is left to mean what
it says — a person or (later) the storekeeper's scan recording that the goods
went on the road.

> **THE MOMENT THE STOCK IS DEDUCTED DOES NOT CHANGE.** Before and after, a
> non-draft create deducts right after the items insert. The deduction, the
> SO-delivered sync and the customer email are all gated on `body.asDraft`, never
> on the status literal, so renaming what the row lands in cannot reach them.
> `backend/tests/doStockLeavesOnConfirm.test.ts` pins that gate on both create
> paths precisely because a create that silently stopped deducting is the worst
> outcome this change could have.

**The 30 existing `DISPATCHED` rows are NOT backfilled, and they are correct as
they stand.** Their stock is out, `DISPATCHED` is a legal status that still means
something, and rewriting settled documents to make a tab look tidy is not worth
touching history for. An owner reading **Shipped · 30** after this ships is
looking at deliveries raised under the old naming. The Shipped tab drains
naturally: every new delivery order lands on **Confirmed**, and a row reaches
Shipped only when somebody marks it so.

Also corrected with the create: `DeliveryOrderNewV2.tsx` posts
`status: draft ? "DRAFT" : "LOADED"` in its create body and the server ignores
`body.status` on create entirely — that field has never done anything, and the
server now independently agrees with what it was asking for.

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

**Rack stock-out is bounded to the ORDER'S OWN company, and that is a predicate,
not a policy.** `stockOutDoLinesFromRacks` consumes the physical rack ledger on
dispatch. The rack it consumes from is CALLER-SUPPLIED — the DO line's `rackId`
lands in `delivery_order_items.rack_id` straight off the request body — and the
client is service-role against a database whose RLS has no policies, so the
`company_id` the helper receives has to appear in every rack read and write, not
only on the movement rows it stamps. Until 2026-08-21 it appeared only on the
stamp, and a rack uuid from the other company's warehouse resolved and had its
placements decremented. `backend/tests/doRackStockOutCompanyKey.test.ts` fails
the build on a rack statement in that helper with no company predicate. Entry:
`docs/bugs/0497-a-delivery-order-could-take-goods-off-the-other-company-s-ra.md`.

Still open, deliberately: the explicit-pick branch does not require the rack to
sit in the LINE'S ship-from warehouse, which the fallback branch does. That is an
operational question (how do pickers actually choose a rack), not a defect with
one right answer, so it is the owner's call.

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
| Shipped statuses (frontend) | the line editor renders read-only | `DeliveryOrderDetailV2.tsx:1376` — `DO_SHIPPED_STATES`, imported from `vendor/shared/do-shipped-states` since 2026-08-18. It used to be a hand-typed `["dispatched","in_transit","signed","delivered","invoiced"]` on this line while the transfer button sixteen lines above gated on a NARROWER hand-typed pair — one file holding two answers to "has this shipped". |

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
| SO→DO conversion | `pages/scm-v2/DeliveryOrderFromSo.tsx` (picker → `DeliveryOrderNewV2.tsx`, which owns the "Save as draft" toggle) | `mobile/MobileConvertWizard.tsx` (`target: "do"`) — one screen, always `asDraft: true` |
| Convert-to-DO from the planning board | `vendor/scm/lib/delivery-planning-queries.ts` `useConvertSosToDo` | `mobile/MobileDeliveryPlanning.tsx` — **both** carry an `Idempotency-Key`; desktop keys per SO doc_no (one mount converts many), mobile per mount (one mount is one stop) |
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

## A DO line SEEDS its variants from line 1, and then stops (2026-08-21)

`DeliveryOrderNewV2.tsx` seeds a newly picked line's `variants` from the first
line of the same category — and that is ALL it does. Unlike `SalesOrderNew`,
`MobileNewSO` and `ConsignmentOrderNew`, it runs **no live cascade**: once a
line is on the page, changing line 1 afterwards does not reach it.

That is an open owner decision, not an oversight. Whether a delivery-order line
*should* follow line 1 is a business question — a DO is a snapshot of what
ships, and quietly rewriting line 2's fabric because someone corrected line 1
would be a different kind of wrong from leaving it alone. It is named here, and
in the module header of `frontend/src/vendor/scm/lib/so-variant-cascade.ts`,
rather than left to whoever reads the file next.

What DID change on 2026-08-21: the seed comes from that shared module
(`seedableMasterVariants` + `seedFollowerVariants`) instead of a hand-written
memo plus a raw `{ ...inherited }` spread. The spread handed the master's
`buildKey` to the new line, forging a sofa compartment on an unrelated line —
which reaches the free-gift trigger (`backend/src/scm/shared/free-gift.ts`) and
the PDF module grouping (`vendor/shared/so-line-display.ts`) — and its `remark`,
which is per-line by nature. `seedFollowerVariants` strips both.
`docs/bugs/0508-the-consignment-order-ran-its-own-copy-of-the-variant-cascad.md`.
The rule itself, and which pages are on it, are documented in
`docs/modules/sales-order.md`.

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

## Right-click Print, for the whole chain (owner ruling, 2026-08-22)

**The list's right-click Print prints the chain (2026-08-23).** A DO row offers
`Print` for itself and `Print Sales Order <no>` for the order behind it, in
place — no navigation.

**Its two DOWNSTREAM entries are a recorded gap, not an omission.**
`invoiced_si_nos` and `return_nos` are document NUMBERS with no id, and a PDF is
fetched by address (`GET /delivery-orders-mfg/:id` is `.eq('id', id)`), so an
entry built from one would 404. The fix is one column on two selects already in
flight in `routes/delivery-orders-mfg.ts`, and it is not in that change because
the file is over its size ceiling — `document-conversion.md` §8b sizes it.
