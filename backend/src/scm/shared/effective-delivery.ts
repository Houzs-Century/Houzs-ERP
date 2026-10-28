// ----------------------------------------------------------------------------
// effective-delivery — the ONE answer to "when is this due".
//
// TWO questions live here, one per direction of the book, and they are not the
// same question:
//
//   effectiveDelivery(...)    SUPPLY  — when will the supplier hand us the goods
//   effectiveSoDelivery(row)  DEMAND  — when must the goods reach the customer
//
// ── SUPPLY (PO) ─────────────────────────────────────────────────────────────
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
//
// Ported from 2990 packages/shared/src/effective-delivery.ts (migration 0180).
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

// ----------------------------------------------------------------------------
// DEMAND (Sales Order) — the effective delivery date of ONE SO LINE.
//
// OWNER, 2026-08-18: "我们都没有排产的,我们都不是 Production,我们应该只是送货的
// 日期而已." There is no factory queue in this business and nothing to schedule
// production against. There is ONE date that matters — when the goods must land
// — and every screen must plan on the same one.
//
// It did not. Before this function there were TWO chains for one fact:
//
//   the board / PO coverage / reservations / the delivery agents:
//        amended_delivery_date ?? customer_delivery_date          ← the amended one
//   MRP (routes/mrp.ts) and the stock allocator (lib/so-stock-allocation.ts):
//        line_delivery_date ?? customer_delivery_date             ← the ORIGINAL
//
// So a customer who rescheduled moved on the delivery board and did NOT move in
// the queue that decides who gets the scarce stock and what is ordered first.
// Two screens, two answers, and nobody was told. Measured on production
// 2026-08-18: company 2 had 3 live orders whose two dates disagree, by −58 to +7
// days; company 1 had none. Small population, large per-order shifts.
//
// THE CHAIN, in precedence order — and it is FOUR-DEEP FOR ONE REASON:
//
//   1. line_delivery_date, but ONLY when line_delivery_date_overridden = true.
//      A per-line date someone typed on purpose. This line ships on its own day.
//   2. amended_delivery_date — the reschedule Logistics confirmed. The header's
//      current promise.
//   3. customer_delivery_date — the customer's ORIGINAL promise. Never
//      overwritten (migration 0053, owner rule); the board's "Original" column
//      and the audit of what was sold are both this column, and unifying the
//      READ must not collapse the two stored facts.
//   4. line_delivery_date as a LAST RESORT, override flag or not.
//
// WHY THE OVERRIDE FLAG IS LOAD-BEARING, and the trap a header-only fix falls
// into. `line_delivery_date` is a MIRROR of the header date whenever the flag is
// false — migration 0172's `apply_so_header_followers` writes exactly that pair
// (`SET line_delivery_date = p_delivery_date, line_delivery_date_overridden =
// false`), and the SO screens re-derive it the same way (SalesOrderDetail.tsx:
// `?? (!it.line_delivery_date_overridden ? header.customer_delivery_date : null)`).
// A reschedule writes the HEADER's amended_delivery_date and never touches the
// lines, so on a rescheduled order the mirror still holds the ORIGINAL date.
// Reading `line_delivery_date` first without consulting the flag therefore keeps
// serving the pre-amendment date no matter what you do to the header fallback:
// on production 2026-08-18 all 5 live lines on the 3 moved orders were
// non-overridden mirrors still holding the stale date, so a header-only fix
// would have moved exactly ZERO of them.
//
// Step 4 exists so this function can never return FEWER dates than the chain it
// replaced. MRP treats a dateless line as "undated" and hides it; if some row
// somewhere carries a line date while its header carries none, dropping the
// mirror would delete that line from the visible plan. Step 4 costs nothing when
// the header has a date (it can't be reached) and prevents a silent regression
// when it doesn't.
//
// SNAKE_CASE AND camelCase ARE BOTH ACCEPTED because both spellings genuinely
// arrive: PostgREST hands back snake_case, and several callers already dual-read
// a camelCase variant (delivery-planning.ts:858 `r.amendedDeliveryDate ??
// r.amended_delivery_date`). One function that reads both beats ten call sites
// each remembering to.
// ----------------------------------------------------------------------------

/** A row carrying any of the SO delivery-date columns, in either spelling.
 *  Header-only callers simply omit the line fields. */
export type SoDeliveryDateRow = {
  customer_delivery_date?: string | Date | null;
  customerDeliveryDate?: string | Date | null;
  amended_delivery_date?: string | Date | null;
  amendedDeliveryDate?: string | Date | null;
  line_delivery_date?: string | Date | null;
  lineDeliveryDate?: string | Date | null;
  line_delivery_date_overridden?: boolean | null;
  lineDeliveryDateOverridden?: boolean | null;
};

/* Normalise to 'YYYY-MM-DD'. A `date` column arrives as that string over
   PostgREST (so this is the identity there), but the repair scripts drive the
   same allocator through a postgres shim that hands back Date OBJECTS — and
   `.localeCompare` on a Date threw mid-recompute in production on 2026-08-10.
   The Date branch is byte-identical to the `dateKey` helper that incident added
   to so-stock-allocation.ts, deliberately: this replaces that helper and must
   not quietly change what it answered. Empty string → null, matching
   effectiveDelivery above. */
function dayOf(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s === '' ? null : s.slice(0, 10);
}

/**
 * The effective delivery date for one SO line — the single answer to "when is
 * this due" that MRP, the stock allocator, the delivery board, PO coverage and
 * every other consumer share. Returns 'YYYY-MM-DD', or null when the order
 * carries no delivery date at all (genuinely undated demand).
 */
export function effectiveSoDelivery(row: SoDeliveryDateRow): string | null {
  const lineDate = dayOf(row.line_delivery_date ?? row.lineDeliveryDate);
  const overridden = row.line_delivery_date_overridden ?? row.lineDeliveryDateOverridden ?? false;
  if (overridden === true && lineDate !== null) return lineDate;      // 1. explicit per-line date
  return dayOf(row.amended_delivery_date ?? row.amendedDeliveryDate)  // 2. the reschedule
      ?? dayOf(row.customer_delivery_date ?? row.customerDeliveryDate) // 3. the original promise
      ?? lineDate;                                                     // 4. mirror, last resort
}
