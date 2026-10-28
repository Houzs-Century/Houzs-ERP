// ----------------------------------------------------------------------------
// stockMovementFilter — pure, client-side filter for the Stock Card MOVEMENTS
// ledger (owner 2026-09-18). Kept out of the component so the predicate is unit
// -testable on its own. Filters the already-loaded, per-SKU movement list; the
// caller precomputes the running balance over the FULL (unfiltered) history, so
// each surviving row keeps its true running balance.
// ----------------------------------------------------------------------------
import type { InventoryMovement } from '../../vendor/scm/lib/inventory-queries';

export type MovementType = InventoryMovement['movement_type'];

export interface MovementFilter {
  /** Allowed movement types; empty = every type. */
  types: readonly MovementType[];
  /** Restrict to one warehouse by id; null = every warehouse. */
  warehouseId: string | null;
  /** Inclusive lower bound on the movement date (YYYY-MM-DD); '' = no bound. */
  dateFrom: string;
  /** Inclusive upper bound on the movement date (YYYY-MM-DD); '' = no bound. */
  dateTo: string;
  /** Case-insensitive substring match on source_doc_no; '' = no filter. */
  sourceDoc: string;
}

export const EMPTY_MOVEMENT_FILTER: MovementFilter = {
  types: [],
  warehouseId: null,
  dateFrom: '',
  dateTo: '',
  sourceDoc: '',
};

export const isMovementFilterActive = (f: MovementFilter): boolean =>
  f.types.length > 0 ||
  f.warehouseId != null ||
  f.dateFrom !== '' ||
  f.dateTo !== '' ||
  f.sourceDoc.trim() !== '';

/** The movement's LOCAL calendar date as YYYY-MM-DD, matching what the WHEN
 *  column shows (which formats created_at in local time). '' for an unparseable
 *  timestamp — such a row then falls outside any date bound. */
export const movementDateKey = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
};

/** Fields the filter reads; a superset row (with runningBalance etc.) is fine. */
type FilterableMovement = Pick<
  InventoryMovement,
  'movement_type' | 'warehouse_id' | 'source_doc_no' | 'created_at'
>;

export function filterMovements<T extends FilterableMovement>(
  rows: readonly T[],
  f: MovementFilter,
): T[] {
  const typeSet = f.types.length > 0 ? new Set<MovementType>(f.types) : null;
  const term = f.sourceDoc.trim().toLowerCase();
  const from = f.dateFrom;
  const to = f.dateTo;
  return rows.filter((m) => {
    if (typeSet && !typeSet.has(m.movement_type)) return false;
    if (f.warehouseId != null && m.warehouse_id !== f.warehouseId) return false;
    if (from || to) {
      const key = movementDateKey(m.created_at);
      if (!key) return false;
      if (from && key < from) return false;
      if (to && key > to) return false;
    }
    if (term && !(m.source_doc_no ?? '').toLowerCase().includes(term)) return false;
    return true;
  });
}
