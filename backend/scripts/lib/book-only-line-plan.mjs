/* book-only-line-plan — which lines of an ERP-numbered delivery order or goods
 * receipt the account book still holds after the ERP removed them.
 *
 * docs/bugs/0902. A line moved off a delivery order onto a new one, while the
 * delivery order's rows carried no AutoCount key, never reached the book as a
 * removal: `retiredLineOf` names a deleted row by its key, and there was none.
 * The book kept the line AND the new document transferred its source again.
 *
 * Pure: the caller reads the book snapshot and the ERP; this decides. A book
 * line is RETIRED only when nothing on either side could still be it:
 *
 *   - no ERP row of the document carries its key, and every ERP row of the
 *     document carries SOME key — a keyless row might be this very line;
 *   - it still has a quantity (a zeroed line has already been retired);
 *   - nothing downstream holds it (an invoice line transferred from it);
 *   - the document exists in the ERP, is not cancelled there, and is not
 *     cancelled in the book.
 *
 * Every other unclaimed line is HELD, with the reason. A claimed line is not
 * reported at all.
 */

export const HELD_REASONS = Object.freeze({
  notInErp: "the ERP has no document with this number",
  erpCancelled: "the ERP document is cancelled",
  bookCancelled: "the book's document is cancelled",
  erpRowKeyless: "an ERP row of this document carries no AutoCount key, so it may be this line",
  downstream: "a later document in the book was transferred from this line",
});

/**
 * @param {Array<{ toDtlKey: number, itemCode: string, qty: number, transferredOn: number, cancelled: boolean }>} bookLines
 *   one document's lines, as the book snapshot holds them
 * @param {{ exists: boolean, cancelled: boolean, rowKeys: Array<number | null> }} erp
 *   the ERP document as it is now: one entry per row, its linked key or null
 */
export function planBookOnlyLines(bookLines, erp) {
  const claimed = new Set(erp.rowKeys.filter((k) => k != null).map(Number));
  const anyKeyless = erp.rowKeys.some((k) => k == null);
  const retire = [];
  const held = [];
  let alreadyZero = 0;
  for (const b of bookLines) {
    const key = Number(b.toDtlKey);
    if (claimed.has(key)) continue;
    const line = { dtlKey: key, itemCode: String(b.itemCode ?? ""), qty: Number(b.qty) };
    if (!(Number(b.qty) > 0)) { alreadyZero += 1; continue; }
    const reason = b.cancelled ? HELD_REASONS.bookCancelled
      : !erp.exists ? HELD_REASONS.notInErp
        : erp.cancelled ? HELD_REASONS.erpCancelled
          : Number(b.transferredOn) > 0 ? HELD_REASONS.downstream
            : anyKeyless ? HELD_REASONS.erpRowKeyless
              : null;
    if (reason) held.push({ ...line, reason });
    else retire.push(line);
  }
  return { retire, held, alreadyZero };
}
