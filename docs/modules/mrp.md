> ## Corrections — 2026-08-12 code-read sweep
>
> 1. computeMrp has 3 call sites in mfg-sales-orders.ts (list :1528 added 2026-08-02, detail :2883, :3042), not 2.
> 2. The Decision section's “provenance influences NO coverage precedence” is false against current code: stored link still outranks MRP floating (po-so-coverage.ts:53-57); the flip is PR-4, owner-gated. The §7 table is the correct current statement.

# Module: MRP (finished-goods demand vs supply)

Per-module technical doc for the MRP engine — `computeMrp` in
`backend/src/scm/routes/mrp.ts` and everything that reads its allocation.
This is a TRADING-company MRP (no BOM explosion): demand = outstanding
Sales-Order lines, supply = on-hand stock + open PO lines, allocation =
greedy by delivery date. Pure calculator, recomputed on every read, NO
persistence and NO stored SO<->PO lock.

> Written 2026-08-01 with `fix/mrp-consistency-tails` (the pairing-audit tail
> fixes). Read `BUG-HISTORY.md` 2026-08-01 "MRP pairing-audit tails" and the
> detector `backend/scripts/audit-mrp-pairing.mjs` before changing allocation
> rules — the detector REPLICATES this engine and must move in lockstep.

---

## Decision (owner, 2026-08-06): soft until DO, hard from DO

Before a Delivery Order exists, ALL supply-demand matching belongs to the
floating MRP allocator — pooled by (warehouse, item_code, variant_key),
constrained by one-batch-per-SOFA-set (bedframes exempt), ordered by delivery
date then doc_no. Nothing persisted before the DO may bind execution:
`purchase_order_items.so_item_id` and the mig-0235 allocation sub-lines are
**procurement provenance** — they record why we bought, they are displayed and
audited, and they influence NO cap, NO batch expectation, NO coverage
precedence.

At DO creation the allocator decides binding **live** — including which incoming
PO batch a ship-before-arrival commits to — and records it on the DO line
(`committed_po_batch_no`, mig 0230). From that moment everything is anchored
history: committed batches, OUT movements, lot consumptions, COGS, delivered
attribution. Post-DO records are never recomputed from provenance, and
provenance is never "hardened" into them.

A stored-link-vs-delivered divergence is therefore NOT a defect; a double-SERVE
in the delivered ledger IS. Do not reintroduce the stored link into any
execution path — that is the pre-2026-08 model this decision retires, and the
parked branch `wip/harden-so-po-link-parked` (which hardens the MRP pick INTO
the link) is formally ABANDONED by this decision; do not resurrect it.

Rollout is staged (lenses/docs → DO-time live allocator → pooled caps →
display demotion); until every stage lands, the transitional guard remains:
rejecting an SO-revision follow-up auto-releases the PO to STOCK.



### Why — the owner's business case (2026-08-06, verbatim intent)

Customise moves from Make-to-Order to **Make-to-Stock**, possible because every
SKU now carries its variant identity — a PO can order spot stock against a
specific (SKU, variant), and an incoming SO simply gets allocated.

1. **Cheaper procurement** — order ahead in bulk, negotiate the supplier down.
2. **No dead-stock risk from mistakes** — a mis-ordered spec is not dead goods:
   clear the order and the PO's units re-assign to the next identical demand
   automatically.
3. **Automated matching** — no more CS hand-matching after a mistake; sell the
   identical thing and the SO auto-assigns on open, straight to READY.
4. **Delivery flexibility** — spot stock ships early when the customer wants
   it; a rush order takes from the pool and the next PO backfills.

Every surface must present this model: the execution chains (SO→DO→SI,
PO→GRN→PI) are anchored facts; every pre-DO PO↔SO pairing is floating and
visibly live — including the Relationship Map, which "会跳动" by design.

## 1. The one engine and its consumers

`computeMrp(sb, opts)` is called by every surface that answers "what covers
this line". They must all read the SAME allocation — that is the module's core
invariant (po-so-coverage.ts: "SO->PO and PO->SO can never disagree").

| Consumer | File | includeUndated | Reads |
|----------|------|----------------|-------|
| MRP page `GET /mrp` | `mrp.ts` route | query param, default **false** | `skus[]` + `sofaSets[]` (the plan) |
| SO drill-down Stock column | `mfg-sales-orders.ts` (2 call sites) | true | `mrpLineCoverage` (SO->PO) |
| PO / GRN / PI "Assigned SO" | `po-so-coverage.ts` (single + list) | true | `mrpReverseCoverage` (PO->SO) |
| Outstanding-SO shortage cap | `mfg-purchase-orders.ts` | true | per-line `shortageQty` |
| Reservations assigned/free | `inventory.ts` `/inventory/reservations` | true | `mrpStockAssignment` (stock side) |
| Procurement agent | `services/agents/procurement-agent.ts` | false | plan |
| CS agent | `services/agents/cs-agent.ts` | false | plan |

**`includeUndated` is DISPLAY-ONLY (since 2026-08-01, audit D6).** The
allocation always runs over the FULL active demand set; undated lines (no line
delivery date AND no SO delivery date) sort LAST, so they can only consume
supply the dated lines left behind — a dated line's coverage is identical
under both flag values. `false` merely omits undated rows/sets from the
output. Do NOT reintroduce the flag into the demand filter: that is exactly
the two-demand-sets divergence the audit caught.

## 2. Demand

- Source: `mfg_sales_order_items` (non-cancelled) joined `!inner` to its SO
  header. Status filter is pushed into SQL AND re-applied in JS via `SO_DONE`.
- `SO_DONE = DELIVERED, INVOICED, CLOSED, CANCELLED, DRAFT, SHIPPED` —
  SHIPPED added 2026-08-01 (audit D4) to match `so-stock-allocation.ts`, the
  reservations endpoint and the amendment terminal set. ON_HOLD still demands
  (owner call: a held order still drives purchasing).
- Effective qty per line = `qty - (delivered net of returns)` via
  `soDeliverableRemaining` (delivery-orders-mfg.ts) — DRAFT and CANCELLED DOs
  never count as delivered. `so-stock-allocation.ts` step 3 follows the same
  rule (aligned 2026-08-01, audit D5).
- SERVICE lines never create demand (`isServiceLine`).
- **The warehouse follows the SO**: a line's NULL `warehouse_id` is resolved
  from the SO header (`lib/so-warehouse.ts`) BEFORE bucketing, server-side, so
  every consumer sees one binding.

## 3. Supply

- On-hand: `inventory_balances` summed per bucket.
- Open PO lines: `qty - received_qty > 0` on a PO whose status is not in
  `PO_DEAD` (CANCELLED, DRAFT — a draft PO must never hide a real shortage).
  ETA = effective (latest revised) line date, else effective header date.
  Ship-to warehouse = line `warehouse_id` else header `purchase_location_id`.
- Ship-before-arrival commitments (mig 0230) are DEDUCTED from the PO pool and
  the same units ADDED BACK to on-hand — see the 4b block comment; the two
  always move together. Unreachable commitments surface as
  `unmatchedCommitments` (0 is the healthy reading).

## 4. Buckets and allocation

- Bucket key = `(warehouse | item_code | variant_key)` (`composite()`;
  `WH_NONE` for unresolved warehouse). Variant key via `computeVariantKey` —
  byte-identical to `inventory_balances.variant_key`.
- Order: delivery date ascending (nulls last), tie-break SO doc no. Stock
  first, then POs by earliest ETA, remainder = shortage.
- **Legacy `''` pool rule (R4 + audit D2)**: a real-variant bucket with NO PO
  supply of its own falls back to the same-warehouse empty-variant PO pool —
  a FALLBACK, never additive. Applies to the general path (section 7) AND the
  sofa path (section 8, since 2026-08-01). Known accepted limitation: two
  different variant buckets of one (warehouse, item) can each clone the same
  legacy pool (audit D-1 measures it; 0 live groups today).
- Sofa is grouped as per-SO-line SETS (section 8) drawing from the same pooled
  supply; set-level atomicity lives in `so-stock-allocation.ts` 7b (one
  covering batch or PENDING) and `ship-commitment.ts`, NOT here.

## 5. Failure modes — loud on purpose

| Error | Meaning |
|-------|---------|
| `mrp_load_failed: …` | Demand or PO-supply read errored. The PO read used to swallow this and plan with zero supply (phantom shortage rendered as truth) — it throws since 2026-08-01. |
| `mrp_load_truncated: …` | A read returned `MRP_LOAD_CAP` (5000) rows — the cap is full and the plan would silently ignore rows past it. Raise the cap or page the read; do NOT catch-and-continue. |
| lead-time load throws | `loadLeadTimeBase` — a swallowed error would zero every lead time (order-by = delivery date). |

Advisory consumers (SO drill-down, po-so-coverage, reservations) catch and
degrade to "no coverage shown"; the MRP page and the agents fail loudly.
Both reads carry deterministic `ORDER BY id` and push their status not-in
lists into SQL (quoted-list form, filter path = the embed alias — the idiom
so-delivery-sync.ts proved). A NULL-status header is dropped by `not.in`,
matching so-stock-allocation's own SQL.

## 6. The stock side — reservations assigned/free (audit D8)

`GET /inventory/reservations` (inventory.ts) merges TWO views per open lot:

- **Hard view**: READY SO lines claiming the lot. Sofa claims are locked to a
  batch (`allocated_batch_no`); every other category is a bucket-level
  QUANTITY claim (identity only fixed at DO time by FIFO). A batched lot sees
  its own batch's locked claims + the bucket's batchless claims; an unbatched
  lot sees the full bucket. (Before 2026-08-01 a batched non-sofa lot saw
  NOTHING and always rendered FREE.)
- **Floating view**: `mrpStockAssignment` spreads each bucket's MRP-assigned
  on-hand qty across its lots FIFO -> `assigned_qty` / `free_qty` /
  `mrp_assigned_to`. This is the dead-stock signal both frontends render.
- `status` = RESERVED when hard-claimed OR `assigned_qty > 0`; it can never
  contradict the same row's `assigned_qty`. Contract stays `RESERVED | FREE`
  (no PARTIAL — the exact split is on the qty fields).

Frontend pair (one logic layer): desktop `pages/scm-v2/Inventory.tsx`
(Reservations tab + Stock Breakdown drawer) and mobile
`mobile/MobileStockCard.tsx`, both through
`vendor/scm/lib/inventory-queries.ts` `buildStockBreakdown` /
`lotAssignedQty` / `lotFreeQty`.

## 7. Files

| File | Role |
|------|------|
| `backend/src/scm/routes/mrp.ts` | Engine + `/mrp` route + `mrpLineCoverage` / `mrpReverseCoverage` / `mrpStockAssignment` |
| `backend/src/scm/lib/so-stock-allocation.ts` | The SECOND walk — writes `stock_status` READY/PARTIAL/PENDING. Same statuses, same DRAFT-DO rule; keep them aligned. |
| `backend/src/scm/lib/ship-commitment.ts` | Commitment deduction/add-back contract (`applyCommittedSupply`) |
| `backend/src/scm/routes/po-so-coverage.ts` | PO->SO precedence (delivered lock > stored link > MRP floating) |
| `backend/scripts/audit-mrp-pairing.mjs` | Read-only production detector — a REPLICA of sections 1-8; update it in the same PR as any allocation-rule change. Section (H) (2026-08-02) additionally enforces the owner's purchasing rule: cancelled/DRAFT POs fully out of the formula, and no over-ordering beyond demand for MATTRESS/BEDFRAME/SOFA (only ACCESSORY may be bought for stock) — reported per PO document with reason codes (STOCK-SLICE / SO-DONE / BUCKET-SPLIT / NO-DEMAND) plus received-but-unowned dead stock per bucket |
| `backend/src/scm/routes/mrp.test.ts` | Unit tests: R4 legacy pool (general + sofa), D6 flag invariance, D4 SHIPPED, D3 truncation guard, stock assignment |

## 8. Traps

- The engine runs in a Worker behind PostgREST: unbounded selects clip at
  ~1000 rows with NO error. Every read here is either bounded-by-codes,
  chunked (`chunkIn`), or capped-with-a-loud-guard. Keep it that way.
- `companyId` is REQUIRED on `computeMrp` (typed `number | null | undefined`,
  key not optional) — see the #710/#712 incident comment at the signature.
- Status columns are ENUMS in Postgres — any raw SQL must `::text` before
  string ops (the detector documents the trap).
- One business rule, one home: `SO_DONE`-vs-allocation-status,
  DRAFT-DO-delivered, and the legacy-pool rule each drifted once already —
  that is precisely what the 2026-08-01 PR converged. If you change one copy,
  grep for its siblings (this guide's tables name them all).
