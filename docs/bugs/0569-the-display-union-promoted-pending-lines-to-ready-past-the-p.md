## The display union promoted PENDING lines to READY past the processing-date gate and hard binding [high]

**Symptom.** Owner, 2026-08-30, HC-SO-013367 (Moon Lim): "为什么它会显示
BedFrame ready，可是它的 PO 号码却是没有的？我们不是 hard binding 的吗？" and
"没有 processing date 的（就代表它还不需要货）…系统却会分配库存给它" — a
JAGER-(Q) bedframe line rendered READY with NO linked PO on an order with NO
processing date, and the same order's accessory lines lit "accessories Ready".

**Root cause (traced).** Two engines, one screen. The allocator's stored
`stock_status` was PENDING and CORRECT both times: the order is in `allocGated`
(no processing date → every line forced PENDING), and the bedframe's bucket
keys on the variant, which the migrated blank-variant stock can never match.
But `effectiveLineStockStatus` (so-line-effective-stock.ts) promoted stored
PENDING to READY whenever live MRP said `stock` — and `computeMrp` pools by SKU,
knowing nothing about the processing-date gate or hard binding, so 70
blank-variant JAGER units at KL read as "stock" for a line they cannot serve.
Observed: dispatched the recompute engine dry against the doc — "no line
changed — the projection already matches the allocator's own answer" — and
probed the live book directly (0 PO lines bound to SO-013367's lines), so both
engines agreed the line is PENDING; only the display union disagreed.

**Fix.** The promotion arm now takes a REQUIRED third argument
`gates: { orderProcessed, lineHardBound } | null` and fires only when the order
has a processing date AND the line is not hard-bound
(`isHardBoundLine` — bedframe / sofa / `(SP)` mattress — exported from
so-stock-allocation.ts so the engine and the display share one predicate).
Stored READY is never vetoed; `gates: null` fails strict (no promotion). Wired
through `GET /:docNo`, `GET /:docNo/items`, the list first-paint and the
list-mrp-enrichment path (its header read now carries `processing_date`).
Pinned in `backend/tests/soLineEffectiveStock.test.ts` ("the two promotion
gates" describe) and `soListMrpEnrichment.test.ts` (unprocessed order does not
promote) — proved RED on the unfixed tree: 6 failed before the lib change,
25/25 after.

**Ref.** fix/effective-status-honors-gates, 2026-08-30.
