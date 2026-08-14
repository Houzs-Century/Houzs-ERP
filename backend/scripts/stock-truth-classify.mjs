// The one piece of judgement in the stock-balance comparison, isolated so it can
// be tested without a database.
//
// THE PROBLEM IT SOLVES. AutoCount is still the live book. It keeps issuing stock
// after the ERP's opening balance was taken, and the ERP — which has posted no
// outbound movement at all — cannot know about any of it. So the raw difference
// between the two systems GROWS EVERY DAY on its own, and a verdict keyed to it
// reads DIVERGES forever. Measured against production on 2026-08-11: 33 of 35
// ERP-HIGHER cells reconciled to AutoCount's own movement since the cutover, to
// the unit. Only 2 did not, and those 2 are the entire real signal.
//
// THE TEST IS EXACT, NEVER A TOLERANCE. `delta === moved` means every single unit
// of the difference is accounted for by AutoCount's own books, measured against
// the frozen opening-balance snapshot the ERP was actually opened with. A
// tolerance would hide precisely the small, real divergence this check exists to
// find — and a cell that is quietly forgiven is worse than one that is loud,
// because nobody ever looks at it again.
//
// It is also deliberately ONE-SIDED in the conservative direction: anything the
// baseline cannot account for stays UNEXPLAINED, including a cell the baseline
// has no row for at all. Unknown is never treated as fine.

/**
 * @param {{ delta:number, ac:number }} row  divergent cell; delta = ERP - AutoCount(now)
 * @param {{ qty:number } | null | undefined} baseline  same cell in the frozen cutover snapshot
 */
export function explainDivergence(row, baseline) {
  if (!baseline) {
    // No opening-balance row for this cell: nothing to reconcile against, so the
    // difference is unaccounted for by definition.
    return { explained: false, movedSinceCutover: null, unaccounted: row.delta };
  }
  const moved = baseline.qty - row.ac;      // what AutoCount issued since the cutover
  return {
    explained: row.delta !== 0 && row.delta === moved,
    movedSinceCutover: moved,
    unaccounted: row.delta - moved,
  };
}
