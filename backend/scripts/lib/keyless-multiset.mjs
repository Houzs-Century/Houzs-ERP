// ---------------------------------------------------------------------------
// keyless-multiset — verify a document whose lines cannot be PAIRED, by
// comparing the two sides as MULTISETS instead.
//
// THE PROBLEM THIS ANSWERS. `check-ac-erp-reconcile.mjs` refuses to line-match
// a document when no ERP line of it carries an AutoCount line key AND the two
// sides disagree about how many lines there are. That refusal is correct —
// pairing by POSITION produced transposed pairs five separate times on
// 2026-09-07/08 (sofa colours on two delivery notes, ten bedframe dedications,
// two sofa models, the goods-receipt item codes) — but it leaves the document
// UNVERIFIED, and "the checker refused" was three times reported as though it
// were "the document is clean". Under the owner's rule
// (「包括每个 line 都是要一样的」) it is not.
//
// WHY A MULTISET NEEDS NO KEY. Pairing asks "which book line is THIS ERP line?"
// — a question neither system can answer here. A multiset asks a different one:
// "is the BAG of (item, quantity) on our side the same bag as the book's?"
// Order is not part of the answer, so a reordering cannot manufacture a
// finding, and a genuinely missing or extra item cannot hide behind one. When
// the two bags are equal the document IS identical however its lines are
// ordered — a real answer, not a refusal. When they differ, the difference
// NAMES the defect: which code, how much on each side.
//
// THE SOFA FOLD. A sofa is ONE book line and ONE ERP ROW PER COMPARTMENT
// (`DSL-8030 SOFA` against `8030-1A(LHF)`, `8030-CNR`, `8030-2A(RHF)`), so the
// raw bags can never be equal on a sofa document. Both sides are therefore
// folded to the MODEL — the same reduction `lib/item-code-class.mjs` calls
// `decomposition` and `lib/sofa-piece-fold.mjs` performs on stock — and the
// model is folded through SOFA_MODEL_ALIAS, because the floor writes one sofa
// under an internal number and a catalogue number. 5535 is NOT in that table
// and must never be folded: it is its own model.
//
// THE FOLD RULE IS THE BOOK'S OWN BUILD TEXT, DECODED — not `MIN` over the
// pieces, and the difference is the whole correctness of this module.
// lib/sofa-piece-fold.mjs folds STOCK, where one build is one `batch_no` and MIN
// across the compartment SKUs is right. A document has no batch, and MIN over a
// model group is wrong TWICE over:
//
//   * two sofas of one model with DIFFERENT layouts fold to ONE. Measured
//     2026-09-08 (run 34189979464): that reported nine sales orders as
//     `book qty 2 vs ours 1`, all sofas, none a defect.
//   * one sofa whose build legitimately repeats a piece — `1R+1NA+1NA+C+1R` is
//     FIVE pieces including TWO `1NA` — reads as uneven and comes back
//     undecidable. Measured in the same run: six of the eight AMBIGUOUS.
//
// THE BUILD KEY ON A DOCUMENT IS THE BOOK'S BUILD TEXT. Both cutover importers
// write the AutoCount line's `Desc2` verbatim onto every compartment row
// (`description2`) — the fact src/services/autocount-sofa-collapse.ts is built
// on, its ECHO path re-sending that stored text to the book. So the compartments
// of ONE book sofa line carry ONE build text, and grouping our rows by
// (model, build text) recovers what the missing line key would have given. A
// VALUE match, never a positional one.
//
// AND THE COUNT IS A DIVISION, not a minimum. `parseSofa` — the decoder BOTH
// cutover importers used to mint these rows, and the one the write-back gate
// re-runs — turns the build text into the piece list for ONE sofa. The number of
// sofas is then our quantity of each piece DIVIDED by how many that one sofa
// needs, and every piece must give the same whole answer. `1R+1NA+1NA+C+1R`
// against `1A(LHF) x1, 1A(RHF) x1, 1NA x2, CNR x1` divides to 1 everywhere: one
// sofa, decided. The same rows against a build needing one `1NA` would divide to
// 1,1,2,1 — not one answer, and that is AMBIGUOUS, printed, never averaged.
//
// WHEN THE TEXT DOES NOT DECODE (`pieces: []`, the free-prose builds) there is
// no divisor. A build whose suffixes are all DISTINCT and all at one quantity is
// still decided — that quantity — because nothing could be hiding. A build that
// REPEATS a suffix is not: two `1NA` rows are two pieces of one sofa or one
// piece of two sofas, and only the text could have said which. Those come back
// AMBIGUOUS with both sides printed. The ambiguous set must be small, named and
// per-document, not a bucket.
//
// MONEY RIDES THE LEAD PIECE. The ERP writes the sofa's price on one
// compartment and 0.00 on the rest, so the model's TOTAL money is commensurable
// with the book's line subtotal even though no single row is. Money is compared
// per key, and only where the caller says the type's price is not derived —
// on a goods receipt the ERP takes the price from the PURCHASE ORDER by design
// and on a migrated delivery order it holds none at all, so comparing money
// there would measure our own derivation, not the book.
//
// PURE: rows in, a verdict out. No filesystem, no database, no printing.
//
// NO SHEBANG: tests/keylessMultiset.test.mjs imports this module (see
// lib/ac-mapping-csv.mjs for the Windows vitest reason).
// ---------------------------------------------------------------------------

import { modelOf, isCompartmentCode } from "./item-code-class.mjs";
import { parseSofa } from "./parse-sofa.mjs";
import { normCode } from "./ac-mapping-csv.mjs";

/** The same /SOFA/ substring test check-ac-erp-reconcile.mjs uses on the BOOK's
 *  raw ItemCode. It is deliberately loose: "AMN-SOFA PILLOW" takes this branch
 *  too, which is why a model is required on both sides before anything folds. */
export const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));

const QTY_EPS = 1e-6;

/** The group a compartment row with NO stored build text falls into. Named, not
 *  blank, so a report never shows an empty string where a build should be. */
export const NO_BUILD = "(no build text)";

/**
 * One side's bag.
 *
 * @param {Array<{code: string, rawCode?: string, qty: number, sen: number, suffixed?: boolean}>} rows
 * @param {"book"|"erp"} side
 * @returns {Map<string, {key: string, kind: "plain"|"sofa", qty: number, sen: number,
 *                        pieces: Map<string, number>, codes: Set<string>}>}
 *
 * `code` is already TRANSLATED for the book side (through the mapping sheet) —
 * this module never reads the CSV, because two readers of one file is the
 * defect lib/ac-mapping-csv.mjs exists to record.
 */
export function bagOf(rows, side) {
  const bag = new Map();
  for (const r of rows) {
    const code = normCode(r.code);
    if (!code) continue;
    /* A sofa on the BOOK side is named by AutoCount's own "... SOFA" string; on
       OUR side by a compartment suffix, or by the line_suffix column the
       importer stamps. Either way the MODEL is what the two can be compared on,
       and a side that yields no model is never folded — it stays a plain code,
       so "AMN-SOFA PILLOW" is compared as the accessory it is. */
    const looksSofa =
      side === "book"
        ? isSofaCode(r.rawCode ?? r.code)
        : Boolean(r.suffixed) || isCompartmentCode(code);
    const model = looksSofa ? modelOf(code) : null;
    const key = model ? `SOFA ${model}` : code;
    if (!bag.has(key)) {
      bag.set(key, {
        key, kind: model ? "sofa" : "plain", qty: 0, sen: 0,
        /* `builds` is the fold unit (one book sofa line); `pieces` is the flat
           per-code total, kept only so a report can print what we hold. */
        builds: new Map(), pieces: new Map(), codes: new Set(),
      });
    }
    const e = bag.get(key);
    e.codes.add(code);
    e.sen += Number.isFinite(r.sen) ? r.sen : 0;
    const q = Number.isFinite(r.qty) ? r.qty : 0;
    if (model && side === "erp") {
      /* Compartment quantities are NOT summed: three pieces of one sofa are one
         sofa, not three. They are collected per BUILD — the book's own Desc2,
         stored verbatim on every compartment row — and folded below. A row with
         no build text joins one shared group, which is the honest reading: with
         nothing to group on, the rows cannot be told apart. */
      const build = String(r.desc2 ?? "").trim() || NO_BUILD;
      if (!e.builds.has(build)) e.builds.set(build, new Map());
      const pcs = e.builds.get(build);
      const sfx = suffixOf(code);
      pcs.set(sfx, (pcs.get(sfx) ?? 0) + q);
      e.pieces.set(code, (e.pieces.get(code) ?? 0) + q);
      e.model = model;
    } else {
      e.qty += q;
    }
  }
  /* Fold each ERP sofa group to whole sofas, one BUILD at a time. */
  for (const e of bag.values()) {
    if (e.kind !== "sofa" || e.builds.size === 0) continue;
    let lo = 0;
    let hi = 0;
    let undecided = false;
    const why = [];
    const notes = [];
    for (const [build, pcs] of e.builds) {
      const f = foldBuild(build, e.model, pcs);
      lo += f.lo;
      hi += f.hi;
      if (f.undecided) { undecided = true; why.push(f.why); }
      if (f.note) notes.push(f.note);
    }
    e.qty = lo;
    e.ceiling = hi;
    e.undecided = undecided;
    e.why = why;
    e.notes = notes;
  }
  return bag;
}

/** `9058-1A(LHF)` -> `1A(LHF)`. A model can itself contain a dash
 *  ("SOFA-333 44-CNR"), so the suffix is taken from the LAST one. */
const suffixOf = (code) => {
  const cut = code.lastIndexOf("-");
  return cut > 0 ? code.slice(cut + 1) : code;
};

/**
 * One build -> how many whole sofas it is.
 *
 * @param {string} build   the stored build text, or NO_BUILD
 * @param {string|null} model
 * @param {Map<string, number>} ours  suffix -> our total quantity in this build
 * @returns {{lo: number, hi: number, undecided: boolean, why: string}}
 */
export function foldBuild(build, model, ours) {
  const need = new Map();
  if (build !== NO_BUILD) {
    for (const pc of parseSofa(build, model).pieces || []) {
      const sfx = normCode(pc);
      need.set(sfx, (need.get(sfx) ?? 0) + 1);
    }
  }
  const show = () => [...ours.entries()].sort().map(([sfx, q]) => `${sfx} x${fmtQty(q)}`).join(", ");
  const extra = [...ours.keys()].filter((sfx) => !need.has(sfx));

  /* THE DIVISOR IS ONLY USED WHERE IT COVERS WHAT WE HOLD. When our compartment
     set is not what the build text decodes to, the DECODE and our ROWS disagree
     — and that is a fact about the COMPARTMENT axis, which the reconcile's
     variant half owns and the sofa-corrections lane repairs. It is not a
     statement about the LINE, and letting it decide the line verdict is how a
     decoder weakness becomes a fabricated "we cannot check this document".
     Measured 2026-09-08 (run 34190818236): treating it as undecidable returned
     five sales orders and six delivery orders as AMBIGUOUS whose line, model,
     quantity and money all agree — `HC-SO-011099` holds `1A(LHF)` + `1A(RHF)`
     under a build text reading `2S`, which is a compartment question, not a
     missing line. The disagreement is REPORTED (`note`), never counted. */
  const usable = need.size > 0 && extra.length === 0;
  if (usable) {
    const ratios = [...need.entries()].map(([sfx, n]) => (ours.get(sfx) ?? 0) / n);
    const lo = Math.min(...ratios);
    const hi = Math.max(...ratios);
    if (lo === hi && Number.isInteger(lo)) return { lo, hi, undecided: false, why: "", note: "" };
    return {
      lo, hi, undecided: true, note: "",
      why: `one sofa of this build needs ${[...need.entries()].map(([sfx, n]) => `${sfx} x${n}`).join(", ")}` +
        `, and we hold ${show()} — that is not a whole number of sofas`,
    };
  }

  /* NO USABLE DIVISOR. Every row of one build carries that book line's own
     quantity, so a build whose quantities all AGREE is still decided at that
     quantity — two identical rows are two sofas, which is what
     lib/sofa-build-plan.mjs `splitBuildCopies` established. Quantities that
     DISAGREE cannot be told apart: two `1NA` rows are two pieces of one sofa or
     one piece of two sofas, and only a build text we could decode would say
     which. Those are the honest residue. */
  const qs = [...ours.values()];
  const lo = Math.min(...qs);
  const hi = Math.max(...qs);
  const note = need.size === 0
    ? ""
    : `our compartments (${show()}) are not what the build text decodes to ` +
      `(${[...need.entries()].map(([sfx, n]) => `${sfx} x${n}`).join(", ")}) — a COMPARTMENT question, ` +
      "not a missing line";
  if (lo === hi) return { lo, hi, undecided: false, why: "", note };
  return {
    lo, hi, undecided: true, note,
    why: `no usable build text, and our quantities inside one build are uneven (${show()})`,
  };
}

/**
 * Compare two bags.
 *
 * @param {object} a
 * @param {Map} a.book  from bagOf(..., "book")
 * @param {Map} a.erp   from bagOf(..., "erp")
 * @param {boolean} [a.compareMoney]  false where the type's price is DERIVED
 *   (goods receipt takes it from the purchase order; a migrated delivery order
 *   carries none), because comparing it there measures our own derivation.
 * @returns {{verdict: "IDENTICAL"|"DIFFERS"|"AMBIGUOUS", differences: string[],
 *            ambiguities: string[], keys: number}}
 */
export function compareBags({ book, erp, compareMoney = true }) {
  const differences = [];
  const ambiguities = [];
  const keys = [...new Set([...book.keys(), ...erp.keys()])].sort();

  for (const k of keys) {
    const b = book.get(k);
    const e = erp.get(k);

    if (!b) {
      differences.push(`${k}: the book has no such item; ours has qty ${fmtQty(e.qty)}${money(e, compareMoney)}`);
      continue;
    }
    if (!e) {
      /* The FREE LINE is the one legitimate absence: AutoCount bills a gift as
         its own line at RM 0.00 (`AK-SLEEP ESSENTIAL 7 HOLES` on a mattress)
         and the ERP does not carry it. Anything the book puts money on is a
         missing line and stays one — the same rule check-ac-erp-reconcile.mjs
         applies per item code. */
      if (b.sen === 0) continue;
      differences.push(`${k}: the book has qty ${fmtQty(b.qty)}${money(b, true)}; we have NO such line`);
      continue;
    }

    /* A fold that cannot state a quantity must not be allowed to state a verdict
       either — in either direction. */
    if (e.kind === "sofa" && e.undecided) {
      ambiguities.push(
        `${k}: the book says qty ${fmtQty(b.qty)}, and our side folds to between ${fmtQty(e.qty)} and ` +
          `${fmtQty(e.ceiling)} whole sofa(s) — ${e.why.join(" ; ")}`,
      );
      continue;
    }

    if (Math.abs(b.qty - e.qty) > QTY_EPS) {
      differences.push(`${k}: book qty ${fmtQty(b.qty)} vs ours ${fmtQty(e.qty)}`);
      continue;
    }
    if (compareMoney && b.sen !== e.sen) {
      differences.push(`${k}: qty agrees (${fmtQty(b.qty)}) but book RM ${rm(b.sen)} vs ours RM ${rm(e.sen)}`);
    }
  }

  const verdict = differences.length ? "DIFFERS" : ambiguities.length ? "AMBIGUOUS" : "IDENTICAL";
  return { verdict, differences, ambiguities, keys: keys.length };
}

/** Both bags as one printable line each, so an ambiguous document can be shown
 *  to a person in full rather than counted into a bucket. */
export function printableBag(bag) {
  return [...bag.values()]
    .sort((a, b) => (a.key > b.key ? 1 : -1))
    .map((e) => {
      const q = e.kind === "sofa" && e.undecided
        ? `${fmtQty(e.qty)}..${fmtQty(e.ceiling)}`
        : fmtQty(e.qty);
      return `${e.key} x${q} @ RM ${rm(e.sen)}`;
    })
    .join(" | ") || "(no lines)";
}

const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4))));
const rm = (s) => (s == null ? "—" : (s / 100).toFixed(2));
const money = (e, on) => (on ? ` at RM ${rm(e.sen)}` : "");
