/* ---------------------------------------------------------------------------
   ONE overlay, because the SO board and the drill-down are not allowed to hold
   two opinions — `docs/bugs/0269-*` was exactly that bug, and this is the same
   surface a second time.

   Since the SO detail deferred its MRP run to `GET /:docNo/coverage` (#2834),
   the base detail payload hard-codes the MRP-derived fields:
       coverage_po: null      coverage_eta: null      ready_source_pos: []
   They are filled by the follow-up coverage call. `SalesOrderDetailV2` makes
   that call; the LIST drill-down did not, so its "Incoming PO" column went
   permanently blank — chips 3 and 4 both come from those fields. Owner,
   2026-09-01: 「明明我的 PO No. 那边是有的，可是 Incoming PO 却没有」and then
   「你看回去 incoming PO 还是得显示的不是吗 之前说过了」. He is right, and the
   documented rule is `docs/modules/sales-order.md` §0.8 — that column hosts FOUR
   chips, not one.

   Extracted rather than copied: a second hand-written merge is how the two
   surfaces drift again. Callers pass their own line type through unchanged.
   --------------------------------------------------------------------------- */
import type { SoLineCoverage } from './sales-order-queries';

/** The fields the overlay writes. A caller's line type only has to be
 *  assignable to this — nothing else about it is known or touched. */
export type CoverageOverlayFields = {
  /** Optional on purpose: a line shape that does not carry an id cannot match a
   *  coverage row, and "no match" is already the leave-it-untouched answer. A
   *  required id would instead force every caller to widen its own line type. */
  id?: string;
  stock_state?: 'stock' | 'po' | 'shortage' | null;
  coverage_po?: string | null;
  coverage_eta?: string | null;
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: 'po' | 'adjustment' }>;
  stock_status?: string | null;
};

/**
 * Overlay live coverage onto lines, in place, keyed by line id.
 *
 * A line with NO coverage entry is returned UNTOUCHED — that is the fast first
 * paint and the older-backend 404, both of which must keep the detail's own
 * stored verdict rather than being blanked by an absent overlay.
 */
export function overlaySoLineCoverage<T extends CoverageOverlayFields>(
  lines: readonly T[],
  coverage: readonly SoLineCoverage[] | undefined,
): T[] {
  if (!coverage?.length) return lines as T[];
  const byId = new Map<string, SoLineCoverage>();
  for (const c of coverage) byId.set(c.id, c);
  return lines.map((l) => {
    const cov = l.id ? byId.get(l.id) : undefined;
    if (!cov) return l;
    return {
      ...l,
      stock_state: cov.stock_state,
      coverage_po: cov.coverage_po,
      coverage_eta: cov.coverage_eta,
      ready_source_pos: cov.ready_source_pos,
      stock_status: cov.stock_status_effective ?? l.stock_status,
    };
  });
}
