/* ac-gr-pair-grain — the AutoCount goods-receipt book, restated at the grain
 * the ERP is able to hold: one "document" per (receipt × purchase order) PAIR.
 *
 * WHY THE PAIR.  `scm.grns.purchase_order_id` is a SINGLE purchase order, while
 * an AutoCount receipt raises lines against several — 51 of the 214 in-scope
 * receipts do, one of them against 17. Comparing at RECEIPT grain would report
 * every one of those 51 as short by the part raised against another order, a
 * shortfall the ERP is structurally incapable of not having. The pair is the
 * finest grain both sides can state.
 *
 * ── WHY THIS FILE EXISTS (the bug it was cut out of) ────────────────────────
 * The BOOK side and the SCOPE were built by ONE filtered loop, so `headers` and
 * `scope` came out the same set — 400 and 400 — and the two categories that
 * exist to absorb a legitimate out-of-scope document, `absentOutOfScope` and
 * `outOfScopeMirrored`, were unreachable BY CONSTRUCTION. Every ERP pair
 * outside the population therefore fell through to `phantom`, which the
 * reconcile prints as "ERP claims a document the book does not have".
 *
 * On run 34148510412 (2026-09-07 01:40 +08) that printed 97 phantom goods
 * receipts. All 97 are in the book: the receipt is there, the (receipt → PO)
 * edge is there, and the only thing true of them is that the purchase order
 * sits outside `SCOPE.PO` (484 orders, against the 574 the ERP holds). The
 * sentence the reconcile printed was false — the book has every one of them.
 *
 * So the two are separated here, and they must stay separated:
 *
 *   view.headers   THE BOOK — every (receipt × PO) pair the book actually
 *                  states, 11,623 of them, scope playing no part. This is what
 *                  "does the book have this document?" is answered against, and
 *                  it is the same convention every other type already uses
 *                  (PO: 9,416 in the book, 484 in scope).
 *   scope          THE EXPECTED POPULATION — the in-scope subset, unchanged:
 *                  SCOPE.GR ∩ SCOPE.PO, both from lib/ac-scope.mjs so the pair
 *                  population cannot drift from the document population.
 *
 * A pair in `view` but not in `scope` that the ERP holds is "present though out
 * of scope" — reportable, not a gap, and NOT a phantom. Only a pair the book
 * genuinely does not state is a phantom.
 *
 * READ-ONLY and dependency-free: pure functions over a decoded snapshot.
 */

/**
 * @param {object} book   decodeSnapshot(snap) output
 * @param {{GR: Set<string>, PO: Set<string>}} SCOPE  buildScope(book) output
 */
export function grPairGrain(book, SCOPE) {
  const headers = new Map();
  const lines = new Map();
  const byDtlKey = new Map();
  const scope = new Set();

  /* Iterate the BOOK's own receipts, not the scope. A receipt qualifies for
     SCOPE.GR on having AT LEAST ONE line naming an in-scope purchase order, so
     scoping the loop would drop both the other orders on that same receipt and
     every receipt that is out of scope entirely — 11 of the first 20 pairs the
     old code called phantom were of that second kind. */
  for (const [gr, h] of book.GR.headers) {
    if (!h) continue;
    for (const l of book.GR.lines.get(gr) || []) {
      if (l.fromDocType !== "PO" || !l.fromDocNo) continue;
      const key = `${gr}|${l.fromDocNo}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(l);
      byDtlKey.set(l.dtlKey, l);
      /* The population, stated separately and only here. */
      if (SCOPE.GR.has(gr) && SCOPE.PO.has(l.fromDocNo)) scope.add(key);
    }
  }

  for (const [key, ls] of lines) {
    const h = book.GR.headers.get(key.slice(0, key.indexOf("|")));
    const sum = (f) => (ls.every((l) => l[f] == null) ? null : ls.reduce((s, l) => s + (l[f] ?? 0), 0));
    headers.set(key, {
      docNo: key,
      docDate: h.docDate,
      cancelled: h.cancelled,
      totalSen: sum("subTotalSen"),
      docTotalSen: sum("docSubTotalSen"),
      lineCount: ls.length,
      currency: h.currency,
      rate: h.rate,
    });
  }
  return { view: { headers, lines, byDtlKey, desc2: book.GR.desc2 }, scope };
}
