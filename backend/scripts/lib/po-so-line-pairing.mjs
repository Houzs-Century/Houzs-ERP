// PURE line-pairing rule shared by link-po-to-so.mjs (one PO, by hand) and
// backfill-po-so-item-links.mjs (every provable PO, in bulk). Extracted rather
// than copied so the two can never drift into disagreeing about what counts as
// a provable link.
//
// THE RULE. A PO line is bound to an SO line only when the item code is
// unambiguous on BOTH sides: exactly one still-unlinked PO line carries the
// code, and exactly one still-free SO line carries it. Two PO lines of the same
// code, or two SO lines of the same code, means the database does not record
// WHICH line served WHICH — so the pairing is a guess, and a guess stamped into
// purchase_order_items.so_item_id is indistinguishable from a fact afterwards.
// Ambiguous codes are reported and skipped, never guessed.

/** Group rows by their item code, ignoring blanks. */
function byCode(rows) {
  const m = new Map();
  for (const r of rows) {
    const code = (r.item_code ?? "").trim();
    if (!code) continue;
    const arr = m.get(code) ?? [];
    arr.push(r);
    m.set(code, arr);
  }
  return m;
}

/**
 * poLines:  [{ id, item_code, so_item_id }]  — the PO's lines, linked or not.
 * soLines:  [{ id, item_code }]              — the candidate SO's active lines.
 * takenSoIds: Set of so_item_id values already pointed at by SOME PO line
 *             (including lines of other POs), so one SO line is never
 *             double-claimed.
 *
 * Returns { pairs, ambiguous, alreadyLinked, unmatched }:
 *   pairs         [{ poLineId, soLineId, code }] — safe to write
 *   ambiguous     [{ code, unlinkedPoLines, freeSoLines }] — reported, not written
 *   alreadyLinked count of PO lines that already carry a so_item_id
 *   unmatched     codes on unlinked PO lines with NO free SO line at all
 */
export function pairPoLinesToSoLines(poLines, soLines, takenSoIds = new Set()) {
  const alreadyLinked = poLines.filter((l) => l.so_item_id).length;
  const poByCode = byCode(poLines.filter((l) => !l.so_item_id));
  const soByCode = byCode(soLines.filter((l) => !takenSoIds.has(l.id)));

  const pairs = [];
  const ambiguous = [];
  const unmatched = [];
  for (const [code, pos] of poByCode.entries()) {
    const sos = soByCode.get(code) ?? [];
    if (pos.length === 1 && sos.length === 1) {
      pairs.push({ poLineId: pos[0].id, soLineId: sos[0].id, code });
    } else if (sos.length === 0) {
      unmatched.push({ code, unlinkedPoLines: pos.length, freeSoLines: 0 });
    } else {
      ambiguous.push({ code, unlinkedPoLines: pos.length, freeSoLines: sos.length });
    }
  }
  return { pairs, ambiguous, alreadyLinked, unmatched };
}
