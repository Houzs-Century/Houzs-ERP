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

import {
  splitMigratedChainLineShape,
  splitMigratedChainUnpairedBookLine,
  splitUnmigratedSourceLine,
} from "./ac-not-a-difference.mjs";

/** The declared class both axes are reclassified into. Named once. */
export const NOTE_CHAIN_SHAPE = "migrated-chain-line-shape";

/** The declared class of the SECOND pass over `a book line we do not have`. */
export const NOTE_SOURCE_NOT_MIGRATED = "chain-source-not-migrated";

const inert = (rows, why) => ({
  lineShape: 0, differ: rows.length, moved: [], impostors: [], refused: rows, applied: false, why,
});

/**
 * Split both axes and RECORD the result on the per-document verdict.
 *
 * @param {object} a
 * @param {boolean} a.eligible          `cfg.migratedChainLineShape` — the TYPE
 *   config decides, never a list of type letters written here.
 * @param {string} a.t                  document type
 * @param {{key:string,erpNo:string,line:string}[]} a.lineCountRows
 * @param {{key:string,erpNo:string,bookDocNo:string,bookDtlKeys:string[],line:string}[]} a.unpairedBookLineRows
 * @param {Map<string,{totalsEqual:boolean,perCode:object[]}>} a.shapeFacts
 * @param {{reclassify:Function}} a.recorder
 * @param {object|null} a.sourceDecision   `UNMIGRATED_SOURCE[t]`, or null where
 *   no migration decision is declared for this type. REQUIRED, never optional:
 *   its absence decides that nothing is reclassified, and an argument a caller
 *   can forget applies the rule only where somebody remembered it.
 * @param {Set<string>|null} a.sourceCoverage  the source documents the ERP
 *   ACTUALLY holds, measured. `null` means it could not be read, and then
 *   nothing moves — an unproven decision is not a decision.
 * @param {(bookDocNo:string,bookDtlKey:string)=>{type:string,docNo:string}[]} a.sourceOf
 * @returns {{LS:object,UB:object,SRC:object}}
 */
export function applyChainShape({
  eligible, t, lineCountRows, unpairedBookLineRows, shapeFacts, recorder,
  sourceDecision, sourceCoverage, sourceOf,
}) {
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
  /* SECOND PASS, over the rows the shape proof REFUSED — never over all of
     them. A document the shape proof already cleared is not asked a second
     question, so the two lanes cannot both claim it and `preserveTotal` cannot
     count it twice. It also means this pass only ever sees the documents that
     are still being reported as work. */
  const SRC = splitUnmigratedSourceLine({
    rows: UB.refused, decision: sourceDecision, coverage: sourceCoverage, sourceOf,
  });
  if (SRC.applied) {
    for (const r of SRC.moved) {
      recorder.reclassify(t, r.key, "a book line we do not have", NOTE_SOURCE_NOT_MIGRATED, r.line);
    }
  }
  return { LS, UB, SRC };
}

/**
 * Print what was moved and what was refused. The refused half is printed LOUDER
 * than an ordinary difference, because a document dressed as benign is the one
 * nobody goes and looks at.
 */
export function reportChainShape({ t, LS, UB, SRC, log, plain, first, show }) {
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
  /* THE SECOND PASS. Printed with its proof, and the count it took OUT of the
     line below is stated in the same breath — a number that shrinks with no
     reason attached is the thing the owner has to come back and ask about. */
  if (SRC.notMigrated) {
    log(
      `${t} — ${SRC.notMigrated} document(s) carry a book line we do not have because the PURCHASE ORDER it ` +
        `was raised from was never migrated: ${SRC.why}`,
    );
    plain(`      PROVED per document, not assumed: EVERY unpaired book line on it names a source purchase order we do not hold.`);
    for (const row of first(SRC.moved)) plain(`      ${row.line}`);
  }
  /* ONE BLOCK FOR THE ONES THAT STAY, NOT TWO. The first production run
     (34376960030) printed the same 78 purchase invoices twice — once as "do not
     reconcile" with the shape reason, once as "SOURCE-ORDER DECISION REFUSED"
     with the source reason — because when the second pass refuses a row it
     refuses exactly the rows the first one did. Two counts of 78 for 78
     documents reads as 156 documents' worth of work. The two reasons belong on
     ONE line, and BOTH are printed: the shape reason says the money does not
     reconcile, the source reason says the migration decision does not cover it,
     and whoever works the document needs both. */
  const answered = new Set(SRC.applied ? SRC.moved.map((r) => r.key) : []);
  const srcWhy = new Map(SRC.impostors.map((i) => [i.key, i.why]));
  const stillCounted = UB.impostors.filter((i) => !answered.has(i.key));
  if (stillCounted.length) {
    log(
      `${t} A BOOK LINE WE DO NOT HAVE — ${stillCounted.length} document(s) do not reconcile` +
        (SRC.applied ? ", and the unmigrated-source-order decision does not cover them either" : "") +
        ". Every one stays counted as a difference:",
    );
    for (const row of stillCounted.slice(0, show)) {
      const extra = srcWhy.get(row.key);
      plain(`      ${row.line} — ${row.why}${extra ? ` — ${extra}` : ""}`);
    }
  }
  /* A row the SECOND pass refused that the FIRST pass never saw cannot happen
     today — it only ever runs on the first pass's refusals — but if that ever
     changes, the count must not vanish silently. */
  const orphaned = SRC.impostors.filter((i) => !stillCounted.some((s) => s.key === i.key));
  if (orphaned.length) {
    log(`${t} SOURCE-ORDER DECISION REFUSED for ${orphaned.length} further document(s). Every one is counted as a difference:`);
    for (const row of orphaned.slice(0, show)) plain(`      ${row.line} — ${row.why}`);
  }
}
