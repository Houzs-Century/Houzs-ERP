// ----------------------------------------------------------------------------
// effective-delivery — the "latest revised delivery date" helper.
//
// A PO header (and each PO line) carries a base delivery date plus up to three
// supplier revisions (supplier_delivery_date_2/3/4). The supplier only ever
// pushes the date BACK, so the date the supplier is actually committing to now
// is the MAX over all the non-null dates.
//
//   effectiveDelivery(base, d2, d3, d4) = max of the non-null inputs, else null
//
// Dates are ISO 'YYYY-MM-DD' strings (Postgres `date` columns). Lexical compare
// equals chronological compare for that format, so we compare as strings (no
// Date parsing / timezone drift). Empty strings are treated as null.
//
// IMPORTANT: this is a READ-side helper only. It does NOT change how the header
// `expected_at` (original earliest line date) or a line `delivery_date` are
// stored/recomputed — those keep their original meaning. Every reader that
// wants the latest committed date calls this.
// ----------------------------------------------------------------------------

/** The latest (max) of the non-null/non-empty date strings, or null if none. */
export function effectiveDelivery(
  ...dates: Array<string | null | undefined>
): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;              // null / undefined / '' → skip
    if (best === null || d > best) best = d;
  }
  return best;
}
