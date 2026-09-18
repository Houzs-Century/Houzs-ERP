/**
 * ONE ACCOUNT-BOOK SOFA LINE IS ONE ERP ROW PER COMPARTMENT — on the receipt,
 * the delivery note and the invoice too, not only on the order.
 *
 * ── WHAT WAS MISSING, AND WHY IT WAS INVISIBLE ──────────────────────────────
 * `apply-sofa-compartment-corrections.mjs` carries a corrected build DOWN the
 * chain — a GRN line copies the purchase-order line it received, a DO line
 * copies the sales-order line it delivered, an invoice line copies the receipt
 * or delivery line it was raised from. That carry is an `UPDATE` of `item_code`
 * and `variants` on rows that ALREADY EXIST, and it is exactly right for the
 * lead piece.
 *
 * It has no answer for the pieces the correction ADDED. A build that reached
 * the ERP as a bare `-1S` placeholder became one row; the correction makes the
 * order three rows; the receipt, the delivery note and the invoice keep the one
 * they were migrated with. Nothing is broken enough to fail: every row is
 * priced, every link is filled, no constraint fires. What the documents SAY is
 * that the factory received a chaise, the driver delivered a chaise and the
 * customer was billed for a chaise, when all three moved a three-piece sofa.
 *
 * Measured on production, probe run 34316985562, `HC-SO-000814`'s sofa:
 *
 *   sales order    HC-SO-000814   3 rows   L(LHF) + 1NA + 2A(RHF)
 *   purchase order HC-PO-000254   3 rows   L(LHF) + 2A(RHF) + 1NA
 *   goods receipt  HC-GR-000287   1 row    L(LHF)
 *   delivery note  HC-DO-000542   1 row    L(LHF)
 *   sales invoice  HC-I-000745    1 row    L(LHF)
 *
 * ── THIS MODULE IS THE DECISION, AND NOTHING ELSE ──────────────────────────
 * PURE: no database, no filesystem, no printing. It pairs the rows a downstream
 * document already holds onto the build's pieces and says which pieces have no
 * row. The writer applies it; `sofa-build-plan.mjs` owns the pairing rule and
 * is imported rather than restated, so the parent and the child cannot pair
 * differently.
 *
 * ── FOUR REFUSALS, EACH ONE A STOP ─────────────────────────────────────────
 *   1. NOTHING IS EVER DELETED DOWNSTREAM. A surplus row on a receipt or a
 *      delivery note is a statement that goods moved; the owner's rule is
 *      「不可以删只可以 cancel」 and 「已经出货了的就随便把」. A build that would
 *      have to remove one is REFUSED and named, never trimmed.
 *   2. THE MONEY DOES NOT MOVE. Every added piece is zero in every money
 *      column, so the document's total is arithmetically identical afterwards.
 *      The caller asserts that against the database; this module refuses to
 *      plan anything else.
 *   3. A DOCUMENT HOLDING THE BUILD TWICE IS REFUSED. Two identical sofas on
 *      one delivery note are two sofas, and which existing row belongs to which
 *      is not written down on the child side. The parent handles that case with
 *      `splitBuildCopies`; here it is a stop.
 *   4. A BUILD THAT IS NOT ON THE DOCUMENT AT ALL IS NOT A REFUSAL. It is
 *      simply not there — a purchase invoice was never raised, a delivery note
 *      covers a different order — and the caller skips it.
 *
 * Zero dependencies beyond the sibling lib, so `node --test scripts/lib/` runs
 * its test on a bare checkout.
 *
 * NO SHEBANG: a module a test imports must not carry one (CLAUDE.md).
 */
import { K, compartmentOf, pairRowsToPieces } from "./sofa-build-plan.mjs";

/**
 * What a downstream document has to become for it to state the build.
 *
 * @param {any[]} rows the document's rows for THIS build, in document order
 * @param {string[]} want the target piece codes, fully qualified and upper-cased
 * @param {(row:any)=>unknown} [codeOf]
 * @returns {{ ok: true, keep: {id:any,from:string,to:string}[], add: {to:string}[], template: any, how: string }
 *          | { ok: false, why: string }}
 */
export function planDownstreamParity(rows, want, codeOf = (r) => r.code) {
  const all = Array.isArray(rows) ? rows.slice() : [];
  if (!all.length) return { ok: false, why: "the build is not on this document" };
  const targets = (want || []).map(K);
  if (!targets.length) return { ok: false, why: "the build names no pieces" };

  /* REFUSAL 3, and it is measured rather than assumed: more rows than the build
     has pieces means either a second sofa or a row this build does not use, and
     both are stops. It is checked BEFORE pairing, because pairing would happily
     absorb the extra row into a piece and hide it. */
  if (all.length > targets.length) {
    return {
      ok: false,
      why: `the document holds ${all.length} row(s) for this build and the build has ${targets.length} piece(s) — ` +
        `either it carries the sofa twice or it holds a row this build does not use, and nothing here removes a ` +
        `receipt, delivery or invoice line`,
    };
  }

  const { pairs, surplus } = pairRowsToPieces(all, targets, codeOf);
  /* REFUSAL 1. `pairRowsToPieces` only ever leaves a row over when there are
     more rows than pieces, which the guard above has already refused — so this
     is unreachable today and is kept as an assertion rather than deleted,
     because "unreachable" is a property of the caller and not of this file. */
  if (surplus.length) {
    return {
      ok: false,
      why: `${surplus.length} row(s) on this document belong to no piece of the build ` +
        `(${surplus.map((r) => compartmentOf(codeOf(r)) || String(codeOf(r))).join(", ")}) — nothing here deletes one`,
    };
  }

  const keep = [];
  const add = [];
  for (const p of pairs) {
    if (p.row) keep.push({ id: p.row.id, from: K(codeOf(p.row)), to: p.want });
    else add.push({ to: p.want });
  }
  /* The row every added piece is CLONED from. It is the document's own first
     row for this build, so an inserted piece inherits that document's warehouse,
     unit of measure, dates, links and AutoCount line key rather than anything
     invented here. */
  const template = all[0];
  return {
    ok: true,
    keep,
    add,
    template,
    how: add.length
      ? `${keep.length} row(s) already stand for a piece, ${add.length} piece(s) have none`
      : "every piece already has a row on this document",
  };
}
