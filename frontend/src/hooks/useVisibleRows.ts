// ----------------------------------------------------------------------------
// useVisibleRows — "what is the table actually showing?", for summary tiles.
//
// Owner 2026-08-12/13. A list page's stat cards summarise the rows the SERVER
// returned. The DataTable's per-column funnels are CLIENT-side and persisted per
// user (`dt:filters:*`, owner 2026-07-29 — "filters kept resetting on reload"),
// so a filter set once survives every reload and stops reading as a filter. It
// just reads as a broken list.
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
  /** Pass to DataTable/DataGrid `onFilteredRowsChange`. Stable across renders. */
  onFilteredRowsChange: (rows: T[]) => void;
  /** The rows on screen — the table's filtered set, or `rows` before the table
   *  has reported (first paint, or a caller that never wires the callback). */
  rows: T[];
  /** True while a column funnel is hiding part of the page. Drives the
   *  "Filtered" wording, and tells a COUNT tile to stop showing the server's
   *  full-match total — that number is right until a client-side funnel hides
   *  part of the page, at which point it contradicts the table beneath it. */
  filtered: boolean;
};

export function useVisibleRows<T>(rows: T[]): VisibleRows<T> {
  /* null = the table has not reported yet. Distinct from [] (a funnel that
     matched nothing), which must show a genuine zero rather than fall back to
     the unfiltered page. */
  const [reported, setReported] = useState<T[] | null>(null);

  /* Stable identity — DataTable publishes from an effect keyed on this callback,
     so a fresh function each render would re-fire it every render. */
  const onFilteredRowsChange = useCallback((next: T[]) => setReported(next), []);

  /* Length, not reference: the table hands back a NEW array each time it
     recomputes (sort, re-fetch), so a reference check would read "filtered" on
     every incidental re-render. A funnel that happens to keep every row is
     indistinguishable from no funnel — and correctly so, since the tiles and the
     table then agree either way. */
  const filtered = reported !== null && reported.length !== rows.length;

  return { onFilteredRowsChange, rows: reported ?? rows, filtered };
}
