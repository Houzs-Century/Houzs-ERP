/* The deferred, MRP-derived half of a Sales-Order list row — fetched a beat
   after the list renders (GET /mfg-sales-orders/list-mrp-enrichment) and merged
   into the already-shown rows. ONE derivation, shared by the desktop list
   (pages/scm-v2/MfgSalesOrdersListV2.tsx) and the mobile Orders card
   (mobile/MobileSalesOrders.tsx): desktop and mobile are one product, so the
   overlay rule must be identical on both surfaces.

   WHY IT IS DEFERRED. Opening the list used to run a company-wide `computeMrp`
   on the critical path — the list's dominant cost. That engine fed FOUR
   visible fields, not just the READY PO chips: the desktop Stock Remark pill,
   the mobile readiness badge (is_main_ready), the mobile planning badge
   (planning_state), and the READY arm of the PO-No. chips. The list now paints
   immediately with the STORED-status placeholders each of those fields had
   before the 2026-08-17 MRP union, and this overlay heals them once the
   enrichment fetch lands. */

export type SoListMrpEnrichment = {
  /** READY-arm source-PO union. Merged (set union) with the SHIPPED chips the
   *  list already put on `source_po_union`. */
  sourcePoReady: string[];
  sourcePoAdj: boolean;
  stockRemark: string;
  isMainReady: boolean;
  planningState: string;
};

/** The subset of a list row this overlay reads/writes. Both surfaces' row types
 *  are structurally wider than this. */
export type EnrichableSoRow = {
  doc_no?: string;
  source_po_union?: string[] | null;
  source_po_adj?: boolean;
  stock_remark?: string;
  is_main_ready?: boolean | null;
  planning_state?: string | null;
};

/* C16 GUARD (Hookka frontend bug class: "a field that heals on one surface via
   enrichment but stays stored-only elsewhere"). This map is the SINGLE source of
   truth for WHICH SO-list row fields the deferred MRP enrichment heals, and
   which payload key supplies each. `applySoListMrpEnrichment` below writes
   EXACTLY these row keys and `soListEnrichment.test.ts` pins that — so a future
   dev who adds a new MRP-derived field to the list projection
   (`backend/src/scm/routes/mfg-sales-orders.ts`) without routing it through this
   overlay, or vice-versa, fails CI with the drifting key named. Its backend twin
   is `SO_LIST_MRP_ENRICHMENT_KEYS` (`backend/src/scm/lib/so-list-mrp-enrichment.ts`),
   which pins the endpoint's returned shape to the same set. */
export const MRP_DERIVED_LIST_FIELD_MAP = {
  source_po_union: 'sourcePoReady',
  source_po_adj: 'sourcePoAdj',
  stock_remark: 'stockRemark',
  is_main_ready: 'isMainReady',
  planning_state: 'planningState',
} as const satisfies Partial<Record<keyof EnrichableSoRow, keyof SoListMrpEnrichment>>;

export type MrpDerivedListField = keyof typeof MRP_DERIVED_LIST_FIELD_MAP;

/** The row-key set the overlay heals. Enforced exact by soListEnrichment.test.ts. */
export const MRP_DERIVED_LIST_FIELDS = Object.keys(MRP_DERIVED_LIST_FIELD_MAP) as MrpDerivedListField[];

/* The backend sorts a chip union with a numeric-aware locale compare
   (source-po-trace.ts). Re-sort the merged union the same way so the desktop
   cell's cap ("show 3, +N") picks the SAME first chips it did when the whole
   union was computed server-side — i.e. the healed cell is byte-identical to
   the old inline one, only a beat later. */
const chipCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

/**
 * Overlay one row's deferred enrichment. Behaviour-preserving:
 *  · `source_po_union` becomes the sorted set-union of the SHIPPED chips already
 *    on the row and the READY chips from the fetch — equal to the old combined
 *    union (set union is associative).
 *  · `source_po_adj` ORs the shipped-side flag with the READY-side flag.
 *  · `stock_remark` / `is_main_ready` / `planning_state` are REPLACED with the
 *    MRP-corrected values (the list's placeholders were stored-status only).
 * A row with no enrichment yet is returned unchanged (still showing placeholders).
 */
export function applySoListMrpEnrichment<T extends EnrichableSoRow>(
  row: T,
  e: SoListMrpEnrichment | undefined,
): T {
  if (!e) return row;
  const shipped = (row.source_po_union ?? []).filter(Boolean);
  const merged = [...new Set([...shipped, ...e.sourcePoReady.filter(Boolean)])].sort(chipCompare);
  return {
    ...row,
    source_po_union: merged,
    source_po_adj: Boolean(row.source_po_adj) || e.sourcePoAdj,
    stock_remark: e.stockRemark,
    is_main_ready: e.isMainReady,
    planning_state: e.planningState,
  };
}
