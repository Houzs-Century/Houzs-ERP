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
// ...EXCEPT THROUGH TWO GATES (2026-08-30, HC-SO-013367). The promotion arm is
// only trustworthy where the live verdict and the stored verdict answer the
// SAME question, and there are two places they do not:
//
//   1. An order with NO PROCESSING DATE. The allocator deliberately refuses to
//      allocate to it (`allocGated` → every line PENDING) — the owner's model
//      is "no processing date = the goods are not needed yet". MRP knows no
//      such gate, so its 'stock' answer on a gated order is not staleness, it
//      is a rule the display was overriding ("accessories Ready" on an order
//      with no dates).
//   2. A HARD-BOUND line (bedframe / sofa / (SP) special-order mattress —
//      `isHardBoundLine`, the allocator's own predicate). Those buckets key on
//      the VARIANT; MRP pools by SKU and is variant-blind, so its 'stock' can
//      be 70 blank-variant migrated units that this line's colour can never be
//      served from. JAGER-(Q) read READY with no processing date, no linked PO
//      and no matching stock — both gates were open.
//
// Stored READY is untouched by the gates: that is the engine's own verdict
// (bound mode included) and it is never vetoed here.
//
// FAIL-SOFT. `liveState: null` is "MRP had no opinion about this line" — no
// coverage row, or computeMrp failed and the caller passed an empty map. The
// stored value stands, which is the behaviour every surface had before this
// module existed. `gates: null` fails in the STRICT direction instead — a
// caller that cannot establish the context loses only the promotion arm, never
// the stored value.
// ----------------------------------------------------------------------------

import type { ReadinessLine } from './so-readiness';
import { isHardBoundLine } from './so-stock-allocation';

/** What computeMrp says about a line, via mrpLineCoverage(). `null` = no
 *  verdict (line absent from the allocation, or MRP itself failed). */
export type LiveStockState = 'stock' | 'po' | 'shortage' | null;

/** The three values `mfg_sales_order_items.stock_status` holds — see
 *  docs/modules/sales-order.md §0.3. `summariseReadiness` treats anything that
 *  is not exactly 'READY' as not ready, so this type is the whole vocabulary a
 *  caller may emit. */
export type EffectiveStockStatus = 'READY' | 'PARTIAL' | 'PENDING';

/** The context that decides whether the live-'stock' promotion may fire — see
 *  the two gates in the module header. `orderProcessed` = the order carries a
 *  processing date; `lineHardBound` = `isHardBoundLine(item_group, item_code)`. */
export type PromotionGates = { orderProcessed: boolean; lineHardBound: boolean };

/**
 * The verdict both the board column and the line pill answer from.
 *
 * ALL PARAMETERS ARE REQUIRED, and `liveState` / `gates` are `| null` rather
 * than optional on purpose (CLAUDE.md, "a parameter that DECIDES something"): a
 * caller with no MRP result must type the `null` and thereby say that the
 * stored value is standing alone, and a caller that cannot establish the gate
 * context must type the `null` and thereby forgo the promotion arm (the STRICT
 * direction). An optional parameter would let a new call site silently keep the
 * ungated 2026-08-17 behaviour — which is the exact bug class this module was
 * written to remove.
 */
export function effectiveLineStockStatus(
  storedStatus: string | null | undefined,
  liveState: LiveStockState,
  gates: PromotionGates | null,
): EffectiveStockStatus {
  const stored = (storedStatus ?? '').toUpperCase();
  if (stored === 'READY') return 'READY';
  if (liveState === 'stock' && gates !== null && gates.orderProcessed && !gates.lineHardBound) return 'READY';
  if (stored === 'PARTIAL') return 'PARTIAL';
  return 'PENDING';
}

/** One page of SO lines, grouped per document and already carrying the
 *  effective status, ready for `summariseReadiness`.
 *
 *  `coverage` is `mrpLineCoverage(...)`'s output, or `null` when the caller has
 *  no MRP result at all (computeMrp is best-effort in every handler that runs
 *  it). `null` is not "no coverage for this line" — it is "no MRP ran" — and
 *  both collapse to the same fail-soft answer: the stored value stands.
 *
 *  `processedDocs` is the set of doc_nos whose order carries a processing date
 *  (the first promotion gate; the second, hard binding, is derived from each
 *  row's own item_group/item_code). `null` = the caller cannot say — the strict
 *  direction: no line promotes on live 'stock'. */
export function readinessLinesByDoc(
  rows: Array<{
    id: string; doc_no: string; item_group: string | null;
    item_code: string | null; stock_status?: string | null; cancelled?: boolean | null;
  }>,
  coverage: Map<string, { source: string }> | null,
  processedDocs: ReadonlySet<string> | null,
): Map<string, ReadinessLine[]> {
  const out = new Map<string, ReadinessLine[]>();
  for (const r of rows) {
    const arr = out.get(r.doc_no) ?? [];
    arr.push({
      item_group: r.item_group,
      item_code: r.item_code,
      cancelled: r.cancelled ?? false,
      stock_status: effectiveLineStockStatus(
        r.stock_status ?? null,
        (coverage?.get(r.id)?.source ?? null) as LiveStockState,
        processedDocs === null ? null : {
          orderProcessed: processedDocs.has(r.doc_no),
          lineHardBound: isHardBoundLine(r.item_group, r.item_code),
        },
      ),
    });
    out.set(r.doc_no, arr);
  }
  return out;
}
