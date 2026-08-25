## MRP offered another order's batch-locked sofa unit and hid the real shortage [high]

<!-- area: Sofa, fabric, variants -->

**Symptom.** Prod, 2990, found 2026-08-24 on SO-2607-019 vs SO-2608-006 (XAMMAR
EZ-001 / SEAT28 / LEG6"). The sofa-set allocator had whole-set allocated -006's
L(LHF)+2A(RHF) from batch 2990-PO-2608-006 (`allocated_batch_no` stamped,
stock_status READY). MRP showed the opposite: -019 (earlier delivery) read its
2A(RHF) as covered by "stock" while -006's read SHORT. Both wrong operationally
— the DO ship-gate would never release that unit to -019, and -006's unit was
never in danger. Worse, the From-SO picker (same coverage) reported -019's RHF
shortage 0 so the line that needed ordering could not be picked, and the
suggested 1A(LHF)-only PO could never make -019 READY: no single batch would
ever hold both its modules (RHF in the old batch, LHF in the new). A deadlock,
not a display bug.

**Root cause (traced).** Two engines, two answers to "whose unit is this".
`so-stock-allocation.ts` + `sofa-set-coverage.ts` are batch-strict (whole set
from ONE batch, lock persisted as `mfg_sales_order_items.allocated_batch_no`,
enforced by the DO ship-gate). `computeMrp` (routes/mrp.ts sections 7/8) was
batch-blind: pooled greedy by delivery date over `inventory_balances` per
(warehouse, item_code, variant_key) — `Math.min(stockLeft, need)` per line,
earliest date first. The lock lives only on the SO line, not in the ledger (no
OUT movement until ship), so the pooled walk could not see it and handed the
claimed unit to whichever SO sorted first. Section 4b already carves out ship
commitments (`applyCommittedSupply`); batch claims had no such carve.

**Fix.** `lib/batch-claimed-stock.ts` (pure, no DB): `collectBatchClaims` folds
demand lines with `allocated_batch_no` into per-line + per-bucket claims sized
by remaining qty; `openBucketStock` splits each bucket's on-hand into a claim
RESERVE (capped by what is actually on hand, so a stale claim degrades
gracefully) and the FREE pool; `drawBucketStock` serves a claiming line from
its own reserve first, byte-compatible with the old `Math.min` for unclaimed
lines (including the negative-balance tax on the first walker). mrp.ts section
4c collects the claims; sections 7 and 8 swap the bare `Math.min` for the
split draw. The From-SO picker and every other computeMrp consumer (SO
drill-down, PO Assigned-SO, snapshot) inherit the carve — one allocation, all
readers. Pinned by `tests/mrpBatchClaimedStock.test.ts` (the two-SO scenario
through the exact functions the walks call: the earlier SO now draws 0 and
goes SHORT on both modules, the claiming SO keeps its units); on the pre-fix
walk the same scenario gives the inverted answer the test forbids.

**Ref.** fix/mrp-batch-claim-aware-0824, 2026-08-25.
