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

/**
 * TIER 3 — the CONSOLIDATED purchase order. One PO is raised to the supplier
 * covering SEVERAL customers' orders at once (routine for mattresses), so its
 * note names N Sales Orders and each line belongs to a different one.
 *
 * The rule does NOT change: it widens. Instead of asking "is this code unique
 * within ONE order", it asks "is this code unique across the WHOLE named set" —
 * every free line of every named SO pooled into one candidate list, then the
 * same 1:1 test. If exactly one unlinked PO line and exactly one free SO line
 * in the pool carry the code, which line served which order is DETERMINED, not
 * guessed: no other named order can absorb it. If two of the named orders both
 * still want that code, it is a coin flip and is refused, exactly as before.
 *
 * Quantity is deliberately NOT a discriminator. Pairing "qty 3 with qty 3"
 * where two candidates share a code is an inference about intent, and a wrong
 * inference stamped into so_item_id is indistinguishable from a fact
 * afterwards. Quantities are carried through for the human report only.
 *
 * soLineGroups: [{ doc, lines: [{ id, item_code, qty? }] }] — one entry per SO
 *               named in the note, already scoped to the PO's company.
 *
 * Returns the same shape as pairPoLinesToSoLines, plus:
 *   pairs[].soDoc      which of the named orders the SO line belongs to
 *   ambiguous[].soDocs which of them still offer a free line of that code
 */
export function pairPoLinesAcrossSos(poLines, soLineGroups, takenSoIds = new Set()) {
  const docOfSoLine = new Map();
  const pooled = [];
  for (const g of soLineGroups) {
    for (const l of g.lines) {
      if (docOfSoLine.has(l.id)) continue; // one SO line belongs to one order
      docOfSoLine.set(l.id, g.doc);
      pooled.push(l);
    }
  }
  const res = pairPoLinesToSoLines(poLines, pooled, takenSoIds);

  // Which of the named orders still offer a free line of a code — the readable
  // half of a refusal, so a human sees WHERE the contention is.
  const docsByCode = new Map();
  for (const l of pooled) {
    if (takenSoIds.has(l.id)) continue;
    const code = (l.item_code ?? "").trim();
    if (!code) continue;
    const s = docsByCode.get(code) ?? new Set();
    s.add(docOfSoLine.get(l.id));
    docsByCode.set(code, s);
  }

  return {
    ...res,
    pairs: res.pairs.map((p) => ({ ...p, soDoc: docOfSoLine.get(p.soLineId) ?? null })),
    ambiguous: res.ambiguous.map((a) => ({ ...a, soDocs: [...(docsByCode.get(a.code) ?? [])] })),
  };
}
