/**
 * CAN ONE PAIR OF BOOK LINES BE PAIRED AT COMPARTMENT GRAIN?
 *
 * The book records the SO -> PO edge at LINE grain (`PODTL.FromSODtlKey`), and
 * `repair-po-so-link-from-book.mjs` copies it — refusing whenever either key
 * resolves to more than one ERP row, because a Map keyed by DtlKey would keep
 * one of them. Every sofa is in that bucket by construction: one book line, one
 * ERP row per compartment.
 *
 * This is the question at the other grain: inside ONE pair of book lines, does
 * every item code appear exactly once on each side? Where it does, each purchase
 * compartment has exactly one sales compartment of the same product to be, and
 * the pairing is a copy plus an exact identity match — not a choice.
 *
 * ── WHY THIS IS A SHARED MODULE AND NOT TWO COPIES ──────────────────────────
 * It was two copies for about twenty minutes on 2026-09-08 and they disagreed
 * on production, minutes apart, about `HC-PO-010040 <- SO-012277`:
 *
 *   probe run 34204007759   "the two sides hold a different NUMBER of rows"
 *   repair run 34203858897  PROVABLE, 2 rows
 *
 * The cause is the POPULATION each one tallied, and it is the whole reason this
 * function takes both lists explicitly. The probe tallied only the purchase rows
 * that are still UNLINKED, so a pair with three compartments — one of them
 * already dedicated — read as 2 against 3. The repair tallied every purchase row
 * carrying the key, so it read 3 against 3 and could see that the two ends match.
 *
 * **The repair's reading is the correct one**, and the reason is not a
 * preference: the question "can these two book lines be paired" is about the
 * WHOLE pair. A compartment somebody already dedicated still occupies its sales
 * row, and leaving it out of the tally both under-counts the purchase side and
 * hides the row that would collide. `alreadyTaken` below is what makes that
 * safe, and it can only fire if the linked rows are in the input.
 *
 * So: pass EVERY ERP row carrying each key, linked or not. The caller decides
 * which of the returned pairings it still needs to write.
 */

/** Item codes compared the way a human reads them. Byte-identical to the
 *  normaliser `repair-po-so-link-from-book.mjs` uses, deliberately: three tools
 *  on one edge must not disagree about what "the same product" means. */
export const normCode = (s) => (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

const tally = (rows, codeOf) => {
  const m = new Map();
  for (const r of rows) m.set(normCode(codeOf(r)), (m.get(normCode(codeOf(r))) ?? 0) + 1);
  return m;
};

/**
 * @typedef {object} PairVerdict
 * @property {"provable"|"duplicateCode"|"differentProducts"|"countsDiffer"} verdict
 * @property {Array<{po: any, so: any}>} pairs  every purchase row with the sales
 *   row of the same product; empty unless the verdict is `provable`
 * @property {string} why one line, for the operator's log
 *
 * Judge ONE pair of book lines.
 *
 * @param {any[]} poRows EVERY ERP purchase row carrying the book purchase line's
 *   key — including rows that already carry a sales link. See the note above:
 *   omitting them is what made two tools disagree.
 * @param {any[]} soRows EVERY ERP sales row carrying the book sales line's key.
 * @param {(r:any)=>unknown} [codeOf] how to read a row's item code
 * @returns {PairVerdict}
 */
export function judgeCompartmentPair(poRows, soRows, codeOf = (r) => r.item_code) {
  const po = Array.isArray(poRows) ? poRows : [];
  const so = Array.isArray(soRows) ? soRows : [];
  const pT = tally(po, codeOf), sT = tally(so, codeOf);

  const dup = [...pT].filter(([, n]) => n > 1).map(([c]) => c)
    .concat([...sT].filter(([, n]) => n > 1).map(([c]) => c));
  if (dup.length) {
    return { verdict: "duplicateCode", pairs: [],
      why: `${[...new Set(dup)].join(", ")} appears more than once on one side - which row is which is a coin flip` };
  }
  const onlyPo = [...pT.keys()].filter((c) => !sT.has(c));
  const onlySo = [...sT.keys()].filter((c) => !pT.has(c));
  if (onlyPo.length || onlySo.length) {
    return { verdict: "differentProducts", pairs: [],
      why: `the purchase side carries ${onlyPo.join(", ") || "(nothing extra)"} and the sales side carries `
        + `${onlySo.join(", ") || "(nothing extra)"} - a BUILD disagreement, not a link one; it needs the drawing` };
  }
  if (po.length !== so.length) {
    return { verdict: "countsDiffer", pairs: [],
      why: `${po.length} purchase row(s) against ${so.length} sales row(s)` };
  }
  const pairs = po.map((p) => ({ p, s: so.find((x) => normCode(codeOf(x)) === normCode(codeOf(p))) }))
    .map(({ p, s }) => ({ po: p, so: s }));
  return { verdict: "provable", pairs, why: `${pairs.length} compartment(s), every code unique on both sides` };
}
