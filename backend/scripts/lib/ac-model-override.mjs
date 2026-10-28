/* ac-model-override — the ERP naming a product the account book does not, BY
 * THE OWNER'S DECISION, told apart from the same thing happening by drift.
 *
 * ── THE ONE DOCUMENT THIS EXISTS FOR, AND WHY IT IS NOT AN AMNESTY ─────────
 * 「一律跟账本。除了sofa compartment而已啊」 — the book decides every axis except
 * the sofa build. HC-SO-011657 is the exception he made himself: the book's
 * line is `TNS-9838 DB`, the target `9838-STOOL` is not a minted SKU, and asked
 * what to do he answered 「那就放8030 daybed把」. So the ERP holds model 8030
 * where the book holds 9838, on purpose, and `lib/item-code-class.mjs` correctly
 * calls that `different` — it has no way to know a person decided it.
 *
 * A hand-typed model that is simply WRONG looks exactly the same from there.
 * That is not hypothetical: docs/bugs/0693 is three documents held wrong against
 * the book for a month by one. So this must not be a list of documents to
 * excuse. It is a DECLARATION with two halves, and both are checked every run:
 *
 *   1. the declaration names the BOOK MODEL it overrides, and the book must
 *      STILL say that. Refresh the cut, let the book change, and the override
 *      stops matching and the line goes back to DIFFER by itself — nobody has
 *      decided what the line reads NOW.
 *   2. the declaration names WHO decided it. An entry with no `by` is an
 *      ordinary typed model and is graded as one.
 *
 * The same two conditions `lib/sofa-corrections-book-grade.mjs` already applies
 * to reach its `OWNER-OVERRIDE` verdict. They are stated here in the shape the
 * reconcile's per-line findings need — that file grades a CORRECTION against the
 * book, this one grades a FINDING against a declaration — and both read the same
 * `modelOverride` object off the same owner-approved file, so neither can bless
 * a line the other would not.
 *
 * ── WHAT MOVING MEANS, AND WHAT IT DOES NOT ────────────────────────────────
 * A moved finding leaves DIFFER and lands in its OWN bucket, which prints the
 * decision, its owner and its date. It is not folded into `identical` and it is
 * not silently dropped: the line really does differ from the book, and that
 * difference is the only signal that would ever catch a decision applied to the
 * wrong document.
 *
 * PURE. No filesystem, no database, no clock, no printing.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */
import { modelOf } from "./item-code-class.mjs";

/** The note class a moved finding is recorded under. Declared in
 *  lib/so-verdict-derive.mjs so the verdict knows it is not a difference. */
export const NOTE_MODEL_OVERRIDE = "owner-model-override";

/** The axis a moved finding is moved OFF. */
export const AXIS_ITEM_CODE = "item code";

/**
 * Index the owner-approved builds by the ERP document they name, keeping only
 * the ones carrying a COMPLETE declaration.
 *
 * `_held` builds must never be passed in: a held build is a ruling we have not
 * written, so its line is still work. `loadCorrections` returns them separately
 * for exactly that reason and the caller passes `.builds`.
 *
 * @param {Array<object>} builds
 * @returns {Map<string, Array<{model: string, book: string, by: string, on: string|null, why: string|null, source: string|null}>>}
 */
export function makeModelOverrideIndex(builds) {
  const byDoc = new Map();
  for (const b of builds ?? []) {
    const ov = b?.modelOverride;
    if (!ov || typeof ov !== "object") continue;
    /* BOTH halves, or it is an ordinary typed model. Stated as a refusal rather
       than a default so a declaration that loses its `by` in an edit stops
       blessing anything instead of quietly going on. */
    const book = ov.book == null ? "" : String(ov.book).trim();
    const by = String(ov.by ?? "").trim();
    const model = b?.model == null ? "" : String(b.model).trim();
    if (!book || !by || !model) continue;
    for (const d of b.docs ?? []) {
      const k = String(d ?? "").trim().toUpperCase();
      if (!k) continue;
      if (!byDoc.has(k)) byDoc.set(k, []);
      byDoc.get(k).push({
        model, book, by,
        on: ov.on == null ? null : String(ov.on),
        why: ov.why == null ? null : String(ov.why),
        source: b.source == null ? null : String(b.source),
      });
    }
  }
  return byDoc;
}

/**
 * Does a declaration cover THIS finding?
 *
 * Both models are compared through `modelOf` — the same fold
 * `lib/item-code-class.mjs` used to decide the finding in the first place, so
 * the override cannot bless a pair the classifier would have called something
 * else. A null model on either side is never a match: an override that fires on
 * "no model at all" would cover every accessory on the document.
 */
export function overrideCovers(decl, { acCode, erpCode }) {
  const declBook = modelOf(decl?.book);
  const declOurs = modelOf(decl?.model);
  const bookNow = modelOf(acCode);
  const oursNow = modelOf(erpCode);
  if (!declBook || !declOurs || !bookNow || !oursNow) return false;
  /* THE BOOK MUST STILL SAY WHAT THE DECLARATION SAYS IT SAYS. This is the
     half that makes the override expire by itself. */
  if (declBook !== bookNow) return false;
  return declOurs === oursNow;
}

/**
 * Split item-code findings into the owner's declared decisions and the rest.
 *
 * @param {object} a
 * @param {Array<{key: string, erpNo: string|null, line: string, acCode: string, erpCode: string}>} a.rows
 * @param {Map} a.index from `makeModelOverrideIndex`
 * @returns {{applied: boolean, moved: Array<object>, differ: Array<object>, why: string}}
 */
export function splitOwnerModelOverride({ rows, index }) {
  const all = Array.isArray(rows) ? rows : [];
  if (!index || index.size === 0) {
    return {
      applied: false,
      moved: [],
      differ: all,
      why: "no complete model-override declaration was loaded, so every item-code finding stays a difference",
    };
  }
  const moved = [], differ = [];
  for (const r of all) {
    const decls = index.get(String(r.erpNo ?? "").trim().toUpperCase()) ?? [];
    const hit = decls.find((d) => overrideCovers(d, r));
    if (hit) moved.push({ ...r, decl: hit });
    else differ.push(r);
  }
  return {
    applied: true,
    moved,
    differ,
    why: `${index.size} document(s) carry a complete model-override declaration`,
  };
}

/* ── PLANTED CASES ──────────────────────────────────────────────────────────
 * Every one must land where it does and nowhere else. The caller runs
 * `runSelfTest()` before it reads a row: a splitter that cannot split must not
 * go on moving findings out of a defect count. */
export function selfTestCases() {
  const decl = { model: "8030", book: "9838 DB", by: "owner", on: "2026-09-08", why: "「那就放8030 daybed把」" };
  return [
    { name: "the declared pair — the book still says 9838 and we still say 8030",
      decl, row: { acCode: "TNS-9838 DB", erpCode: "8030-STOOL" }, want: true },
    { name: "THE EXPIRY: the book has changed and nobody has decided what it reads NOW",
      decl, row: { acCode: "TNS-9058 DB", erpCode: "8030-STOOL" }, want: false },
    { name: "our line has moved off the model he decided",
      decl, row: { acCode: "TNS-9838 DB", erpCode: "9050-STOOL" }, want: false },
    { name: "an accessory with no model on our side is never covered",
      decl, row: { acCode: "TNS-9838 DB", erpCode: "AMN-SOFA PILLOW" }, want: false },
    { name: "an accessory with no model on the book's side is never covered",
      decl, row: { acCode: "AMN-SOFA PILLOW", erpCode: "8030-STOOL" }, want: false },
    /* THE ALIAS IS THE CLASSIFIER'S, NOT OURS. 5540 folds to 8030 on the floor,
       so a book line written either way is the same decision. */
    { name: "the alias the floor uses is honoured, because modelOf is the same function",
      decl: { ...decl, model: "5540" }, row: { acCode: "TNS-9838 DB", erpCode: "8030-STOOL" }, want: true },
  ];
}

export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = overrideCovers(c.decl, c.row);
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  /* An INCOMPLETE declaration must index to nothing. Checked here rather than
     only in the test file, because this is the property that stops the lane
     becoming a list of excused documents. */
  const incomplete = [
    { docs: ["A"], model: "8030", modelOverride: { book: "9838 DB" } },
    { docs: ["A"], model: "8030", modelOverride: { by: "owner" } },
    { docs: ["A"], modelOverride: { book: "9838 DB", by: "owner" } },
  ];
  const idx = makeModelOverrideIndex(incomplete);
  if (idx.size !== 0) failures.push(`an incomplete declaration was indexed (${idx.size} document(s))`);
  return failures;
}
