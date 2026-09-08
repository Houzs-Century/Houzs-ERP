/**
 * Does a sofa correction name the model the ACCOUNT BOOK names? PURE: maps in,
 * findings out. No filesystem, no database, no process.exit - the runner
 * (../check-sofa-corrections-vs-book.mjs) does the I/O and the printing.
 *
 * NO SHEBANG: backend/tests/sofaCorrectionsVsBook.test.mjs imports this module,
 * and on Windows vitest inlines it, where a `#!` that is no longer at byte 0 is
 * a load-time SyntaxError.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `sofa-compartment-corrections-2026-08.json` states a `model` per build as a
 * free-standing string, and `apply-sofa-compartment-corrections.mjs` takes it
 * verbatim - `const model = K(c.model || modelOf(rows[0].code))`, the file's
 * value winning over the model the row already carries. That fallback is the
 * safe half: with no `model` the applier keeps what the importer derived from
 * the AutoCount item code, which is the book's own answer. The stated half had
 * nothing grading it, so on three builds a hand-typed model overwrote a correct
 * one and the ERP has disagreed with the book ever since (docs/bugs/0693-...).
 *
 * The importer never chose those SKUs. Run on the book's own rows it produces
 * exactly what the book says, pieces included; only the file's `model` differs.
 * This module is the grader that was missing.
 *
 * ── THE ALIAS IS NOT A DIFFERENCE ───────────────────────────────────────────
 * The cutover deliberately folds four Hookka spellings onto the model the ERP
 * carries. A book `HOK-5536 SOFA` against a file `9058` is that policy working.
 * It is reported as its own verdict rather than counted as agreement, because
 * the two facts answer different questions. 5535 is deliberately absent from
 * that map - the owner has ruled twice that it is its own model - so a fold of
 * 5535 can never appear here.
 *
 * ── AND NEITHER IS A DECLARED OWNER OVERRIDE ────────────────────────────────
 * 「一律跟账本。除了sofa compartment而已啊」 gives the model to the book, and this
 * grader is what enforces it. But the owner can still decide, out loud and on
 * one named line, that the ERP carries a product the book does not:
 * HC-SO-011657 is one - the book's own daybed `TNS-9838 DB` is discontinued and
 * has no stool piece to sell, and he answered 「那就放8030 daybed把」.
 *
 * Recording that as a bare `model` would be indistinguishable from the defect
 * this module exists to catch, so it is not accepted as one. An override must
 * DECLARE the book model it overrides, and be attributed. That is strictly
 * stronger than the rule it sits beside:
 *
 *   - an undeclared model that differs is still DIFFER, so docs/bugs/0693 -
 *     three hand-typed models outranking the book for a month - stays caught;
 *   - a declaration that no longer matches what the book says on that line is
 *     DIFFER too, so refreshing the book cut RE-OPENS every override whose
 *     ground has moved instead of letting it rot unnoticed;
 *   - what survives is reported as OWNER-OVERRIDE, never folded into AGREE,
 *     because "he decided this" and "these match" are different answers and
 *     only one of them means the ERP and the book say the same thing.
 */

/** Upper-cased, trimmed - the form model codes are compared in. */
const K = (s) => String(s ?? "").trim().toUpperCase();

/** The model half of an ERP code: `8030-1A(LHF)` -> `8030`. */
export function modelOfErpCode(code, alias = {}) {
  const c = K(code);
  if (!c) return null;
  const d = c.indexOf("-");
  const raw = d < 0 ? c : c.slice(0, d);
  return { raw, folded: alias[raw] || raw };
}

/**
 * @typedef {object} GradedCorrection
 * @property {string[]} docs
 * @property {string} source          which corrections file the build came from
 * @property {string|null} fileModel  the model the file states, upper-cased
 * @property {string[]} bookRaw       models the book names, before the alias
 * @property {string[]} bookFolded    the same, after the alias
 * @property {string[]} unmapped      book item codes the item map does not carry
 * @property {{doc:string,dtlKey:string,ac:string}[]} hits the book lines found
 * @property {string[]} missing       one line per document that produced no hit
 * @property {string|null} overrideBook the book model the entry DECLARES it is
 *   overriding, upper-cased; null when it declares none
 * @property {"AGREE"|"AGREE-VIA-ALIAS"|"OWNER-OVERRIDE"|"DIFFER"|"NO-MODEL-IN-FILE"|"NO-BOOK-LINE"|"UNMAPPED-BOOK-CODE"|"BOOK-SPLIT"} verdict
 */

/**
 * Grade every build against the book.
 *
 * @param {object} a
 * @param {any[]} a.builds        the corrections, as loadCorrections returns them
 * @param {(doc:string)=>{present:boolean,lines:{dtlKey:string,itemKey:string,desc2:string}[]}} a.bookLines
 *   every book line of one document, by the ERP's document number
 * @param {(acCode:string)=>string|null} a.erpCodeFor   AutoCount code -> ERP code
 * @param {(desc2:string,needle:string)=>boolean} a.desc2Contains
 * @param {Record<string,string>} [a.alias]             SOFA_MODEL_ALIAS
 * @returns {{rows: GradedCorrection[], tally: Record<string, number>}}
 */
export function gradeCorrectionsAgainstBook({ builds, bookLines, erpCodeFor, desc2Contains, alias = {} }) {
  const rows = [];
  for (const b of builds ?? []) {
    const docs = Array.isArray(b?.docs) ? b.docs : [];
    const hits = [];
    const missing = [];

    for (const doc of docs) {
      const bk = bookLines(doc) ?? { present: false, lines: [] };
      if (!bk.present) { missing.push(`${doc}: not in the book cut`); continue; }
      const on = (bk.lines ?? []).filter((l) => desc2Contains(l.desc2 ?? "", b?.desc2Match ?? ""));
      if (!on.length) {
        missing.push(`${doc}: ${(bk.lines ?? []).length} book line(s), none carries this Desc2`);
        continue;
      }
      for (const l of on) hits.push({ doc, dtlKey: String(l.dtlKey), ac: String(l.itemKey) });
    }

    const raw = new Set(), folded = new Set(), unmapped = new Set();
    for (const h of hits) {
      const erp = erpCodeFor(h.ac);
      const m = erp ? modelOfErpCode(erp, alias) : null;
      if (!m) { unmapped.add(h.ac); continue; }
      raw.add(m.raw); folded.add(m.folded);
    }

    const fileModel = b?.model == null ? null : K(b.model);
    /* A declared override, and ONLY when it names both the book model it
       overrides and who decided it. Anything less is an ordinary typed model
       and is graded as one. */
    const ov = b?.modelOverride;
    const overrideBook =
      ov && typeof ov === "object" && ov.book != null && String(ov.by ?? "").trim() !== ""
        ? K(ov.book)
        : null;

    let verdict;
    if (fileModel === null) verdict = "NO-MODEL-IN-FILE";
    else if (!hits.length) verdict = "NO-BOOK-LINE";
    else if (unmapped.size) verdict = "UNMAPPED-BOOK-CODE";
    else if (folded.size !== 1) verdict = "BOOK-SPLIT";
    else if ([...raw][0] === fileModel) verdict = "AGREE";
    else if ([...folded][0] === fileModel) verdict = "AGREE-VIA-ALIAS";
    /* Asked LAST, so an override can never dress up an agreement as a decision
       - and only while the book still says what the declaration says it says.
       Once it does not, nobody has decided what the line reads NOW. */
    else if (overrideBook !== null && overrideBook === [...raw][0]) verdict = "OWNER-OVERRIDE";
    else verdict = "DIFFER";

    rows.push({
      docs, source: String(b?.source ?? ""), fileModel, verdict, missing, hits, overrideBook,
      bookRaw: [...raw].sort(), bookFolded: [...folded].sort(), unmapped: [...unmapped].sort(),
    });
  }

  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  return { rows, tally };
}
