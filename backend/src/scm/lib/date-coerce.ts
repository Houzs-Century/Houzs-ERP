
/** `""` (or whitespace) becomes null; a real date passes through trimmed. */
export function dateOrNull(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/**
 * The value a PATCH LEAVES in a date column: the request's value when the
 * request names the key at all, else the stored one.
 *
 * The absent/present split is `=== undefined`, and that is the whole point.
 * Reading it as `typeof raw === 'string'` looks equivalent — an <input
 * type="date"> posts `""` — but the forms send a cleared date as JSON `null`
 * (`f.processingDate || null`), and `typeof null` is `'object'`. A clear then
 * read as "key absent, keep what is stored", so every rule judging the row this
 * save would leave behind judged the row it was replacing instead. Owner
 * 2026-08-31, HC-SO-013393: clearing both dates was refused for being unpaired,
 * while clearing only one was accepted and applied.
 *
 * Same coercion as `dateOrNull` on the value itself, so what the rules judge is
 * exactly what the write stores.
 */
export function effectiveDateAfterPatch(raw: unknown, stored: string | null): string | null {
  return raw === undefined ? stored : dateOrNull(raw);
}

export function normalizeEventDay(d: string | null | undefined): string {
  return (d ?? '').slice(0, 10);
}

const DATE_COLUMN_RE = /(^|_)dates?(_\d+)?($|_)|_at$|_expiry$|_birthday$/;

export function isDateColumn(column: string): boolean {
  if (/_pattern$/.test(column)) return false;
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
