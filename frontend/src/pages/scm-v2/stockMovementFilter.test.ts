/* The Stock Card movements filter (owner 2026-09-18). The predicate lives apart
 * from the component so the AND-composition of Type / Warehouse / Date range /
 * Source doc is provable without mounting a page. Timestamps use MIDDAY UTC so
 * the local-date derivation lands on the same calendar day in any CI timezone.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MOVEMENT_FILTER,
  filterMovements,
  isMovementFilterActive,
  movementDateKey,
  type MovementFilter,
} from './stockMovementFilter';

type Row = {
  id: string;
  movement_type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'TRANSFER';
  warehouse_id: string;
  source_doc_no: string | null;
  created_at: string;
};

const ROWS: Row[] = [
  { id: 'a', movement_type: 'IN', warehouse_id: 'kl', source_doc_no: 'HC-GRN-0001', created_at: '2026-08-01T12:00:00Z' },
  { id: 'b', movement_type: 'OUT', warehouse_id: 'pg', source_doc_no: 'HC-DO-0007', created_at: '2026-08-10T12:00:00Z' },
  { id: 'c', movement_type: 'ADJUSTMENT', warehouse_id: 'kl', source_doc_no: null, created_at: '2026-08-20T12:00:00Z' },
  { id: 'd', movement_type: 'IN', warehouse_id: 'pg', source_doc_no: 'AC-BAL-0003', created_at: '2026-09-01T12:00:00Z' },
];

const filter = (patch: Partial<MovementFilter>): MovementFilter => ({ ...EMPTY_MOVEMENT_FILTER, ...patch });
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('filterMovements', () => {
  it('returns everything when the filter is empty', () => {
    expect(ids(filterMovements(ROWS, EMPTY_MOVEMENT_FILTER))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps only the selected types (multi-select is OR within Type)', () => {
    expect(ids(filterMovements(ROWS, filter({ types: ['IN'] })))).toEqual(['a', 'd']);
    expect(ids(filterMovements(ROWS, filter({ types: ['IN', 'ADJUSTMENT'] })))).toEqual(['a', 'c', 'd']);
  });

  it('filters by warehouse id', () => {
    expect(ids(filterMovements(ROWS, filter({ warehouseId: 'kl' })))).toEqual(['a', 'c']);
  });

  it('applies an inclusive date range on the WHEN column', () => {
    expect(ids(filterMovements(ROWS, filter({ dateFrom: '2026-08-10', dateTo: '2026-08-20' })))).toEqual(['b', 'c']);
    expect(ids(filterMovements(ROWS, filter({ dateFrom: '2026-09-01' })))).toEqual(['d']);
    expect(ids(filterMovements(ROWS, filter({ dateTo: '2026-08-01' })))).toEqual(['a']);
  });

  it('matches Source doc case-insensitively and excludes rows with no doc', () => {
    expect(ids(filterMovements(ROWS, filter({ sourceDoc: 'hc-do' })))).toEqual(['b']);
    expect(ids(filterMovements(ROWS, filter({ sourceDoc: 'HC-' })))).toEqual(['a', 'b']);
    expect(ids(filterMovements(ROWS, filter({ sourceDoc: 'bal' })))).toEqual(['d']);
    // A source-doc term never matches an ADJUSTMENT with a null doc.
    expect(ids(filterMovements(ROWS, filter({ sourceDoc: 'x' })))).toEqual([]);
  });

  it('composes every dimension with AND', () => {
    const f = filter({ types: ['IN'], warehouseId: 'pg', dateFrom: '2026-08-15', sourceDoc: 'ac' });
    expect(ids(filterMovements(ROWS, f))).toEqual(['d']);
  });

  it('does not mutate the input array', () => {
    const copy = [...ROWS];
    filterMovements(ROWS, filter({ types: ['IN'] }));
    expect(ROWS).toEqual(copy);
  });
});

describe('isMovementFilterActive', () => {
  it('is false for the empty filter and true once any dimension is set', () => {
    expect(isMovementFilterActive(EMPTY_MOVEMENT_FILTER)).toBe(false);
    expect(isMovementFilterActive(filter({ types: ['IN'] }))).toBe(true);
    expect(isMovementFilterActive(filter({ warehouseId: 'kl' }))).toBe(true);
    expect(isMovementFilterActive(filter({ dateFrom: '2026-08-01' }))).toBe(true);
    expect(isMovementFilterActive(filter({ dateTo: '2026-08-01' }))).toBe(true);
    expect(isMovementFilterActive(filter({ sourceDoc: '  ' }))).toBe(false);
    expect(isMovementFilterActive(filter({ sourceDoc: 'HC' }))).toBe(true);
  });
});

describe('movementDateKey', () => {
  it('is empty for null or an unparseable timestamp', () => {
    expect(movementDateKey(null)).toBe('');
    expect(movementDateKey('not-a-date')).toBe('');
  });
});
