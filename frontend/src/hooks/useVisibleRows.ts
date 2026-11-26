// ----------------------------------------------------------------------------
// useVisibleRows — "what is the table actually showing?", for summary tiles.
//
// Owner 2026-08-12/13. A list page's stat cards summarise the rows the SERVER
// returned. The DataTable's per-column funnels are CLIENT-side and, since
// 2026-09-16, kept in in-visit memory (dataTableColFilterMemory): a funnel set
// this visit survives route changes but a fresh page load opens clean. A funnel
// active on screen still narrows the rows without touching those server totals,
// so a stat card and the visible rows can still disagree — which is what this
// hook exists to reconcile.
//
// What that cost on Purchase Orders: a stuck DATE funnel left 5 rows worth
// RM 9,112.50 on screen under a "Sum on this page" card reading RM 164,349.70 —
// the full 60. Two contradictory numbers on one screen, reported (reasonably) as
// "outstanding not tally", plus two POs reported missing when they were three
// rows below the filter.
//
// One hook rather than the same block pasted into four pages: the rationale
// lives once, and a page that adopts it cannot get the "is a funnel active"
// test subtly wrong.
//
// Usage:
//     const visible = useVisibleRows(rows);
//     <DataTable rows={rows} onFilteredRowsChange={visible.onFilteredRowsChange} … />
//     const money = useMemo(() => sum(visible.rows), [visible.rows]);
//     subtitle={visible.filtered ? "Filtered · …" : "Sum on this page"}
// ----------------------------------------------------------------------------

import { useCallback, useState } from 'react';

export type VisibleRows<T> = {
  onFilteredRowsChange: (rows: T[]) => void;
  rows: T[];
  filtered: boolean;
};

export function useVisibleRows<T>(rows: T[]): VisibleRows<T> {
  const [reported, setReported] = useState<T[] | null>(null);

  const onFilteredRowsChange = useCallback((next: T[]) => setReported(next), []);

  const filtered = reported !== null && reported.length !== rows.length;

  return { onFilteredRowsChange, rows: reported ?? rows, filtered };
}
