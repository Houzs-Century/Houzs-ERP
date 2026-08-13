/* THE DIGIT GUARD, as a separate assertion from the matcher's own.

   A colour NUMBER is an identity, not a spelling. The shared matcher
   (`fabric-colour-match.mjs`) already refuses to move a digit inside its FUZZY
   tail - transposition, prefix, edit distance - but its exact, seriesNum and
   alias passes can still return a row whose number differs from the document's,
   because those passes reach the library by a rewritten spelling rather than by
   a corrected one. Anything that WRITES a binding therefore re-asserts the rule
   on the answer it got back, instead of trusting that the matcher already did.

   WHY THIS COMPARES RUNS AND NOT A JOINED STRING - the bug this file exists for.
   The first version of the guard joined every digit run together, the way the
   matcher's internal `digitsOf` does, and then allowed one padding zero on the
   tail. Production DRY-RUN 31452652036 proved that unsound: it PASSED
   `PC151-101` -> `PC151-11`, the single binding the caller exists to refuse.
   Joined, they are `151101` and `15111`, and padding the second yields exactly
   `151101` - so a rule written to reconcile "J9226-1" with "J9226-01" declared a
   series number and a colour number to be the same number.

   It is the same hazard `merge-duplicate-fabric-series.mjs` documents from the
   other side: once the fold runs the series number into the colour number,
   nothing downstream can tell which digits are which. So the separator is kept.

     "PC151-101" -> ["151","101"]      "PC151-11" -> ["151","11"]      DIFFERENT
     "J9226-2"   -> ["9226","2"]       "ARMANI J9226-02 ..." -> ["9226","02"]  SAME

   Every run but the last must be equal; the last may differ by ONE leading
   zero, which is the real spelling difference the library actually contains.

   Letter-O is mapped to '@' before digits are read, so a written zero and a
   letter-O can never trade places - the same mark-space trick the matcher uses.

   A document that writes NO number is not subject to this at all: there is no
   digit to move. "Cream" resolving to `KS-02`, or the misspelt "sliver"
   resolving to `KS-15`, are hits on the colour's NAME, and the matcher drops any
   fold key that two different library rows produce - so a name-only hit is
   unique by construction, and refusing it would discard a correct binding. */

/** Digit runs of a string, separators intact, letter-O excluded. */
export const colourNumberRuns = (s) =>
  String(s ?? "").toUpperCase().replace(/O/g, "@").match(/\d+/g) || [];

/**
 * May a document spelling bind to a library colour without moving a digit?
 * @param q runs of the document's colour text
 * @param h runs of the library row's colour_id
 */
export const colourNumberCompatible = (q, h) => {
  if (!q.length) return true;                       // no number written - nothing to move
  if (q.length !== h.length) return false;
  for (let i = 0; i < q.length - 1; i++) if (q[i] !== h[i]) return false;
  const a = q[q.length - 1], b = h[h.length - 1];
  return a === b || `0${a}` === b || a === `0${b}`;  // one padding zero, no more
};

/** Convenience: compare two raw strings. */
export const colourNumberMayBind = (docText, libraryColourId) =>
  colourNumberCompatible(colourNumberRuns(docText), colourNumberRuns(libraryColourId));

export const showColourNumber = (runs) => (runs.length ? runs.join("-") : "(none)");
