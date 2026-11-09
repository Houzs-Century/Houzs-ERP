/* CSV formula injection (OWASP "CSV Injection"). Excel and Sheets run a cell
 * that starts with = + - @ TAB or CR as a formula, so a name typed as
 * =HYPERLINK(...) on the portal or the POS would execute on a staff PC when an
 * export is opened. Such a cell is prefixed with a single quote, which makes it
 * text. A plain number (-12.50, +3, -1,234.50) is left alone so a negative
 * amount still lands in Excel as a number.
 *
 * ONE home. backend/src/scm/shared/csv-guard.ts is the original and
 * frontend/src/vendor/shared/csv-guard.ts its byte-identical copy
 * (check-shared-mirrors.mjs): the backend's emailed POS summary CSV and every
 * frontend CSV export apply the same rule.
 */

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
