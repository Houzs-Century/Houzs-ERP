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
// THE FOLD RULE FOR QUANTITY IS `MIN`, and it is the same choice
// lib/sofa-piece-fold.mjs made and for the same reason: a whole sofa is only
// whole while every one of its pieces is present, so the number of sofas is the
// MINIMUM across the distinct compartment SKUs, never the maximum. When min and
// max disagree the pieces are uneven and the fold CANNOT decide how many sofas
// that is — so this module says AMBIGUOUS and prints both sides, rather than
// picking one and calling the document clean. That is the whole point: the
// ambiguous set must be small, named, and per-document, not a bucket.
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
import { normCode } from "./ac-mapping-csv.mjs";

/** The same /SOFA/ substring test check-ac-erp-reconcile.mjs uses on the BOOK's
 *  raw ItemCode. It is deliberately loose: "AMN-SOFA PILLOW" takes this branch
 *  too, which is why a model is required on both sides before anything folds. */
export const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));

const QTY_EPS = 1e-6;

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
      bag.set(key, { key, kind: model ? "sofa" : "plain", qty: 0, sen: 0, pieces: new Map(), codes: new Set() });
    }
    const e = bag.get(key);
    e.codes.add(code);
    e.sen += Number.isFinite(r.sen) ? r.sen : 0;
    const q = Number.isFinite(r.qty) ? r.qty : 0;
    if (model && side === "erp") {
      /* Compartment quantities are NOT summed: three pieces of one sofa are one
         sofa, not three. They are collected per piece and folded below. */
      e.pieces.set(code, (e.pieces.get(code) ?? 0) + q);
    } else {
      e.qty += q;
    }
  }
  /* Fold each ERP sofa group to whole sofas. `whole` is the MIN across distinct
     compartment SKUs; `ceiling` is the MAX. They differ only when the pieces
     are uneven, and that difference is reported, never averaged away. */
  for (const e of bag.values()) {
    if (e.kind !== "sofa" || e.pieces.size === 0) continue;
    const qs = [...e.pieces.values()];
    e.qty = Math.min(...qs);
    e.ceiling = Math.max(...qs);
  }
  return bag;
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

    /* An uneven sofa fold cannot state a quantity, so it must not be allowed to
       state a verdict either — in either direction. */
    if (e.kind === "sofa" && e.ceiling != null && e.ceiling !== e.qty) {
      ambiguities.push(
        `${k}: the book says qty ${fmtQty(b.qty)}; our compartments are uneven ` +
          `(${[...e.pieces.entries()].sort().map(([c, q]) => `${c} x${fmtQty(q)}`).join(", ")}), ` +
          `so the fold gives between ${fmtQty(e.qty)} and ${fmtQty(e.ceiling)} whole sofa(s)`,
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
      const q = e.kind === "sofa" && e.ceiling != null && e.ceiling !== e.qty
        ? `${fmtQty(e.qty)}..${fmtQty(e.ceiling)}`
        : fmtQty(e.qty);
      return `${e.key} x${q} @ RM ${rm(e.sen)}`;
    })
    .join(" | ") || "(no lines)";
}

const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4))));
const rm = (s) => (s == null ? "—" : (s / 100).toFixed(2));
const money = (e, on) => (on ? ` at RM ${rm(e.sen)}` : "");
