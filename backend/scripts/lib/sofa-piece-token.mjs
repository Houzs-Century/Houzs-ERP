// ---------------------------------------------------------------------------
// sofa-piece-token — "which PIECE of the sofa does this text name?", in ONE
// place.
//
// A sofa line's item code is model-piece: `9058-2A(RHF)` is model 9058, piece
// 2A(RHF). Several OTHER columns on the same row also state a piece, and every
// one of them is read by somebody:
//
//   description / material_name  the printed name (the PDF prints
//                                `description ?? material_name`)
//   supplier_sku                 the SUPPLIER's code - the PO PDF's "Supplier
//                                Code" column, and the document says so in its
//                                own words: "Item codes shown are SUPPLIER
//                                codes; our model & reference appear in the
//                                Description". This is the column the factory
//                                builds from.
//
// WHY THIS IS A MODULE AND NOT A HELPER INSIDE ONE SCRIPT. The rule has now been
// written three times and each copy covered fewer columns than the last needed:
// the compartment-corrections applier moved `item_code` alone, then
// `repair-sofa-line-name-to-code.mjs` (2026-09-11) taught it and the in-place
// rename tool to move the printed NAME as well - and neither of the three ever
// touched `supplier_sku`. Measured on production 2026-09-11, that left 24
// purchase-order lines and 13 goods-received lines telling the supplier to build
// a DIFFERENT piece than our own code states, plus 7 purchase invoices printing
// one. The owner found it on HC-PO-2609-053: ours `8030-1A(LHF)`, the document's
// supplier code `5540-L(LHF)` - the two end pieces of the build exchanged.
//
// THE MATCHER SELF-TESTS BEFORE ANY CALLER REPORTS. `assertMatcherSane()` throws
// on a matcher that cannot match, because a checker that cannot match reports a
// clean run (CLAUDE.md). Two real regressions are pinned in the fixtures:
//   · no trailing `\b` after a token ending in `)` - `\b` cannot match there, and
//     the first version of this regex reported 0 findings on 17 real ones;
//   · the delimiter test must NOT run on whitespace-squashed text. Squashing
//     deletes the very space that separates the model word from the piece, so
//     "SOFA LAZIO 1A(R)(LHF)" reads as undelimited and a recliner code appears
//     to disagree with its own name. That produced 67 false positives on the
//     sales-order arm of the 2026-09-11 census before it was fixed.
// ---------------------------------------------------------------------------

/** `9058-2A(RHF)` -> `2A(RHF)`. The FIRST dash: a sofa code is model-piece. */
export const pieceOf = (code) => {
  const s = String(code ?? '').trim().toUpperCase();
  const i = s.indexOf('-');
  return i < 0 ? s : s.slice(i + 1);
};

/** A piece token inside free text. NO trailing `\b` - see the header. */
export const PIECE_RX = /(\d?[ABL]?\d?[A-Z]{0,3}\((?:LHF|RHF)\)|\bCNR\b|\bCONSOLE\b|\bSTOOL\b|\b\dS\b|\b\dNA\b)/i;

/** Upper-case, whitespace collapsed to one space. NOT removed - see the header. */
export const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Does this text state a piece at all? A text that states none is the
 *  SUPPLIER'S OWN product name - "AMN SOFA - SF9058", "HOK SOFA - 5536" - and on
 *  a purchase document that is exactly what belongs there. */
export const namesAPiece = (shown) => PIECE_RX.test(String(shown ?? ''));

/** Does this text state OUR piece, delimited (start, space or dash before it)? */
export const namesOurPiece = (code, shown) => {
  const hay = norm(shown);
  const needle = norm(pieceOf(code));
  if (!needle) return false;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : hay[at - 1];
    if (!/[A-Z0-9]/.test(before)) return true;
  }
  return false;
};

/**
 * The column DISAGREES: it names a piece, and not ours.
 *
 * Empty is not a disagreement (nothing is shown), and a text naming no piece is
 * not one either (it is the supplier's own product name).
 */
export const disagrees = (code, shown) =>
  Boolean(shown) && namesAPiece(shown) && !namesOurPiece(code, shown);

/**
 * The same text with its piece token replaced by `piece`.
 *
 * ONLY the piece token moves. The model word keeps whatever it says, which is
 * what makes this safe on a supplier code: `HOK-5540 SOFA 2A(LHF)` becomes
 * `HOK-5540 SOFA 1A(LHF)` and keeps the supplier's own spelling, rather than
 * being replaced wholesale from a master row whose spelling has since changed.
 */
export const movePieceTo = (shown, piece) => String(shown).replace(PIECE_RX, piece);

/** Fixtures, exported so the test file and the runtime check share them. */
export const FIXTURES = {
  /** [code, shown] pairs that AGREE. */
  agree: [
    ['8050-1A(R)(LHF)', 'SOFA LAZIO 1A(R)(LHF)'],   // recliner: the 67-false-positive case
    ['8030-1A(LHF)', '5540-1A(LHF)'],
    ['8030-2A(LHF)', 'HOK-5540 SOFA 2A(LHF)'],
    ['9058-CNR', 'SOFA VERANO CNR'],
    ['8030-1NA', '5540-1NA'],
    ['8030-1A(LHF)', 'HOK SOFA - 5540'],            // names no piece: the supplier's own
    ['9058-2A(RHF)', 'AMN SOFA - SF9058'],
  ],
  /** [code, shown, corrected] triples that DISAGREE. */
  differ: [
    ['8030-1A(LHF)', '5540-L(LHF)', '5540-1A(LHF)'],
    ['8030-L(RHF)', '5540-1A(RHF)', '5540-L(RHF)'],
    ['9058-1A(LHF)', 'HOK-5536 SOFA 2A(LHF)', 'HOK-5536 SOFA 1A(LHF)'],
    ['8030-L(RHF)', 'SOFA SOFFIO 1A(RHF)', 'SOFA SOFFIO L(RHF)'],
    ['9058-1A(LHF)', 'SOFA MAYBATCH 1S', 'SOFA MAYBATCH 1A(LHF)'],
    ['8030-1A(LHF)', 'HOK-5540 SOFA 3S', 'HOK-5540 SOFA 1A(LHF)'],
  ],
};

/**
 * Throw unless the matcher still answers every fixture correctly.
 *
 * Call this BEFORE reading any data. A verdict computed over nothing must never
 * read as a pass.
 */
export function assertMatcherSane() {
  const bad = [];
  for (const [code, shown] of FIXTURES.agree) {
    if (disagrees(code, shown)) bad.push(`AGREE pair read as a disagreement: ${code} / ${shown}`);
  }
  for (const [code, shown, want] of FIXTURES.differ) {
    if (!disagrees(code, shown)) bad.push(`DIFFER pair read as agreeing: ${code} / ${shown}`);
    const got = movePieceTo(shown, pieceOf(code));
    if (got !== want) bad.push(`correction wrong: ${shown} -> ${got}, wanted ${want}`);
  }
  if (bad.length) throw new Error(`sofa piece matcher SELF-TEST FAILED:\n  ${bad.join('\n  ')}`);
}
