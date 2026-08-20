## An empty sales order was "ready to ship", because a gate over zero lines is vacuously true [high]

**Symptom** — 16 live sales orders sat in `READY_TO_SHIP` with nothing shippable
in them: no lines at all, or every line cancelled, or service-only. Delivery
Planning offered them for scheduling.

**Root cause** — the auto-advance gate asked `isMainReady`, which is "every MAIN
line is READY". Over an SO with no main lines that is a fold over an empty set:
**vacuously true**. So the emptier the order, the more certainly it passed.

Delivery Planning had already worked out the correct predicate and written it
INLINE, TWICE (`routes/delivery-planning.ts`). The two writers that actually
advance the header had neither copy:

- `recomputeSoStockAllocation` — the sweep that produced the 16;
- `PATCH /:docNo/items/:itemId/stock-status` — the manual READY toggle.

Three places, two of them right, and the two that decide were the wrong ones.

**Fix** — one home for the rule: `summariseReadiness.isShipReady`
(`lib/so-readiness.ts:123`) — `mainCount > 0 ? isMainReady : isFullyReady`,
where `isFullyReady` already requires at least one live line. All four consumers
read it; the two inline copies in `delivery-planning.ts` collapse into it, so
the change is a net simplification there.

**Self-healing, no data repair** — the regress arm reads the same predicate
(`lib/so-stock-allocation.ts:765`), so the 16 husks fall back to `CONFIRMED` on
the next sweep on their own. Their audit line now says *the order has no
stock-bearing lines — not ship-able* instead of a stock-re-allocation note that
described nothing that happened.

**Class** — *a fold over an empty set answering "yes"*. Same shape as a `.every()`
guard on an empty array, and the reason the file-size and coverage gates in this
repo refuse an empty scan rather than reporting it clean. Worth grepping for:
a readiness/completeness predicate that never asks whether the population is
non-empty.

**Ref** - `fix/ship-gate-empty-so-0814`, PR #2186, 2026-08-14
