/* A delivery return line's quantity, read ONCE.
 *
 * The over-return cap and the insert used to read the same field two ways:
 * the cap counted a blank quantity as 0 (`?? 0`) while the insert wrote 1
 * (`?? 1`), and nothing required a positive number. A blank line slipped past
 * a fully-returned DO line and was stored as 1; a negative line lowered the
 * "already returned" sum and made room to return more than was delivered
 * (sister fix hookka-erp-testing #604).
 *
 * The rule: a return line's quantity is a finite number greater than 0.
 * Anything else (blank, null, 0, negative, text) is refused with a message, and
 * the one parsed number is what both the cap and the insert use.
 *
 * PURE. Mirrored byte-for-byte at frontend/src/vendor/shared
 * (return-line-qty.canonical.test.ts pins the two copies together). */
export function parseReturnLineQty(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const q = Number(raw);
  return Number.isFinite(q) && q > 0 ? q : null;
}

/** The message shown when a line's quantity is not valid. */
export function returnLineQtyMessage(itemCode: string | null | undefined, raw: unknown): string {
  const shown = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') ? 'blank' : String(raw);
  return `Return quantity must be more than 0 on every line (${itemCode || 'a line'} is ${shown}).`;
}
