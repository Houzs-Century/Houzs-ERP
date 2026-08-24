/* Empty-string dates — the one coercion every request-body date write needs.
 *
 * An unfilled <input type="date"> posts `""`, and the house pattern for a write
 * is `(body.X as string) ?? null`. `??` is NULLISH: it catches undefined and
 * null and passes `""` straight through to a Postgres `date` / `timestamptz`
 * column, which rejects it — `invalid input syntax for type date: ""` — and
 * 500s the WHOLE save, not just that field. Confirmed in production 2026-08-17
 * on `PATCH /api/scm/mfg-purchase-orders/<id>` with supplierDeliveryDate2/3/4
 * sent as `""`: 500 `update_failed`; the same request with those keys null, or
 * omitted, returned 200. Staff saw "Save failed - The system hit a problem." on
 * every Purchase Order that left the optional Supplier Date 2/3/4 blank.
 *
 * `emptyDate()` in scm/routes/delivery-orders-mfg.ts was the only guard of this
 * shape in the backend; it is lifted here so every writer shares one rule, and
 * so the browser is not the thing standing between a blank date and a 500 (the
 * mobile app and any direct API caller bypass the web forms entirely).
 *
 * Three semantics this file is deliberate about:
 *   • `""` becomes NULL — it CLEARS the field. It never becomes today.
 *   • a key ABSENT from the body still means "leave the column alone"; that is
 *     the caller's `!== undefined` guard, and nothing here weakens it.
 *   • a site whose own fallback is `?? todayMyt()` keeps it. Those columns are
 *     the document's own NOT NULL date, where today is the only sane default —
 *     `dateOrNull(x) ?? todayMyt()` routes `""` down that same existing path
 *     instead of into Postgres.
 */

/** `""` (or whitespace) becomes null; a real date passes through trimmed. */
export function dateOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/* Which mapped column is a DATE, decided from the column NAME.
 *
 * The generic field-map loops (`for (const [from, to] of map) updates[to] =
 * body[from]`) are where this bug actually bit, and they move fifty columns at
 * a time — a hand-written list of date columns per route would be a list nobody
 * updates. The vocabulary below is not guesswork either: date-coerce.test.ts
 * re-derives the truth every run, reading every `date`/`timestamp` column out of
 * src/db/migrations-pg, intersecting it with the `[camel, snake]` pairs the
 * route files actually map, and failing if any of them is not recognised here.
 * A new date column that reaches a field map therefore fails a TEST rather than
 * 500ing a save in production.
 *
 * `_at` covers the timestamptz columns; the `date` token covers `po_date`,
 * `supplier_delivery_date_2` and `amend_date_from_customer` alike; `_expiry` and
 * `_birthday` are the fleet/customer columns that name a date without saying so.
 */
const DATE_COLUMN_RE = /(^|_)dates?(_\d+)?($|_)|_at$|_expiry$|_birthday$/;

export function isDateColumn(column: string): boolean {
  return DATE_COLUMN_RE.test(column);
}

/**
 * Null out every blank DATE column of an already-assembled insert/update row,
 * in place, and return it.
 *
 * Applied AFTER a field-map loop rather than inside it: one call then covers
 * every branch of that loop, including the ones a later edit adds. Only strings
 * are touched, and only on columns `isDateColumn` recognises, so a text column
 * that legitimately stores `""` is left exactly as it was.
 */
export function coerceEmptyDates<T extends Record<string, unknown>>(row: T): T {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (typeof v === 'string' && v.trim() === '' && isDateColumn(key)) {
      (row as Record<string, unknown>)[key] = null;
    }
  }
  return row;
}
