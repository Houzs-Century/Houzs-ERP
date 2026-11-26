
export type SoListMrpEnrichment = {
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
