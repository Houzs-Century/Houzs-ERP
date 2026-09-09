// ---------------------------------------------------------------------------
// ac-chain-shape — the migrated invoice chain's line SHAPE, split and RECORDED.
//
// WHY THIS MODULE EXISTS. A sales or purchase INVOICE in the ERP is built from
// OUR delivery order / goods receipt, not copied from AutoCount's IVDTL /
// PIDTL. So the NUMBER of rows on it is ours and what must agree is the money,
// and TWO of the reconcile's axes are that one fact seen from two ends:
//
//   `line count`                  our row count differs from the book's
//   `a book line we do not have`  which book row is the one we do not carry
//
// They must never answer differently about the same document on the same run,
// so they are split here, from ONE set of facts, in one place — the same reason
// `lib/ac-transfer-chain-report.mjs` exists beside its rule module rather than
// living inline in the reconcile.
//
// AND THE MEASUREMENT HAS TO REACH THE PER-DOCUMENT VERDICT. From 2026-09-08
// `splitMigratedChainLineShape` decided the line-count half and its answer was
// printed in the SUMMARY and nowhere else — nothing called `reclassify` — so
// nine sales invoices the run had already cleared were reported to the owner as
// work (docs/bugs/0746). That is docs/bugs/0715's failure with the arrow
// reversed: there a comparison that never ran was counted as a difference, here
// a split that DID run was thrown away. `apply` below is the hook, and
// tests/migratedChainShapeWiring.test.ts is what stops it being unhooked again.
//
// IT DECIDES NOTHING ITSELF. The verdict per document is
// lib/ac-not-a-difference.mjs's, from the `shapeFacts` the reconcile's own
// comparison loop measured; this module routes that answer and prints it. The
// two gates live there and are unchanged: the document TOTAL identical to the
// sen, and every item code agreeing on quantity and money.
//
// NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
// Windows vitest reason).
// ---------------------------------------------------------------------------

import { splitMigratedChainLineShape, splitMigratedChainUnpairedBookLine } from "./ac-not-a-difference.mjs";

/** The declared class both axes are reclassified into. Named once. */
export const NOTE_CHAIN_SHAPE = "migrated-chain-line-shape";

const inert = (rows, why) => ({
  lineShape: 0, differ: rows.length, moved: [], impostors: [], applied: false, why,
});

/**
 * Split both axes and RECORD the result on the per-document verdict.
 *
 * @param {object} a
 * @param {boolean} a.eligible          `cfg.migratedChainLineShape` — the TYPE
 *   config decides, never a list of type letters written here.
 * @param {string} a.t                  document type
 * @param {{key:string,erpNo:string,line:string}[]} a.lineCountRows
 * @param {{key:string,erpNo:string,line:string}[]} a.unpairedBookLineRows
 * @param {Map<string,{totalsEqual:boolean,perCode:object[]}>} a.shapeFacts
 * @param {{reclassify:Function}} a.recorder
 * @returns {{LS:object,UB:object}}
 */
export function applyChainShape({ eligible, t, lineCountRows, unpairedBookLineRows, shapeFacts, recorder }) {
  const facts = shapeFacts && shapeFacts.size ? shapeFacts : null;
  const LS = eligible
    ? splitMigratedChainLineShape({ rows: lineCountRows, facts })
    : inert(lineCountRows, "this type is not built by the migrated invoice chain, so a line-count difference is a difference");
  const UB = eligible
    ? splitMigratedChainUnpairedBookLine({ rows: unpairedBookLineRows, facts })
    : inert(unpairedBookLineRows, "this type is not built by the migrated invoice chain, so a book line we do not have is a difference");
  /* The caller passes the split's OWN output and no predicate of its own;
     `reclassify` is a no-op unless that axis really was recorded on that
     document, so this cannot invent a clean row. */
  if (LS.applied) for (const r of LS.moved) recorder.reclassify(t, r.key, "line count", NOTE_CHAIN_SHAPE, r.line);
  if (UB.applied) {
    for (const r of UB.moved) recorder.reclassify(t, r.key, "a book line we do not have", NOTE_CHAIN_SHAPE, r.line);
  }
  return { LS, UB };
}

/**
 * Print what was moved and what was refused. The refused half is printed LOUDER
 * than an ordinary difference, because a document dressed as benign is the one
 * nobody goes and looks at.
 */
export function reportChainShape({ t, LS, UB, log, plain, first, show }) {
  if (LS.lineShape) {
    log(`${t} — ${LS.lineShape} line-count difference(s) are a line SHAPE, not a missing line: ${LS.why}`);
    for (const row of first(LS.moved)) plain(`      ${row.line}`);
  }
  if (LS.impostors.length) {
    log(`${t} LINE COUNT — ${LS.impostors.length} document(s) differ in line count AND do not reconcile. Every one stays counted as a difference:`);
    for (const row of LS.impostors.slice(0, show)) plain(`      ${row.line} — ${row.why}`);
  }
  if (UB.lineShape) {
    log(`${t} — ${UB.lineShape} document(s) carry a book line we do not have that is the SAME shape: ${UB.why}`);
    for (const row of first(UB.moved)) plain(`      ${row.line}`);
  }
  if (UB.impostors.length) {
    log(`${t} A BOOK LINE WE DO NOT HAVE — ${UB.impostors.length} document(s) do not reconcile. Every one stays counted as a difference:`);
    for (const row of UB.impostors.slice(0, show)) plain(`      ${row.line} — ${row.why}`);
  }
}
