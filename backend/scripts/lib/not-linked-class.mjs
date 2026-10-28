// WHY an ERP line carries NO link to its source, in one word, for one line.
//
// check-ac-convert-symmetry's matrix has carried a `not linked` column since
// #3049 and NOBODY HAS EVER ACCOUNTED FOR IT: 765 ERP lines that point at no
// source at all, printed as one number with no cause attached. A single number
// covering four unrelated populations is the same shape the `item code` column
// was in before lib/item-code-class.mjs split it (#3167) - three populations
// wearing one number, only one of them a defect - and this file is the same
// remedy for the same reason.
//
// THIS IS NOT COSMETIC. A bedframe / sofa / (SP) mattress line is HARD-BOUND
// (isHardBoundLine, src/scm/lib/so-stock-allocation.ts): for company 1 it reads
// READY only through its OWN dedicated purchase-order line, and never through
// the pooled walk. A purchase-order line with no so_item_id therefore lights
// nothing up, and the sales order behind it stays PENDING with the goods
// standing in the warehouse. docs/bugs/0672 was the MIS-linked version of that;
// an absent link is the UN-linked version.
//
// The five causes, and only the last is ours:
//
//   ERP_NATIVE     the child document was never imported from AutoCount - it
//                  was raised in the ERP. There is no book edge to hold, and
//                  the ERP's own rule allows a standalone line (mig 0303:
//                  "a Sales Invoice MAY carry a direct/standalone line").
//   BOOK_NO_EDGE   the book's own line names NO source of this type. Not-linked
//                  is CORRECT and IDENTICAL TO THE BOOK.
//   OUT_OF_SCOPE   the book names a source document the cutover never imported.
//                  The ERP holds a child whose parent is not here to link to.
//   DOC_GRAIN_ONLY the book names the source DOCUMENT and stores nothing finer.
//                  Measured, not recited: FromDocDtlKey is populated on 0 of
//                  ~220,000 rows of all six detail tables, so SO->PO
//                  (PODTL.FromSODtlKey) is the ONE edge with a real line key.
//                  A line-grain link is unobtainable from the BOOK for the rest
//                  - a limit of the book, not a defect of ours.
//   DROPPED        the book states the link at a grain we CAN reach and the
//                  parent line is in the ERP, and we still have no link. THIS
//                  is the defect, and the only class that may be repaired.
//
// DROPPED IS NOT THE SAME AS REPAIRABLE, and this file deliberately does not
// pretend otherwise. probe-po-so-link-recoverable.mjs applies one more gate
// before anything may be written: the two ends must name the SAME PRODUCT. A
// key pair is not an identity match, and skipping that comparison is exactly
// what put nine sales-order lines on a purchase-order line for a different bed
// (docs/bugs/0671, class 0672). That gate lives in ONE place - the probe - and
// is not reproduced here, because two implementations of one rule is how they
// come to disagree. DROPPED is therefore an upper bound on what a repair may
// write, and the report says so where it prints the number.
//
// UNRESOLVED is the sixth answer and it is deliberately NOT a benign bucket: it
// is the honest "we cannot say" - the child document is not in the snapshot,
// the SO->PO line key is absent, or the book's source line is carried by
// several ERP rows so the book cannot say which took the goods. It must never
// be folded into a benign class - the whole point of splitting the column is
// that a real gap can no longer hide inside one, so what cannot be classified
// is named as such.
//
// THE ROUTE TO THE BOOK IS PER EDGE, AND GETTING THAT WRONG MANUFACTURES A GAP.
// This classifier's first version read every edge through the child line's
// linked_ac_dtlkey and reported 360 of the 765 as "no AutoCount line key"
// (run 34183990531). Migration 0280's own header refutes that reading: it ADDED
// that column to the four downstream tables and states "nothing backfills it:
// the keys are stamped forward", so a MIGRATED delivery note, receipt or
// invoice has no key by design. Only SO->PO is read through the line key now;
// the other five are read through the child DOCUMENT, which is the grain the
// book stores them at anyway.
//
// PURE: identifiers and lookup callbacks in, a verdict out. No filesystem, no
// database, no process.exit. The caller owns the I/O.
//
// NO SHEBANG: tests/notLinkedClass.test.mjs imports this module (see
// lib/release-discipline.mjs for the Windows vitest reason).

/** The classes, in the order the report prints them. `benign` marks the ones
 *  where an absent link is the CORRECT state, so a reader can see at a glance
 *  which part of the column is a finding and which part is agreement. */
export const NOT_LINKED_CLASSES = [
  { id: "erp_native", benign: true, label: "raised in the ERP, never imported - no book edge exists" },
  { id: "book_no_edge", benign: true, label: "the book's own line names no source - identical to the book" },
  { id: "out_of_scope", benign: true, label: "the book names a parent the cutover did not import" },
  { id: "doc_grain_only", benign: true, label: "the book records a document number and nothing finer" },
  { id: "dropped", benign: false, label: "the book states it at a grain we can reach - OUR DEFECT" },
  { id: "unresolved", benign: false, label: "the book cannot be reached, or cannot say which line - CANNOT SAY" },
];

const BENIGN = new Set(NOT_LINKED_CLASSES.filter((c) => c.benign).map((c) => c.id));
export const isBenignNotLinked = (cls) => BENIGN.has(cls);

/**
 * Classify ONE unlinked ERP child line.
 *
 * @param {object} a
 * @param {string|null} a.childAcDocNo  AutoCount doc number on the CHILD header; null = ERP-native
 * @param {string|null} a.childDtlKey   AutoCount DtlKey on the CHILD line (as text), or null
 * @param {object|null} a.bookLine      the book line that DtlKey resolves to, or null.
 *   Read ONLY on the line-keyed edge; the other five have no line key to follow.
 * @param {object[]|null} a.bookChildLines  every line of the CHILD document in the
 *   book, or null when that document is not in the snapshot. This is the route
 *   for the five document-grain edges - see the block that uses it for why the
 *   DtlKey route is structurally wrong there.
 * @param {boolean} a.lineKeyed         does the BOOK record a source LINE for this edge (SO->PO only)
 * @param {string|null} a.fromType      the FromDocType this edge expects; null on the line-keyed edge
 * @param {(docNo: string) => boolean} a.parentImported   is that parent document in the ERP
 * @param {(dtlKey: string) => number} a.parentLineCount  HOW MANY ERP rows carry that parent line
 *   key. A COUNT, not a boolean, on purpose: 296 sales-order DtlKeys are carried
 *   by more than one ERP row (0273 / 0280 - a sofa is one book line and one ERP
 *   row per compartment), and a lookup that answered yes/no would let the caller
 *   pick one of them, which is the coin flip probe-po-so-link-recoverable
 *   refuses. Two is not "found".
 * @returns {{cls: string, why: string, parentDocNo: string|null, parentDtlKey: string|null}}
 *   `parentDocNo` / `parentDtlKey` are what the BOOK says the source is - copied,
 *   never inferred, and null whenever the book does not say.
 */
export function classifyNotLinked({
  childAcDocNo,
  childDtlKey,
  bookLine,
  bookChildLines,
  lineKeyed,
  fromType,
  parentImported,
  parentLineCount,
}) {
  const none = { parentDocNo: null, parentDtlKey: null };

  /* The document itself never came from AutoCount. Nothing downstream applies:
     there is no book line to consult and no edge to have dropped. */
  if (childAcDocNo == null || String(childAcDocNo).trim() === "") {
    return { cls: "erp_native", why: "the child document carries no AutoCount number", ...none };
  }

  /* ── THE LINE-KEYED EDGE, SO->PO ────────────────────────────────────────
     PODTL.FromSODtlKey names the source LINE, so the child's own DtlKey is the
     right route: it is the only edge where the book has anything finer than a
     document to say. Without that key there is nothing to read, and that is an
     ANSWER, not a bucket to hide in. */
  if (lineKeyed) {
    if (childDtlKey == null || String(childDtlKey).trim() === "") {
      return { cls: "unresolved", why: "the child line carries no AutoCount DtlKey", ...none };
    }
    if (!bookLine) {
      return { cls: "unresolved", why: `DtlKey ${childDtlKey} resolves to no line in the book`, ...none };
    }
    if (!bookLine.fromSoDtlKey) {
      return { cls: "book_no_edge", why: "the book line carries no FromSODtlKey", ...none };
    }
    const key = String(bookLine.fromSoDtlKey);
    const doc = bookLine.fromDocNo ? String(bookLine.fromDocNo).trim() : null;
    if (doc && !parentImported(doc)) {
      return {
        cls: "out_of_scope",
        why: `the book source order ${doc} was not imported`,
        parentDocNo: doc,
        parentDtlKey: key,
      };
    }
    const held = parentLineCount(key);
    if (held === 0) {
      return {
        cls: "out_of_scope",
        why: `the book source LINE ${key}${doc ? ` on ${doc}` : ""} is not in the ERP`,
        parentDocNo: doc,
        parentDtlKey: key,
      };
    }
    /* TWO IS NOT FOUND. Where the key is carried by several ERP rows the book
       cannot say which of them took the goods, and choosing is the coin flip
       that put a REGAL in front of a TRION customer (docs/bugs/0671, 0672). */
    if (held > 1) {
      return {
        cls: "unresolved",
        why: `the book source LINE ${key} is carried by ${held} ERP rows - the book cannot say which`,
        parentDocNo: doc,
        parentDtlKey: key,
      };
    }
    return {
      cls: "dropped",
      why: `the book names source line ${key}${doc ? ` on ${doc}` : ""} and the ERP holds exactly one such row`,
      parentDocNo: doc,
      parentDtlKey: key,
    };
  }

  /* ── EVERY OTHER EDGE, RESOLVED AT DOCUMENT GRAIN ───────────────────────
     Reading these through the child's DtlKey was this classifier's own first
     mistake, and it is worth recording rather than quietly correcting: 360 of
     the 765 came back "no AutoCount line key" on run 34183990531, which reads
     as a gap and is nothing of the kind. Migration 0280 says so in its own
     header - it ADDED linked_ac_dtlkey to these four downstream tables, and
     "nothing backfills it: the keys are stamped forward". A migrated delivery
     note or receipt has no key BY DESIGN, so a route that needs one answers
     UNKNOWN for the entire migrated population. That is the trap this repo
     names as a checker that cannot match reporting a clean run, wearing its
     other face: a checker that cannot match reporting a false gap.
     The book stores these edges at DOCUMENT grain anyway (FromDocType +
     FromDocNo, and FromDocDtlKey NULL on all ~220,000 rows), so the child
     DOCUMENT is both the available route and the correct one. */
  if (bookChildLines == null) {
    return {
      cls: "unresolved",
      why: `the child document ${childAcDocNo} is not in the book snapshot`,
      ...none,
    };
  }
  const sources = [...new Set(bookChildLines
    .filter((l) => l.fromDocType === fromType && !!l.fromDocNo)
    .map((l) => String(l.fromDocNo).trim()))];
  if (sources.length === 0) {
    return {
      cls: "book_no_edge",
      why: `no line of book document ${childAcDocNo} names a ${fromType} source`,
      ...none,
    };
  }
  const imported = sources.filter((d) => parentImported(d));
  if (imported.length === 0) {
    return {
      cls: "out_of_scope",
      why: `the book source ${fromType} ${sources.join(", ")} was not imported`,
      parentDocNo: sources[0],
      parentDtlKey: null,
    };
  }
  return {
    cls: "doc_grain_only",
    why: `the book names ${fromType} ${imported.join(", ")} and stores no source line key`,
    parentDocNo: imported[0],
    parentDtlKey: null,
  };
}

/** Tally verdicts into { cls -> count }, every declared class present (a class
 *  that is zero must PRINT as zero, or a reader cannot tell an empty bucket
 *  from one the report forgot). */
export function tallyNotLinked(verdicts) {
  const t = Object.fromEntries(NOT_LINKED_CLASSES.map((c) => [c.id, 0]));
  for (const v of verdicts) t[v.cls] = (t[v.cls] ?? 0) + 1;
  return t;
}

/** How much of a tally is a FINDING - the two non-benign classes. */
export const findingsIn = (tally) =>
  NOT_LINKED_CLASSES.filter((c) => !c.benign).reduce((a, c) => a + (tally[c.id] ?? 0), 0);
