/* so-document-provenance — did the CUTOVER bring this sales order across, or did
 * the ERP raise it and our own write-back put it in the account book?
 *
 * ── WHY THE QUESTION EXISTS ────────────────────────────────────────────────
 * check-ac-erp-reconcile.mjs compares every ERP sales order that carries a
 * `linked_ac_docno` against the account book, and its whole purpose is to prove
 * the CUTOVER was faithful: AutoCount is the independent source and we are the
 * copy.
 *
 * That is not true of every document it compares. An order the ERP raised after
 * go-live reaches the book only because the ERP -> AutoCount write-back put it
 * there, so the "book" side of that comparison is OUR OWN OUTPUT. A difference
 * on it is a fidelity gap in the write-back, which the owner has ruled out of
 * scope — 「写回autocount的你不需要理了」, 2026-09-08 — and it is not evidence
 * about the migration either way.
 *
 * Measured on run 34303762513 (2026-09-09, `main`): three of the nineteen
 * sales orders the tally counted as DIFFER were ERP-raised — `HC-SO-2609-002`
 * (item code), `HC-SO-2609-005` (leg height), and `HC-SO-2609-006`, which was a
 * PHANTOM because the write-back had not reached the book cut yet. Thirty-seven
 * minutes earlier the same tally said eighteen, on run 34301296779.
 *
 * ── THE TEST IS STRUCTURAL, NOT A HEURISTIC, AND THAT IS THE POINT ─────────
 * The two numbering schemes cannot collide. A migrated order carries AutoCount's
 * number in `linked_ac_docno` (`SO-013503`) beside its own (`HC-SO-013503`); an
 * ERP-raised one was given its number by the ERP and the write-back sent that
 * same string to AutoCount, so both sides read `HC-SO-2609-002`.
 *
 * So `linked_ac_docno === doc_no` is a property a migrated document CANNOT
 * have, which is what makes this safe to state: the class cannot be widened to
 * make a count fall, however much anyone wants it to. That is the same standard
 * `splitUnmigratedOnwardTransfer` is held to in lib/ac-not-a-difference.mjs —
 * a bucket is only as good as the thing that keeps impostors out of it.
 *
 * ── IT DECIDES NOTHING, AND NOTHING IS RECLASSIFIED BY IT ──────────────────
 * This module answers a question. It is not wired into the reconcile, the tally
 * counts every one of these documents exactly as it did before, and moving them
 * into a bucket of their own is the owner's call, not a side effect of adding a
 * predicate. `docs/bugs/0736` is where the case for that bucket is written down.
 *
 * PURE. No filesystem, no database, no clock, no printing.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** The ERP raised this document; the book holds it via our write-back. */
export const ERP_RAISED = "ERP_RAISED";
/** AutoCount raised it and the cutover carried it across. */
export const MIGRATED = "MIGRATED";
/** It carries no account-book number, so this question does not arise. */
export const UNLINKED = "UNLINKED";

export const PROVENANCES = Object.freeze([ERP_RAISED, MIGRATED, UNLINKED]);

const t = (v) => String(v ?? "").trim();

/**
 * Where a sales order came from.
 *
 * CASE AND WHITESPACE ARE NORMALISED, because the two systems have disagreed
 * about both on documents that are the same document (lib/ac-transfer-chain-run
 * upper-cases for exactly this reason). Nothing else is normalised: a prefix is
 * NOT stripped, because "it looks like our numbering" is a guess and "the two
 * strings are the same string" is a fact.
 *
 * @param {{docNo: string|null, linkedAcDocNo: string|null}} row
 * @returns {"ERP_RAISED"|"MIGRATED"|"UNLINKED"}
 */
export function provenanceOf(row) {
  const ac = t(row?.linkedAcDocNo);
  const mine = t(row?.docNo);
  if (!ac) return UNLINKED;
  if (!mine) return MIGRATED;
  return ac.toUpperCase() === mine.toUpperCase() ? ERP_RAISED : MIGRATED;
}

/** Planted cases. Every one must land on its own answer and nothing else. */
export function selfTestCases() {
  return [
    { name: "a migrated order carries the book's number beside its own",
      row: { docNo: "HC-SO-013503", linkedAcDocNo: "SO-013503" }, want: MIGRATED },
    { name: "an ERP-raised order carries its own number on both sides",
      row: { docNo: "HC-SO-2609-002", linkedAcDocNo: "HC-SO-2609-002" }, want: ERP_RAISED },
    { name: "case and padding are the same document",
      row: { docNo: "HC-SO-2609-005", linkedAcDocNo: " hc-so-2609-005 " }, want: ERP_RAISED },
    { name: "no book number at all is neither",
      row: { docNo: "HC-SO-2609-009", linkedAcDocNo: null }, want: UNLINKED },
    { name: "an empty book number is not a match against an empty ERP number",
      row: { docNo: "", linkedAcDocNo: "" }, want: UNLINKED },
    /* THE ONE THAT KEEPS THE CLASS HONEST. A prefix is not stripped: an
       AutoCount number that merely RESEMBLES ours is still the book's own. */
    { name: "a book number that only resembles ours is still MIGRATED",
      row: { docNo: "HC-SO-2609-002", linkedAcDocNo: "SO-2609-002" }, want: MIGRATED },
    { name: "the 2990 shape is migrated too",
      row: { docNo: "HC-SO-000870", linkedAcDocNo: "SO-000870" }, want: MIGRATED },
  ];
}

export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = provenanceOf(c.row);
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  return failures;
}
