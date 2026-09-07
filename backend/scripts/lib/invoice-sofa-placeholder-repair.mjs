// ---------------------------------------------------------------------------
// planInvoicePlaceholderRepair — decide, per invoice line, whether its item
// code is the cutover's un-decoded sofa PLACEHOLDER and the line it was raised
// from carries the real compartment.
//
// WHAT WAS ACTUALLY FOUND, and it is not what the count said. Probe run
// 34143079454 (2026-09-08 00:26 local, `success`) named the five invoice lines
// that `probe-link-identity.mjs` had counted as "the link points at a different
// product". Every one of the five is the SAME SOFA MODEL and a DIFFERENT
// COMPARTMENT, on a source document that carries exactly ONE line, which the
// invoice header itself names:
//
//   HC-I-000745      5526-1S  ->  HC-DO-000542   5526-L(LHF)
//   HC-I-2412-0065   2379-1S  ->  HC-DO-002158   2379-2S
//   HC-PI-007551     9058-1S  ->  HC-GR-005068   9058-1A(LHF)
//   HC-PI-007917     9058-1S  ->  HC-GR-005306   9058-1A(LHF)
//   HC-PI-007920     8030-1S  ->  HC-GR-005277   8030-1A(LHF)
//
// So the LINK is not wrong. It points at the right document and at the only
// line on it. What disagrees is the item CODE, and the invoice side is always
// `{model}-1S`.
//
// THAT CODE IS A PLACEHOLDER, and the repo says so in its own words.
// `scripts/lib/sofa-piece-fold.mjs` documents the cutover binding: "The binding
// CSV maps every AutoCount sofa item to the model's `-1S` compartment
// ('AMN-SF9028 SOFA' -> '9028-1S'), which is a PIECE code standing in for the
// model... all 86 SOFA-category rows end in `-1S`." AutoCount holds one line per
// SOFA; the ERP holds one line per COMPARTMENT. A migrated line starts on the
// placeholder and is decomposed later. These five invoice lines were never
// decomposed while the delivery / receipt line they were raised from was.
//
// SO THIS IS A COPY, NEVER A COMPUTATION. The repair takes the compartment code
// off the document the invoice was raised from. It does not decode anything, it
// does not choose between candidates, and it refuses every case that is not
// FORCED — because a wrong code is worse than a placeholder.
//
// NO MONEY MOVES. The link is correct, so `invoiced` (lib/do-line-remaining.ts)
// is still summed onto the right delivery line and `recost.ts` still aggregates
// onto the right receipt line. Quantity, unit price and line total are untouched
// by every rule below. The defect is what the document NAMES.
//
// NO SHEBANG: a test imports this file, and on Windows vitest inlines the source
// before running it, so a `#!` that is no longer at byte 0 is a SyntaxError.
// ---------------------------------------------------------------------------

const norm = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** The model behind a `-1S` placeholder. Stripped from the END, never split on
 *  the first dash: one model legitimately contains its own dash ("SOFA-333 44").
 *  Same rule as sofaModelOf in scripts/lib/sofa-piece-fold.mjs. */
export function placeholderModelOf(code) {
  const c = norm(code);
  return c.endsWith('-1S') ? c.slice(0, -3) : null;
}

/**
 * @param {Array<object>} rows one per invoice line whose code disagrees with its
 *   source, each: {invoiceNo, lineId, invoiceCode, sourceCode, sourceDocNo,
 *   sourceLineCount, headerNamesSourceDoc}
 * @param {Set<string>} placeholderCodes every `erp_code` the cutover binding
 *   gives a SOFA-category AutoCount item — the evidence that a code IS the
 *   placeholder rather than merely ending in "-1S"
 * @returns {{repairs: Array, refusals: Array}}
 *
 * FIVE THINGS MUST ALL HOLD. Each one is a way this could be something else,
 * and each refusal names which one failed so a human can read the list.
 */
export function planInvoicePlaceholderRepair(rows, placeholderCodes) {
  const repairs = [];
  const refusals = [];
  for (const r of rows) {
    const refuse = (why) => refusals.push({ ...r, why });
    const model = placeholderModelOf(r.invoiceCode);

    /* 1. The invoice code must BE the placeholder shape. */
    if (!model) { refuse(`the invoice line's code "${r.invoiceCode}" is not a {model}-1S placeholder`); continue; }

    /* 2. ...and the cutover binding must actually map a sofa onto it. A code
          that merely ends in "-1S" could be a real single-seat line somebody
          ordered, and repairing one of those would DESTROY a correct row. */
    if (!placeholderCodes.has(norm(r.invoiceCode))) {
      refuse(`"${r.invoiceCode}" is not a cutover sofa placeholder in the binding — it may be a genuine single-seat line`);
      continue;
    }

    /* 3. The source must be the SAME MODEL. A different model is a genuinely
          wrong link and is not this script's business at all. */
    const src = norm(r.sourceCode);
    if (!src.startsWith(`${model}-`)) {
      refuse(`the source line "${r.sourceCode}" is not a compartment of model ${model} — this is a wrong LINK, not a placeholder`);
      continue;
    }

    /* 4. ...and must not itself still be the placeholder (nothing to copy). */
    if (src === norm(r.invoiceCode)) { refuse('the source line carries the same placeholder — nothing to copy'); continue; }

    /* 5. The source document must carry exactly ONE line, and the invoice
          HEADER must name that same document. Together those mean there was
          never a choice to get wrong: one line, and the document the invoice
          itself says it came from. With two or more lines the invoice line
          could have been raised from either, and which one is a judgement no
          script may make. */
    if (Number(r.sourceLineCount) !== 1) {
      refuse(`${r.sourceDocNo} carries ${r.sourceLineCount} lines — the pairing is not forced`);
      continue;
    }
    if (!r.headerNamesSourceDoc) {
      refuse(`the invoice header does not name ${r.sourceDocNo} — the pairing is not forced`);
      continue;
    }

    repairs.push({ ...r, model, newCode: r.sourceCode });
  }
  return { repairs, refusals };
}
