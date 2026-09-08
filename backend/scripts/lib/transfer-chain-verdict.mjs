/* transfer-chain-verdict — the PURE classifier for TRANSFER FROM, the direction
 * nothing was measuring.
 *
 * The owner, 2026-09-08: 「SO PO GR PI SI DO 等等？都解决了吗？ 然后transfer from
 * 和transfer to？」
 *
 * ── THE GAP THIS CLOSES, STATED AS IT WAS FOUND ────────────────────────────
 * check-ac-erp-reconcile.mjs read `transferedQty` / `fromDocType` / `fromDocNo`
 * ONLY to decide SCOPE — "outstanding = Qty > TransferedQty and not invoiced
 * direct". `LOCKING_AXES` in lib/so-verdict-derive.mjs held document presence,
 * line count, SKU, quantity, unit price, document total, currency and the
 * variant axes, and NOT ONE member for where a line came from. So the chain was
 * used as a FILTER and never as a COMPARISON: a line could point at the wrong
 * source document, or carry the wrong transferred quantity, and every report
 * would still have said the sales orders tally. One column carrying several
 * populations — this repo's own named class, found by the owner asking.
 *
 * ── IT IS THE *FROM* HALF ONLY, ON PURPOSE ─────────────────────────────────
 * The *TO* half — how much of a line has been transferred on — already has a
 * single-source rule in lib/transfer-counter-verdict.mjs, cross-multiplied so a
 * sofa's decomposition cannot read as a defect, with its own self-test. It is
 * RE-EXPORTED at the bottom of this file rather than restated. Two statements
 * of one rule is the failure this repo has paid for three times, most recently
 * two copies of the sofa pairing rule answering oppositely about HC-PO-010040
 * twenty minutes apart (docs/bugs/0708).
 *
 * ── THE THREE FACTS ABOUT THIS BOOK THAT SHAPE EVERY VERDICT BELOW ─────────
 * Measured on data/ac-convert-edges.json.gz (2026-09-07 cut) and RE-MEASURED
 * by the runner every run — lib/ac-transfer-chain-run.mjs asserts them from the
 * snapshot and refuses if the book stops behaving this way, so this header is
 * an explanation and never the evidence.
 *
 *   1. `FromDocDtlKey` IS NULL ON ALL ~220,000 ROWS of all six detail tables.
 *      AutoCount does not record which LINE a delivery, invoice, receipt or
 *      purchase invoice was raised from. It records the source DOCUMENT and
 *      nothing finer. So "does the source LINE agree" is answerable on exactly
 *      ONE edge — SO->PO, which AutoCount stores differently as
 *      `PODTL.FromSODtlKey` (10,792 rows) — and on the other four it is
 *      UNANSWERABLE. Reporting document agreement as line agreement would be
 *      claiming a comparison that never ran, which is the permissive answer
 *      lib/so-verdict-derive.mjs's header forbids being reachable.
 *
 *   2. `PODTL.FromDocType` IS NULL on all 18,890 PO rows while `FromDocNo` is
 *      set on 10,291. AutoCount stamps no type on the SO->PO edge, even on a
 *      document its own SDK created minutes earlier; every OTHER edge carries
 *      one. A classifier that requires a type to believe a source reports a
 *      false failure on every purchase order in the book — qa-matrix.ps1's
 *      "5a link PO<-SO" did exactly that. Hence `namesSource` tests the DocNo.
 *
 *   3. `PODTL.FromDocNo` can name SEVERAL sales orders in one field.
 *      lib/ac-scope.mjs already splits it on /[,;\s]+/ to decide scope, so the
 *      same split is stated here ONCE, exported, and used by both halves rather
 *      than written a second time.
 *
 * ── WHY THERE ARE THREE OUTCOME SETS AND NOT TWO ───────────────────────────
 * `IS_DIFFERENCE` locks a document. `IS_UNANSWERABLE` does not, and must not:
 * a book that never recorded a source line is not our defect, and neither is a
 * parent the ERP created after the snapshot was photographed. But neither is it
 * agreement, and folding it into `agree` is how 110 documents came to be
 * reported as clean on 2026-09-08 while nothing had compared them. Everything
 * else — a source the book does not state — is simply not a finding.
 *
 * PURE. No filesystem, no database, no clock, no printing. The caller owns the
 * I/O and lib/ac-transfer-chain-run.mjs owns the reads.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** Every verdict the FROM half can reach. The runner's vocabulary. */
export const FROM_VERDICTS = Object.freeze([
  /* the book raised this line from nothing — a sales order, a purchase order
     typed from scratch. Not a finding in either direction. */
  "book_states_no_source",
  /* the book names a source document AND a source line, and both agree. The
     strongest answer available, and only the SO->PO edge can reach it. */
  "agree_line",
  /* the source DOCUMENT agrees and the book states no source LINE for this
     edge (fact 1). Agreement at the finest grain the book can state — not at
     line grain, and never reported as if it were. */
  "agree_doc_line_unstated",
  /* the source document agrees, the book DOES state a line, and our row
     carries no AutoCount line key to answer with. A backfill, not a wrong
     link — backfill-ac-downstream-line-keys.mjs is what fills it. */
  "line_not_stamped",
  /* our line names a parent the book does not — the INVENTED link. */
  "doc_differs",
  /* right document, wrong line. Only reachable on the SO->PO edge. */
  "line_differs",
  /* the book raised this line from a document and we hold no parent link at
     all. The MISSING link. */
  "erp_link_missing",
  /* our parent exists but carries no AutoCount number, so there is nothing to
     compare it against. An ERP-native parent, or one the cutover never
     stamped. */
  "erp_parent_unstamped",
]);

/** The verdicts that LOCK a document. A wrong link and a missing one. */
export const IS_DIFFERENCE = Object.freeze(new Set(["doc_differs", "line_differs", "erp_link_missing"]));

/**
 * The verdicts where the comparison DID NOT RUN. They do not lock and they are
 * not agreement; the report prints them in their own column so neither
 * neighbour can absorb them.
 */
export const IS_UNANSWERABLE = Object.freeze(
  new Set(["agree_doc_line_unstated", "line_not_stamped", "erp_parent_unstamped"]),
);

/* A document number is compared trimmed and case-folded, because AutoCount and
   the ERP have disagreed about both and neither difference is a wrong link.
   A LINE KEY is compared trimmed and NOTHING ELSE: it is an opaque integer, and
   coercing it through Number would make "884412" and "884412.0" equal. */
const doc = (s) => String(s ?? "").trim().toUpperCase();
const key = (s) => String(s ?? "").trim();

/**
 * The source documents one `FromDocNo` field names. Stated ONCE here because
 * lib/ac-scope.mjs splits the same field the same way to decide scope, and two
 * statements of one rule is how a checker comes to measure a population no
 * importer ever carried.
 */
export const sourceDocTokens = (fromDocNo) =>
  doc(fromDocNo).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

/**
 * Does the book state that this line came from somewhere?
 *
 * THE DOC NUMBER DECIDES, NOT THE TYPE. Fact 2: `PODTL.FromDocType` is NULL on
 * every SO->PO row in this book, so a type test reports the whole purchase-order
 * corpus as sourceless.
 */
export const namesSource = (g) => sourceDocTokens(g?.bookFromDocNo).length > 0;

/**
 * The verdict for ONE child line.
 *
 * g = {
 *   bookFromDocType,   the book's FromDocType — "" on the SO->PO edge (fact 2)
 *   bookFromDocNo,     the book's FromDocNo — may name SEVERAL (fact 3)
 *   bookFromLineKey,   the book's FromSODtlKey — "" on four of five edges (fact 1)
 *   erpHasLink,        does our row carry a parent foreign key at all
 *   erpParentDocNo,    the AutoCount number our parent DOCUMENT carries, or null
 *   erpParentLineKey,  the AutoCount DtlKey our parent LINE carries, or null
 * }
 */
export function fromVerdictFor(g) {
  const wanted = sourceDocTokens(g?.bookFromDocNo);
  if (!wanted.length) return "book_states_no_source";

  /* THE MISSING LINK, and it is checked before anything else: the book says
     this line was transferred from a document and our row points at nothing.
     Nothing downstream can make that agreement. */
  if (!g.erpHasLink) return "erp_link_missing";

  /* We hold a parent, but it is not a document the book can be asked about.
     NOT a difference — an ERP-native parent is exactly what the shop trading
     during cutover produces — and NOT agreement either. */
  const mine = doc(g.erpParentDocNo);
  if (!mine) return "erp_parent_unstamped";

  if (!wanted.includes(mine)) return "doc_differs";

  /* The document agrees. Now the LINE, on the one edge the book states it. */
  const bookLine = key(g.bookFromLineKey);
  if (!bookLine) return "agree_doc_line_unstated";

  const myLine = key(g.erpParentLineKey);
  if (!myLine) return "line_not_stamped";

  return myLine === bookLine ? "agree_line" : "line_differs";
}

/** Counts per verdict, for a list of classified lines. */
export function tallyFrom(groups) {
  const t = Object.fromEntries(FROM_VERDICTS.map((v) => [v, 0]));
  for (const g of groups) t[fromVerdictFor(g)] += 1;
  return t;
}

/* ── PLANTED CASES ──────────────────────────────────────────────────────────
 * Every one must land on its own verdict and nothing else. The runner calls
 * `runSelfTest()` BEFORE it reads a row and REFUSES on a failure: a classifier
 * that cannot classify must not go on reporting confidently, which is the trap
 * check-ac-transfer-counters.mjs's header records as already paid for. */
export function selfTestCases() {
  return [
    { name: "the head of the chain — a sales order comes from nothing",
      g: { bookFromDocType: "", bookFromDocNo: "", bookFromLineKey: "",
           erpHasLink: false, erpParentDocNo: null, erpParentLineKey: null },
      want: "book_states_no_source" },

    { name: "SO->PO: no FromDocType, a real source, line key on both sides and equal",
      g: { bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: "884412",
           erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884412" },
      want: "agree_line" },

    { name: "SO->PO: right document, WRONG line — the transposition this axis exists to catch",
      g: { bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: "884412",
           erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884413" },
      want: "line_differs" },

    { name: "SO->PO: right document, our line carries no key yet",
      g: { bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: "884412",
           erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: null },
      want: "line_not_stamped" },

    { name: "DO<-SO: the book states no source LINE, so document agreement is all there is",
      g: { bookFromDocType: "SO", bookFromDocNo: "SO-002281", bookFromLineKey: "",
           erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884412" },
      want: "agree_doc_line_unstated" },

    { name: "one purchase order raised for TWO sales orders — either parent agrees",
      g: { bookFromDocType: "", bookFromDocNo: "SO-002281, SO-002282", bookFromLineKey: "",
           erpHasLink: true, erpParentDocNo: "SO-002282", erpParentLineKey: null },
      want: "agree_doc_line_unstated" },

    { name: "our parent is a document the book never names — the INVENTED link",
      g: { bookFromDocType: "SO", bookFromDocNo: "SO-002281", bookFromLineKey: "",
           erpHasLink: true, erpParentDocNo: "SO-009999", erpParentLineKey: null },
      want: "doc_differs" },

    { name: "the book raised it from a receipt and we hold no link — the MISSING link",
      g: { bookFromDocType: "GR", bookFromDocNo: "GR-005322", bookFromLineKey: "",
           erpHasLink: false, erpParentDocNo: null, erpParentLineKey: null },
      want: "erp_link_missing" },

    { name: "our parent carries no AutoCount number — nothing to compare, not a defect",
      g: { bookFromDocType: "PO", bookFromDocNo: "PO-004410", bookFromLineKey: "",
           erpHasLink: true, erpParentDocNo: null, erpParentLineKey: null },
      want: "erp_parent_unstamped" },

    /* THE NON-DEFECT. Case and surrounding whitespace have differed between the
       two systems on documents that are the same document, and reporting that
       as a wrong link would be this lane's own first false finding. */
    { name: "case and whitespace on the document number are not a wrong link",
      g: { bookFromDocType: "SO", bookFromDocNo: " so-002281 ", bookFromLineKey: "",
           erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: null },
      want: "agree_doc_line_unstated" },
  ];
}

export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = fromVerdictFor(c.g);
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  /* The three sets must partition. A verdict that is both a difference and
     unanswerable would be counted in two columns of the same report. */
  for (const v of FROM_VERDICTS) {
    if (IS_DIFFERENCE.has(v) && IS_UNANSWERABLE.has(v)) failures.push(`${v} is both a difference and unanswerable`);
  }
  for (const v of [...IS_DIFFERENCE, ...IS_UNANSWERABLE]) {
    if (!FROM_VERDICTS.includes(v)) failures.push(`${v} is classified but is not a declared verdict`);
  }
  return failures;
}

/* ── THE *TO* HALF, RE-EXPORTED AND NEVER RESTATED ──────────────────────────
 * lib/transfer-counter-verdict.mjs is the ONE statement of "the book moved t of
 * q, we moved T of Q". Callers of this module get it from here so there is a
 * single import for the chain, and it is the SAME function
 * check-ac-transfer-counters.mjs calls — not a copy that can drift from it. */
export {
  VERDICTS as TO_VERDICTS,
  isOneToOne,
  tally as tallyTo,
  verdictFor as toVerdictFor,
  runSelfTest as runToSelfTest,
} from "./transfer-counter-verdict.mjs";
