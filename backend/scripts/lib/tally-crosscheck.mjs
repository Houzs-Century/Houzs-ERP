/* tally-crosscheck — the two instruments must state the same run, or nothing prints.
 *
 * ── WHY IT IS A MODULE ──────────────────────────────────────────────────────
 * check-so-tally.mjs carries this property inline, for one document type. When
 * the owner asked for purchase orders and goods receipts too
 * (「然后把PO GR也tally掉」, 2026-09-08) the choice was to copy that block twice
 * or to state it once. Copying it is the exact shape this repo keeps paying
 * for: two statements of one rule that agree on the day they are written and
 * disagree a fortnight later, most recently two copies of the sofa pairing rule
 * answering oppositely about HC-PO-010040 twenty minutes apart (docs/bugs/0708).
 *
 * So: PURE. A payload and a log string in, a list of PROBLEMS out. It opens
 * nothing, prints nothing and decides nothing about whether a document tallies
 * — `isTallied` in lib/so-tally-verdict.mjs remains the only place that word is
 * decided.
 *
 * ── WHAT IT ACTUALLY PROVES ─────────────────────────────────────────────────
 * Three statements of one run, from three different pieces of code:
 *
 *   (a) the reconcile's OWN summariseVerdict, inside the verdict FILE;
 *   (b) this report's four buckets, derived from that file's rows;
 *   (c) the numbers the reconcile PRINTED to its log.
 *
 * (a) and (b) are bridged by ARITHMETIC, not by coincidence: a row is `clean`
 * exactly when it carries no locking axis, and a row with no locking axis is
 * `identical` or `book-gap` and nothing else. So clean == identical + book-gap,
 * and differ == work-from-rows + unanswerable. The moment that stops holding,
 * one of the two has changed its mind about a document and NEITHER may be
 * reported.
 *
 * (c) exists because a file and a log produced by one process should never
 * disagree — and they are written by different code, and the entire reason this
 * lane exists is that the log has been read wrongly before.
 *
 * ── PARSING IS USED TO CHECK, NEVER TO DECIDE ───────────────────────────────
 * Every number this file compares against was DERIVED from the verdict file by
 * the caller. The regexes below only re-read what the reconcile printed so the
 * two can be set against each other. Deciding a column by pattern-matching a
 * printed string is the failure lib/ac-not-a-difference.mjs was written against,
 * and it must not creep back in here.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** The uniform per-type line check-ac-erp-reconcile.mjs prints for VERDICT_DIR. */
export const verdictLineRe = (type) =>
  new RegExp(
    `${type} TALLY VERDICT — (\\d+) documents compared against the book: ` +
      "(\\d+) match it exactly; (\\d+) still differ",
  );

/** That run's own SUMMARY table row for the type: the first six columns. */
export const summaryRowRe = (type) =>
  new RegExp(`^${type}\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s`, "m");

/**
 * @param {object} a
 * @param {string} a.type       document type, e.g. "PO"
 * @param {object} a.v          the tallyVerdict() result for that type
 * @param {object} a.payload    the verdict FILE the reconcile wrote
 * @param {string} a.log        the reconcile's stdout+stderr, verbatim
 * @returns {{problems: string[], printed: object}}
 */
export function crossCheck({ type, v, payload, log }) {
  const problems = [];
  const s = payload?.summary || {};

  /* Documents whose difference is the DOCUMENT ITSELF have no comparison row,
     so they are added to `work` by tallyVerdict from the presence lists. They
     must be taken back out before this half is set against a count the
     reconcile derived from ROWS ONLY. */
  const workFromRows = v.buckets.work - v.documents.absent - v.documents.phantom;

  if (s.docCount !== v.documents.compared) {
    problems.push(`the reconcile counted ${s.docCount} compared documents, this report counted ${v.documents.compared}`);
  }
  if (s.cleanCount !== v.buckets.identical + v.buckets["book-gap"]) {
    problems.push(
      `the reconcile counted ${s.cleanCount} clean; identical (${v.buckets.identical}) + book-gap ` +
        `(${v.buckets["book-gap"]}) = ${v.buckets.identical + v.buckets["book-gap"]}`,
    );
  }
  if (s.differCount !== workFromRows + v.buckets.unanswerable) {
    problems.push(
      `the reconcile counted ${s.differCount} differing; work-from-rows (${workFromRows}) + cannot-compare ` +
        `(${v.buckets.unanswerable}) = ${workFromRows + v.buckets.unanswerable}`,
    );
  }
  for (const [axis, docs] of s.perAxis || []) {
    const mine = v.axes.find((a) => a.axis === axis);
    if (!mine) problems.push(`the reconcile reports axis "${axis}" on ${docs} document(s); this report has no such axis`);
    else if (mine.docs !== docs) problems.push(`axis "${axis}": reconcile ${docs} document(s), this report ${mine.docs}`);
  }

  const printed = {};
  const mVerdict = String(log).match(verdictLineRe(type));
  if (!mVerdict) {
    problems.push(`the reconcile log carries no "${type} TALLY VERDICT" line — nothing to cross-check against`);
  } else {
    printed.verdict = { docs: +mVerdict[1], clean: +mVerdict[2], differ: +mVerdict[3] };
    if (printed.verdict.docs !== v.documents.compared) {
      problems.push(`printed ${type} TALLY VERDICT says ${printed.verdict.docs} documents, this report ${v.documents.compared}`);
    }
    if (printed.verdict.clean !== v.buckets.identical + v.buckets["book-gap"]) {
      problems.push(`printed ${type} TALLY VERDICT says ${printed.verdict.clean} clean, this report ${v.buckets.identical + v.buckets["book-gap"]}`);
    }
    if (printed.verdict.differ !== workFromRows + v.buckets.unanswerable) {
      problems.push(`printed ${type} TALLY VERDICT says ${printed.verdict.differ} differ, this report ${workFromRows + v.buckets.unanswerable}`);
    }
  }

  const mSummary = String(log).match(summaryRowRe(type));
  if (!mSummary) {
    problems.push(`the reconcile log carries no ${type} SUMMARY row — nothing to cross-check against`);
  } else {
    printed.summary = {
      book: +mSummary[1], scope: +mSummary[2], erpLinked: +mSummary[3],
      absent: +mSummary[4], phantom: +mSummary[5], both: +mSummary[6],
    };
    for (const [field, mineVal] of [
      ["book", v.documents.book], ["scope", v.documents.scope], ["erpLinked", v.documents.erpLinked],
      ["absent", v.documents.absent], ["phantom", v.documents.phantom], ["both", v.documents.compared],
    ]) {
      if (printed.summary[field] !== mineVal) {
        problems.push(`printed ${type} SUMMARY ${field} = ${printed.summary[field]}, this report ${mineVal}`);
      }
    }
  }

  return { problems, printed, workFromRows };
}
