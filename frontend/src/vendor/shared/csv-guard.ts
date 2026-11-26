
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

/** The cell text made safe to open in a spreadsheet. */
export function guardFormula(s: string): string {
  if (!FORMULA_START.test(s)) return s;
  if (/\d/.test(s) && PLAIN_NUMBER.test(s)) return s;
  return `'${s}`;
}

/** Inverse of `guardFormula`: strips the prefix only where the guard added it,
 *  so an exported sheet re-imports unchanged. */
export function unguardFormula(s: string): string {
  if (s.length < 2 || s[0] !== "'") return s;
  const inner = s.slice(1);
  return guardFormula(inner) === s ? inner : s;
}
