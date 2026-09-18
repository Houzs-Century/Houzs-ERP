# MRP (finished-goods demand vs supply)

A trading-company MRP: no BOM explosion. Demand = outstanding Sales-Order
lines; supply = on-hand stock + open PO lines; allocation = greedy by
effective delivery date. Pure calculator — no persistence and no stored
SO<->PO lock before a Delivery Order exists. Used by procurement/purchasing
to decide what to buy, and read by SO/PO/GRN/PI/Inventory screens as
"what covers this line".

## Statuses and flow

- **Soft until DO, hard from DO** (owner decision). Before a Delivery Order
  exists, all supply-demand matching belongs to the floating MRP allocator —
  recomputed on every read, pooled by `(warehouse, item_code, variant_key)`.
  `purchase_order_items.so_item_id` and any stored allocation sub-line are
  **procurement provenance only** — displayed and audited, but they influence
  no cap, no batch expectation, no coverage precedence. At DO creation the
  allocator commits live (including which incoming PO batch a
  ship-before-arrival binds to) and writes `committed_po_batch_no` on the DO
  line; from that moment the binding is anchored history and is never
  recomputed from provenance.
- Each demand line's coverage `source` is `stock` | `po` | `shortage`,
  decided by one shared function (`allocSourceOf`, mirrored byte-identically
  to the frontend). A second, separate question — "is a PO involved at all"
  (`allocSourceCoveringPo`) — is advisory-only for the purchase-side screens
  and can legitimately disagree with `allocSourceOf` on a line that is short
  but still names a covering PO.
- Company-1 hard-bound categories (bedframe, sofa, Sofa Accessory /
  `fabric_accessory`, `(SP)` mattress) cover **only** from their own
  dedicated PO line — never the pooled bucket, in either direction (a bound
  demand line never reads pooled stock; a bound PO line is dedicated and
  leaves the pool). Company 2 stays fully pooled/soft.
- `includeUndated` is **display-only** — it never changes what the allocator
  computes, only which undated rows/sets are shown; a dated line's coverage
  is identical either way (undated demand always sorts last). Default is
  hidden (owner ruling: an undated line is not orderable yet); the
  always-visible **Show no-date** checkbox is the only toggle, and every
  shown undated row is tagged **No date**.
- The default MRP view (no category/warehouse filter, undated hidden) is
  served from a **stored snapshot** (`scm.mrp_snapshots`), refreshed by a
  `*/15` cron and by a manual **Regenerate** button; any filtered or undated
  view, or a company with no snapshot row yet, computes live. A
  category/warehouse filter changes the allocation inputs, not just the
  displayed rows, so a stored result can never be safely post-filtered.

## Permissions

- Backend: `/mrp/*`, `/mrp-lead-times/*` and `/mrp-supplier-lead-times/*` all
  sit behind `scmAreaGuard("scm.procurement.mrp")`
  (`backend/src/scm/index.ts`). `POST /mrp/regenerate` and the lead-time
  writes require `edit` on that area; reading the plan requires only `view`.
- Mobile MRP is a read-only card list (`MobileModuleList`) with no write
  surface and no export, by owner decision.

## Rules that must not break

- Every consumer of coverage ("what covers this line") must read
  `computeMrp`'s output — never re-derive its own allocation. SO drill-down,
  PO/GRN/PI "Assigned SO", the outstanding-SO shortage cap, and the
  reservations endpoint all read the one engine's result.
- A field that decides whether a line enters demand/display must be
  **emitted with the exact same expression** it was filtered by (e.g. a
  line's `category`) — computing it twice as two "equivalent" expressions
  is how rows silently vanish from every tab with no error and no count.
- The product-category enum is **open** (new categories can be added at
  runtime via `acc_register_item_group`) — the tab list must be derived from
  the server's reported category set, never a hard-coded list of categories.
- `effectiveSoDelivery` (`backend/src/scm/shared/effective-delivery.ts`) is
  the **only** definition of "effective delivery date" (override → amended →
  customer date → line date fallback) — MRP, the delivery board, PO
  coverage, `/inventory` reservations and the stock allocator must all read
  this one function, never a per-file `date ?? otherDate` reconstruction.
- On-hand stock lookups are exact-variant only (no fallback); open-PO supply
  still folds a same-warehouse empty-variant pool as a last resort for a
  bucket with no PO of its own — know which of the two you're reading before
  claiming a differing variant guarantees a separate purchase.
- A DISPLAY / SHOWROOM / SERVICE warehouse (`non-selling-warehouse.ts`) must
  never be promised to a customer — MRP itself still reports what such a
  warehouse holds (a different, correct question), but any new
  readiness/promise-facing consumer must apply the non-selling veto, not
  filter MRP's own supply.
- `companyId` is a required parameter on `computeMrp` — never make it
  optional with a permissive default.
- Any multi-row Postgres read here must page (`paginateAll` / chunked `IN`)
  rather than rely on a `.limit(N)` above PostgREST's own row ceiling — a cap
  above the server's actual ceiling produces silent truncation that no
  guard can detect by counting returned rows.
- Item codes must be filtered with `pgrestInList`
  (`backend/src/scm/lib/pgrest-in-list.ts`), never a raw `.in()` — a code
  containing a literal `"` breaks `.in()`'s quoting and silently drops every
  code after it in the same batch.
- `audit-mrp-pairing.mjs` and `check-mrp-so-line.mjs` are read-only replicas
  of the engine's rules — update them in the same PR as any allocation-rule
  change, or they stop being a trustworthy check on production.

## Gotchas

- Do not reintroduce `includeUndated` (or any display flag) into the demand
  filter itself — it must only decide what is shown, never what is
  allocated; a test pins that a dated line always wins a scarce bucket over
  an undated one under either flag value.
- Do not assume a swallowed/caught read is safe here — a silently-zeroed PO
  supply read or lead-time read used to render a phantom shortage or a
  zeroed order-by date as fact; these reads now throw (`mrp_load_failed`)
  rather than degrading silently.
- Do not treat `source === 'po'` as "an order was involved" without a real
  PO number — the deleted `'ordered'` fallback label existed only because a
  hand-written third copy of the source rule had no `stock` arm; a
  fully-received sofa set with no shortage was mislabeled "ordered" with no
  PO to show.
- Do not read `purchase_order_items.so_item_id` (or any stored allocation
  sub-line) as if it caps or binds execution pre-DO — it is provenance
  (why we bought), not a lock. Only `committed_po_batch_no`, written at DO
  creation, is a real binding.
- Do not assume the stored MRP snapshot is a book of record — it is a cache
  only; an empty/missing snapshot row for a company falls back to live
  compute automatically.
- Do not add a new hard-bound category/group without updating both
  `isHardBoundLine` (`so-stock-allocation.ts`) and this engine's mirror —
  the two must agree on which lines are dedicated, or one screen reports a
  line covered while the other leaves it pending forever.
- Do not assume moving an existing SKU into or out of a hard-bound category
  (e.g. Accessory → Sofa Accessory) retroactively changes its **open**
  order lines — the product moves immediately, but lines already placed
  keep their original group until a dedicated data-migration script moves
  them.
- Do not compare `poOpen`-only figures against a "how many disagree in
  total" question — a fully-received PO line drops out of `poOpen`, which
  is exactly the state where a wrong dedication does its damage (the
  customer's order reads READY against goods that were never theirs).

## Where the code is

- Engine + route: `backend/src/scm/routes/mrp.ts` (`computeMrp`, `GET /mrp`,
  `mrpLineCoverage` / `mrpReverseCoverage` / `mrpStockAssignment`,
  `POST /mrp/regenerate`), `mrp.test.ts`.
- Backend libs: `backend/src/scm/lib/so-stock-allocation.ts` (the stored,
  DO-time allocator — must stay aligned with the engine), `ship-commitment.ts`,
  `mrp-snapshot.ts`, `lead-time.ts`, `concurrency.ts` (bounded-concurrent
  reads), `non-selling-warehouse.ts`, `so-warehouse.ts`, `supplier-bindings.ts`,
  `pgrest-in-list.ts`, `do-unlinked-coverage.ts`, `po-grouping.ts`,
  `model-category-move.ts`, `bound-line-ordered.ts`.
- Shared (backend + frontend mirror): `backend/src/scm/shared/effective-delivery.ts`,
  `mrp-alloc-source.ts`, `so-terminal-states.ts`, `product-categories.ts`,
  `do-shipped-states.ts`; mirrored at `frontend/src/vendor/shared/`.
- Coverage route: `backend/src/scm/routes/po-so-coverage.ts`.
- Read-only production tools: `backend/scripts/audit-mrp-pairing.mjs`,
  `check-mrp-so-line.mjs`, `probe-mrp-roundtrip-cost.mjs`,
  `probe-undated-demand.mjs`, `probe-staff-reported-flow.mjs`,
  `probe-custom-pillow-binding.mjs`; repairs:
  `repair-po-so-link-from-book.mjs`, `repair-po-so-link-sofa-compartments.mjs`,
  `repair-mrp-po-line-links.mjs`, `recategorise-fabric-accessory.mjs`;
  shared logic `backend/scripts/lib/sofa-po-so-pair.mjs`,
  `hard-bound-group.mjs`, `undated-demand-queries.mjs`.
- Desktop: `frontend/src/pages/scm-v2/Mrp.tsx` (page), `mrp-views.ts` (tab
  list, derived from the server's category set), `mrp-sofa-accessory.ts`,
  `mrp-model-pipeline.ts` (the ONE funnel + grouping — `computeTabModels` — that
  both the page and the export run, so the export can never disagree with the
  screen), `mrp-export-workbook.ts` (the Export button's .xlsx: one styled sheet
  per category tab, v7 layout, fetched per-tab so each sheet's coverage matches
  that tab); data hooks `frontend/src/vendor/scm/lib/mrp-queries.ts`; lead-time
  editor `frontend/src/pages/scm-v2/SupplierLeadTimes.tsx`.
- Export follows the on-screen filters (tab, warehouse, date window, only-
  shortages, search); the Status column is derived from the coverage source
  (stock -> READY, PO -> IN PRODUCTION, shortage -> CONFIRMED) as the MRP plan
  carries no separate SO workflow status.
