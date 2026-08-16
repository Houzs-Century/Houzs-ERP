/* Request-body coercion for the fleet maintenance routes.
 *
 * WHY THESE ARE ONE MODULE, AND WHY THEY ARE TESTED. Each returns a
 * discriminated `{ ok: true, value } | { ok: false }`, and the whole point of
 * that shape is the distinction between the two ways a field can be "empty":
 *
 *   { ok: true, value: null }   the caller legitimately sent nothing — write NULL
 *   { ok: false }               the caller sent something INVALID — refuse, 400
 *
 * Collapse those two and a typo'd mileage silently becomes NULL on a
 * compliance row instead of a refusal the operator can see. They lived as
 * private functions inside a 2,100-line router with no test of any kind, which
 * is the combination the coverage ratchet calls out: a file that decides what
 * reaches the database, and nothing pinning it.
 *
 * The blank-is-null-not-invalid rule is deliberate and shared by all of them:
 * `null`, `undefined` and `""` all mean "not supplied". An HTML form posts `""`
 * for an untouched field, so treating `""` as invalid would refuse every save
 * that left an optional box alone.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `{ ok: true, value: null }` for every shape that means "not supplied". */
const blank = (v: unknown): boolean => v === null || v === undefined || v === '';

/** A YYYY-MM-DD prefix, or null when the value is absent or unparseable.
 *  Unlike `dateOrNull` this NEVER refuses — it is for READ paths shaping a row
 *  that is already in the database, where a bad stored value must not throw. */
export function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}

/** Plate numbers compare without whitespace and in upper case: `w a 1234 b`
 *  and `WA1234B` are the same lorry to a human, so they must be to us. */
export function normPlate(p: string | null | undefined): string {
  return (p ?? '').replace(/\s+/g, '').toUpperCase();
}

export function dateOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? { ok: true, value: s } : { ok: false };
}

/** A non-negative INTEGER (mileage, counts) or null. Rejects fractions —
 *  a mileage of 12.5 km is a typo, not a reading. */
export function intOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** A non-negative money (cents) or number, allowing null/blank. */
export function numOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** A finite float (e.g. GPS lat/lng) or null; no sign/range constraint. */
export function floatOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

/** An ISO timestamp string or null/blank. Stored as-is (Postgres parses it). */
export function tsOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const s = String(v);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return { ok: false };
  return { ok: true, value: s };
}

/** A JSON array of R2 keys (strings) or null. Rejects non-arrays.
 *  An array that is empty after trimming stores as NULL rather than `[]`:
 *  "no attachments" has one representation in this schema, not two. */
export function refsOrNull(v: unknown): { ok: true; value: string[] | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false };
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return { ok: true, value: out.length ? out : null };
}
