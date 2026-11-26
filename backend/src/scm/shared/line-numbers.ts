
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
