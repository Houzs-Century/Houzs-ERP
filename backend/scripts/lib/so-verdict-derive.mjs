/* so-verdict-derive — turn a reconcile RUN into a per-document verdict.
 *
 * The migrated-sales-order lock used to answer a question about ORIGIN. It now
 * answers one about CORRECTNESS: a migrated order is open when it MATCHES the
 * account book, and shut while it still differs. This module is where "still
 * differs" becomes a row per document.
 *
 * ── IT IS A RECORDER, NOT A SECOND COMPARISON ───────────────────────────────
 * Nothing here compares anything. check-ac-erp-reconcile.mjs already does that,
 * and its findings are what the owner reads; a SECOND implementation of
 * "different" is how two statements of one rule come to disagree while both
 * report on "the same" documents. That failure is written into that file's own
 * header twice — two CSV parsers for one sheet printed 40 wrong findings on
 * go-live morning (docs/bugs/0689), and two statements of the scope rule made a
 * checker measure a population no importer ever carried.
 *
 * So the reconcile CALLS this as it finds things, and this only tallies.
 *
 * ── A DOCUMENT MUST BE SEEN TO BE CLEAN ─────────────────────────────────────
 * `seen()` is not bookkeeping. Only a document the run actually COMPARED can
 * earn `clean`; a document that was never reached produces no row at all, and
 * the guard reads an absent row as `no-verdict-published`, which LOCKS. That is
 * the difference between "we checked it and it matches" and "we never looked",
 * and collapsing the two is the whole hazard this design exists to avoid.
 *
 * ── WHICH AXES LOCK, AND WHY THE OTHERS DO NOT ──────────────────────────────
 * LOCKING_AXES below is the whole answer, and every member is a difference the
 * reconcile's SUMMARY counts as work. The classes it leaves out are the ones
 * that file already prints under "NOT differences", each with a measurement
 * behind it rather than a label:
 *
 *   sofa decomposition   one book line is one ERP line PER COMPARTMENT, so line
 *                        count and per-line unit price are not commensurable.
 *                        The document TOTAL still has to match to the sen, and
 *                        it does — `document total` IS a locking axis.
 *   item translation     the same product written another way, via
 *                        data/autocount-erp-mapping-1561.csv.
 *   no-price             the BOOK states no unit price. Houzs prices a purchase
 *                        when the goods arrive; copying the book would ERASE a
 *                        real price (owner's 空白不覆盖 rule).
 *   book-blank variants  the ERP carries a value the book never stated. An
 *                        operator filled it in, which is allowed.
 *   ERP-blank on an order that is NOT proceeded — owner: 还没proceed还没确认的就
 *                        可以直接放空的.
 *   pend / recorded      the book says TBC/KIV; or the priced special is already
 *                        carried on the line under the owner's 2026-09-03 ruling
 *                        甲 - the factory sees the option and the document's
 *                        money did not move, so it is DECIDED work, not a
 *                        difference (see lib/variant-reconcile.mjs, which
 *                        owns that verdict). The jsonb key it lives under is
 *                        deliberately NOT spelled here: a tree scan in
 *                        backend/tests asserts that only display surfaces name
 *                        it, and a mention in this header would have to become
 *                        an exception in that scan. A check with an exception
 *                        in it is the shape this repo keeps paying for.
 *
 * Everything the reconcile could not ANSWER is a locking axis, not an absent
 * one. `sofa build not verifiable` is the live example: where a document's ERP
 * lines carry no AutoCount line key the compartments of one build cannot be
 * regrouped, so the reconcile says UNREADABLE rather than agreeing. "We could
 * not tell" is not "it matches", and the permissive answer must be unreachable
 * by a comparison that did not run.
 */

/** The axis names the guard may lock on. The reconcile's own vocabulary. */
export const LOCKING_AXES = Object.freeze([
  'line count',
  'item code',
  'quantity',
  'unit price',
  'document total',
  'currency',
  'a book line we do not have',
  'a line key on the wrong document',
  'lines could not be matched',
  'sofa build not verifiable',
  /* the variant axes, spelled exactly as lib/variant-reconcile.mjs labels them */
  'colour / fabric',
  'divan height',
  'gap',
  'leg height',
  'T.Heights',
  'seat size',
  'sofa compartments',
  'specials',
]);

const LOCKING = new Set(LOCKING_AXES);

/**
 * Collects findings per (type, AutoCount document).
 *
 * `record` is a NO-OP for an axis outside LOCKING_AXES rather than a throw: the
 * reconcile calls it from inside its comparison loops, and this module must
 * never be able to take down the check the owner is reading. An axis nobody
 * declared shows up as a missing lock, which the CI test below catches, not as
 * a failed run at go-live.
 */
export function makeVerdictRecorder() {
  /** type -> Map(acDocNo -> { erpNo, axes: Map(axis -> string[]) }) */
  const byType = new Map();

  const bucket = (type) => {
    let m = byType.get(type);
    if (!m) { m = new Map(); byType.set(type, m); }
    return m;
  };
  const docOf = (type, acDocNo, erpNo) => {
    const m = bucket(type);
    let d = m.get(acDocNo);
    if (!d) { d = { erpNo: erpNo ?? null, axes: new Map() }; m.set(acDocNo, d); }
    if (d.erpNo == null && erpNo != null) d.erpNo = erpNo;
    return d;
  };

  return {
    /** This document was COMPARED. Required before it can ever be clean. */
    seen(type, acDocNo, erpNo) { docOf(type, acDocNo, erpNo); },

    /** This document differs on `axis`. `detail` is one line for a human. */
    record(type, acDocNo, erpNo, axis, detail) {
      if (!LOCKING.has(axis)) return;
      const d = docOf(type, acDocNo, erpNo);
      let lines = d.axes.get(axis);
      if (!lines) { lines = []; d.axes.set(axis, lines); }
      if (detail && lines.length < 5) lines.push(String(detail));
    },

    /** Everything recorded for one document type. */
    forType(type) { return bucket(type); },
  };
}

/**
 * The rows to publish, for ONE document type.
 *
 * A document with no ERP number produces NO ROW. The verdict table is keyed on
 * the ERP document number because that is what the guard has in its hand and
 * what the salesperson sees; a finding we cannot attribute to an ERP document
 * is not a verdict about one, and inventing a key would be the only way for a
 * wrong row to open a document.
 */
export function buildVerdictRows({ recorder, type, companyId, measuredAt, runId }) {
  const rows = [];
  for (const [acDocNo, d] of recorder.forType(type)) {
    if (!d.erpNo) continue;
    const axes = [...d.axes.keys()].sort();
    const detail = axes.length
      ? axes.map((a) => `${a}: ${(d.axes.get(a) || []).join(' | ')}`).join('\n')
      : null;
    rows.push({
      doc_no: String(d.erpNo),
      company_id: companyId,
      ac_doc_no: acDocNo,
      clean: axes.length === 0,
      axes,
      detail,
      measured_at: measuredAt,
      run_id: runId,
    });
  }
  rows.sort((a, b) => (a.doc_no < b.doc_no ? -1 : a.doc_no > b.doc_no ? 1 : 0));
  return rows;
}

/** Counts for the run row and for the operator reading the log. */
export function summariseVerdict(rows) {
  const perAxis = new Map();
  let clean = 0;
  for (const r of rows) {
    if (r.clean) { clean++; continue; }
    for (const a of r.axes) perAxis.set(a, (perAxis.get(a) ?? 0) + 1);
  }
  return {
    docCount: rows.length,
    cleanCount: clean,
    differCount: rows.length - clean,
    /** documents touched per axis, descending — NOT findings */
    perAxis: [...perAxis.entries()].sort((a, b) => b[1] - a[1]),
  };
}
