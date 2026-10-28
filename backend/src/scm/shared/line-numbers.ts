/* Client-supplied qty / money coercion for document line writes.
 *
 * WHY THIS EXISTS — the `Math.max(0, ...)` clamp these call sites already carry
 * does NOT stop a non-finite value. `Number("abc")` is NaN, and `Math.max(0, NaN)`
 * is NaN, not 0: the clamp was written to keep a discount from driving a line
 * total negative, and it was mistaken for input validation it never performed.
 * A NaN then persists straight into an INTEGER SEN column and poisons every
 * total computed from it — and NaN compares false against everything, so the
 * damage reads as a blank or an absurd figure rather than an error.
 *
 * The sibling HOOKKA ERP fixed exactly this class (unguarded `Number(...)` on PO
 * and PI line inputs) in its 2026-06-19 cross-audit against this codebase's
 * ancestor; this is the same hole, still open on this side.
 *
 * SCOPE, deliberately narrow: this rejects only values that are NOT FINITE.
 * It does NOT take a position on negative qty or price — several line paths
 * accept negatives today and whether that is legitimate is a business question,
 * not a correctness one. Widening this to a sign check needs the owner's word.
 */

export type LineNumberSpec = Record<string, { value: unknown; fallback?: number }>;

export type LineNumberResult =
  | { ok: true; nums: Record<string, number> }
  | { ok: false; invalid: string[] };

/**
 * Coerce a set of named line fields to finite numbers.
 *
 * A field that is `undefined` or `null` falls back (default 0) — absent means
 * "not supplied", which is a different thing from "supplied as garbage" and the
 * call sites already rely on that distinction for partial line PATCHes.
 * Anything that coerces to NaN or +/-Infinity is reported instead of persisted.
 */
export function parseLineNumbers(spec: LineNumberSpec): LineNumberResult {
  const nums: Record<string, number> = {};
  const invalid: string[] = [];
  for (const [name, { value, fallback = 0 }] of Object.entries(spec)) {
    const n = value === undefined || value === null ? fallback : Number(value);
    if (Number.isFinite(n)) nums[name] = n;
    else invalid.push(name);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, nums };
}

/** Plain-language 400 body for a rejected line, per the house error rule. */
export function invalidLineNumberBody(invalid: string[]): {
  error: string;
  reason: string;
  fields: string[];
} {
  return {
    error: 'invalid_line_number',
    reason: `These line fields must be numbers: ${invalid.join(', ')}.`,
    fields: invalid,
  };
}
