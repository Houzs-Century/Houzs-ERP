/* Is this fabric code actually a PRODUCT code? The script-side twin of the
   write-path guard in src/scm/routes/fabric-tracking.ts.

   WHY THERE ARE TWO COPIES AND HOW THEY ARE HELD TOGETHER. The route runs on
   Cloudflare Workers and imports Hono; a .mjs repair script cannot import it
   (Node 20/22 in the workflows will not strip types, and pulling a Hono app
   with its auth middleware into a data script to read one regex would be a
   worse trade than this file). So the rule is written twice — and
   backend/tests/nonFabricCodeParity.test.ts asserts the two regexes are
   character-identical AND agree on every code in the guard's own corpus, so a
   word added to one and not the other fails CI instead of quietly letting the
   retire script and the write path disagree about what a fabric is.

   THE RULE IS THE CODE ONLY, AND ONLY AT ITS HEAD. Nine of the 153 genuine
   fabrics in the HOOKKA master describe themselves as "SOFA FABRIC KOONA
   VELVET PEARL" — testing the DESCRIPTION would condemn every one of them to
   catch two products. probe-fabric-leftovers.mjs:43 does test the description,
   deliberately: it is a PROBE whose false positives a human reads. This file
   feeds a writer, so it matches the guard, not the probe. */

/** Product-category words that cannot open a fabric code. Identical to
 *  NON_FABRIC_HEAD in src/scm/routes/fabric-tracking.ts — pinned by
 *  backend/tests/nonFabricCodeParity.test.ts. */
export const NON_FABRIC_HEAD =
  /^(SOFA|SQUARE\s*PILLOW|LONG\s*PILLOW|BOLSTER|STOOL|CONSOLE|MATTRESS|BEDFRAME|DIVAN|DELIVERY|TRANSPORT|SERVICE|SVC)\b/i;

/** The product word a fabric code opens with, or null when it reads as a
 *  fabric. Whitespace inside a two-word head is normalised so "SQUARE  PILLOW"
 *  and "SQUARE PILLOW" report the same word. */
export function nonFabricCodeWord(code) {
  const m = NON_FABRIC_HEAD.exec(String(code ?? '').trim());
  return m?.[1] ? m[1].toUpperCase().replace(/\s+/g, ' ') : null;
}

/* ── HOW A RETIRED ROW RECORDS WHY AND WHEN ──────────────────────────────────
   Nothing is deleted in this system, so "retired" has to be legible from the
   row itself months later. is_active = false is the machine half; this is the
   human half, and it is APPENDED so the original description survives verbatim
   in front of it and the reversal stays mechanical.

   These two live here, beside the rule that condemns a code, because the
   pattern that RECOGNISES a stamp and the function that WRITES one have to
   agree exactly or a re-run stamps a row twice. backend/tests/
   nonFabricCodeParity.test.ts holds them to it. */

/** Matches a stamp this pair has already written, whatever its date. The
 *  retire script uses it to leave an already-retired row alone. */
export const RETIRE_STAMP_RE = /\[RETIRED \d{4}-\d{2}-\d{2} - non-fabric code head [^\]]*\]/i;

/** The original description, kept verbatim, with the reason appended.
 *  `day` is passed in rather than read from the clock so a caller can be
 *  deterministic and a test can assert the exact string. */
export function stampDescription(description, word, day) {
  const original = String(description ?? '').trim();
  const marker = `[RETIRED ${day} - non-fabric code head ${word}: a product, not a fabric. Deactivated, not deleted.]`;
  return original ? `${original} ${marker}` : marker;
}
