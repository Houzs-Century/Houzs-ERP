// ----------------------------------------------------------------------------
// so-line-effective-stock — ONE per-line stock verdict, for every surface that
// shows the operator "is this line's stock here?".
//
// WHY THIS EXISTS. Two engines answer that question and neither consults the
// other:
//
//   stock_status  STORED on mfg_sales_order_items. Written ONLY by
//                 recomputeSoStockAllocation — per-warehouse, per-variant,
//                 FIFO, and it knows BOUND MODE (a line's own received PO
//                 covers it even when the pooled bucket cannot, which is the
//                 only way the AutoCount-migrated bedframes can ever read
//                 correctly, because that import carries no variant).
//   stock_state   COMPUTED per request from computeMrp. Pooled by SKU, knows
//                 incoming POs and ETAs, knows nothing about dye-lot batches
//                 or about a line's own dedicated receipt.
//
// So each one sees goods the other cannot, and the stored one additionally goes
// STALE (docs/modules/sales-order.md §0.3). Until 2026-08-17 the SO list rolled
// up the STORED value into `stock_remark` while the drill-down pill rendered
// the LIVE one, and the owner met the result on 2990-SO-2608-002: the list said
// `SHORT: MATTRESS` for a mattress that was standing in the warehouse, and the
// line he opened to check said the goods were in stock. Both cells are "the
// stock status" to him, and they were computed by two different engines.
//
// THE RULE IS NOT NEW. It is exactly what the drill-down pill has always
// rendered (`soLineStockPill`, frontend/src/components/SoSourceChips.tsx):
// READY when EITHER engine can see the goods. What is new is that the rule now
// has ONE home, on the server, and the list rolls up the same verdict the pill
// shows instead of a second opinion.
//
// A UNION, deliberately, and the direction matters. `stored READY + live
// shortage` keeps READY because the allocator's bound mode and the sofa
// batch-matcher are things MRP structurally cannot see. `stored PENDING + live
// stock` becomes READY because that is the stale-projection case, and the goods
// are physically there. Neither engine is trusted to VETO the other; a line is
// short only when both say so.
//
// FAIL-SOFT. `liveState: null` is "MRP had no opinion about this line" — no
// coverage row, or computeMrp failed and the caller passed an empty map. The
// stored value stands, which is the behaviour every surface had before this
// module existed.
// ----------------------------------------------------------------------------

/** What computeMrp says about a line, via mrpLineCoverage(). `null` = no
 *  verdict (line absent from the allocation, or MRP itself failed). */
export type LiveStockState = 'stock' | 'po' | 'shortage' | null;

/** The three values `mfg_sales_order_items.stock_status` holds — see
 *  docs/modules/sales-order.md §0.3. `summariseReadiness` treats anything that
 *  is not exactly 'READY' as not ready, so this type is the whole vocabulary a
 *  caller may emit. */
export type EffectiveStockStatus = 'READY' | 'PARTIAL' | 'PENDING';

/**
 * The verdict both the board column and the line pill answer from.
 *
 * BOTH PARAMETERS ARE REQUIRED, and `liveState` is `| null` rather than
 * optional on purpose (CLAUDE.md, "a parameter that DECIDES something"): a
 * caller with no MRP result must type the `null` and thereby say that the
 * stored value is standing alone. An optional parameter would let a new call
 * site silently keep the pre-2026-08-17 behaviour — which is the exact bug this
 * module was written to remove.
 */
export function effectiveLineStockStatus(
  storedStatus: string | null | undefined,
  liveState: LiveStockState,
): EffectiveStockStatus {
  const stored = (storedStatus ?? '').toUpperCase();
  if (liveState === 'stock' || stored === 'READY') return 'READY';
  if (stored === 'PARTIAL') return 'PARTIAL';
  return 'PENDING';
}
