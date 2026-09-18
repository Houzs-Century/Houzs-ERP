#!/usr/bin/env node
/* check-so-tally — 「所以SO 都tally了吗?」, answered once, in one place.
 *
 * READ-ONLY. It opens no database connection of its own. It RUNS
 * check-ac-erp-reconcile.mjs — which is itself read-only, SELECTs only, one
 * connection — and reads the machine-readable verdict that run writes. Nothing
 * here writes to production, and there is no MODE=apply: this lane is a report.
 *
 * ── WHY IT RUNS THE RECONCILE INSTEAD OF IMPORTING PIECES OF IT ─────────────
 * The two sanctioned ways to reuse the comparison were: import the parts that
 * live in scripts/lib/, or have the reconcile emit a machine-readable verdict
 * this reads. THIS FILE TAKES THE SECOND, and the first is not available in the
 * shape it sounds: the axes are decided inside check-ac-erp-reconcile.mjs's own
 * document loop, over BOTH sides at once — the ERP rows it queried and the book
 * snapshot it decoded. Importing lib/variant-reconcile.mjs would hand this file
 * the rule for comparing ONE line and leave it to load, scope, pair and group
 * both corpora itself, which is re-implementing the 1,800 lines that matter.
 * A second copy of those disagrees with the first within a day; this repo has
 * three incidents of exactly that, the most recent being two copies of the sofa
 * pairing rule answering oppositely about HC-PO-010040 twenty minutes apart
 * (docs/bugs/0708).
 *
 * So: the reconcile measures, this classifies, and the CROSS-CHECK below proves
 * the two agree on the run that produced both.
 *
 * ── THE CROSS-CHECK IS NOT THE MEASUREMENT ─────────────────────────────────
 * Every number printed is derived from the verdict FILE. The reconcile's own
 * printed lines are then parsed and compared against those numbers, and a
 * disagreement REFUSES. Parsing is used to check, never to decide — deciding a
 * column by pattern-matching a printed string is the failure
 * lib/ac-not-a-difference.mjs was written against.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────
 * 0 for every legitimate answer, TALLIED or not: the answer IS the output and a
 * red job reads as "the check broke". Non-zero only when the check cannot
 * answer — the reconcile refused (stale snapshot, unreachable DB, a matcher
 * that proved itself broken), the verdict file is missing, or the cross-check
 * found this report and the reconcile stating different numbers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderVerdict, tallyVerdict, isTallied } from "./lib/so-tally-verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOW = Math.max(1, Number(process.env.SHOW || 20));
const CO = String(process.env.COMPANY_ID || "1");
const ECHO_RECONCILE = /^(1|true|yes)$/i.test(String(process.env.RECONCILE_LOG || ""));

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const refuse = (why) => {
  console.error(`REFUSED: ${why}`);
  process.exit(2);
};

if (!process.env.DATABASE_URL) refuse("DATABASE_URL not set.");

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "so-tally-")), "so-verdict.json");

plain("Running check-ac-erp-reconcile.mjs — the comparison. This report measures nothing itself.");
const run = spawnSync(
  process.execPath,
  [path.join(here, "check-ac-erp-reconcile.mjs")],
  {
    cwd: path.join(here, ".."),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      VERDICT_OUT: out,
      COMPANY_ID: CO,
      SHOW: String(SHOW),
      /* The reconcile emits ::notice:: when it thinks it is in Actions, and one
         notice per line of a 1,300-line log would bury the verdict this job
         exists to print. Its FINDINGS are unchanged either way. */
      GITHUB_ACTIONS: "",
    },
  },
);

const reconcileLog = `${run.stdout || ""}${run.stderr || ""}`;
if (ECHO_RECONCILE) {
  plain("");
  plain("─── the full reconcile log, verbatim ───");
  plain(reconcileLog);
}

if (run.error) refuse(`could not run the reconcile: ${run.error.message}`);
if (run.status !== 0) {
  plain(reconcileLog.split(/\r?\n/).slice(-40).join("\n"));
  refuse(
    `the reconcile exited ${run.status}. It refuses rather than answering when it cannot compare — a stale or ` +
      "missing AutoCount snapshot, an unreachable database, or a matcher that proved itself broken. " +
      "There is no verdict to report; the last 40 lines of its output are above.",
  );
}
if (!fs.existsSync(out)) refuse(`the reconcile exited 0 but wrote no verdict file at ${out}.`);

let payload;
try {
  payload = JSON.parse(fs.readFileSync(out, "utf8"));
} catch (e) {
  refuse(`the verdict file is not readable JSON: ${e.message}`);
}
if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
  refuse("the verdict file carries zero rows. That is a broken reconcile, not a clean corpus.");
}

const v = tallyVerdict(payload);

/* ── THE CROSS-CHECK ────────────────────────────────────────────────────────
 * Two independent statements of the same run must agree:
 *   (a) the reconcile's OWN summariseVerdict, inside the file, and
 *   (b) this report's four buckets, derived from the rows.
 * plus the numbers the reconcile PRINTED, parsed back out of its log.
 *
 * The bridge is arithmetic, not a coincidence: a row is `clean` exactly when it
 * carries no locking axis, and a row with no locking axis is `identical` or
 * `book-gap` here — nothing else. So clean == identical + book-gap, and
 * differ == (work from rows) + unanswerable. If that ever stops holding, one of
 * the two has changed its mind about a document and neither may be reported. */
const problems = [];
const s = payload.summary || {};
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

/* (c) the numbers the reconcile PRINTED. A file and a log both produced by one
   process should never disagree — but they are written by different code, and
   the whole reason this lane exists is that the log has been read wrongly. */
const printed = {};
const mVerdict = reconcileLog.match(
  /SO VERDICT — (\d+) migrated sales orders compared against the book: (\d+) match it exactly and would OPEN; (\d+) still differ/,
);
if (mVerdict) printed.verdict = { docs: +mVerdict[1], clean: +mVerdict[2], differ: +mVerdict[3] };
const mSummary = reconcileLog.match(/^SO\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/m);
if (mSummary) {
  printed.summary = {
    book: +mSummary[1], scope: +mSummary[2], erpLinked: +mSummary[3],
    absent: +mSummary[4], phantom: +mSummary[5], both: +mSummary[6],
  };
}
if (!mVerdict) problems.push("the reconcile log does not carry its own SO VERDICT line — nothing to cross-check against");
else {
  if (printed.verdict.docs !== v.documents.compared) problems.push(`printed SO VERDICT says ${printed.verdict.docs} documents, this report ${v.documents.compared}`);
  if (printed.verdict.clean !== v.buckets.identical + v.buckets["book-gap"]) problems.push(`printed SO VERDICT says ${printed.verdict.clean} clean, this report ${v.buckets.identical + v.buckets["book-gap"]}`);
  if (printed.verdict.differ !== workFromRows + v.buckets.unanswerable) problems.push(`printed SO VERDICT says ${printed.verdict.differ} differ, this report ${workFromRows + v.buckets.unanswerable}`);
}
if (!mSummary) problems.push("the reconcile log does not carry its own SO SUMMARY row — nothing to cross-check against");
else {
  for (const [field, mineVal] of [
    ["book", v.documents.book], ["scope", v.documents.scope], ["erpLinked", v.documents.erpLinked],
    ["absent", v.documents.absent], ["phantom", v.documents.phantom], ["both", v.documents.compared],
  ]) {
    if (printed.summary[field] !== mineVal) problems.push(`printed SUMMARY ${field} = ${printed.summary[field]}, this report ${mineVal}`);
  }
}

if (problems.length) {
  console.error("REFUSED — this report and the reconcile that produced it state different numbers:");
  for (const p of problems) console.error(`   ${p}`);
  console.error(
    "A verdict that does not match its own measurement is worse than no verdict. Nothing is printed. " +
      "Fix scripts/lib/so-tally-verdict.mjs or scripts/lib/so-verdict-derive.mjs, not this check.",
  );
  process.exit(2);
}

for (const line of renderVerdict(v, { show: SHOW })) plain(line);

plain("");
plain("─── PROOF: this report and the reconcile agree, on THIS run ───");
plain(`   documents compared        report ${v.documents.compared}  ·  reconcile file ${s.docCount}  ·  reconcile log ${printed.verdict.docs}`);
plain(`   clean (identical+bookgap) report ${v.buckets.identical + v.buckets["book-gap"]}  ·  reconcile file ${s.cleanCount}  ·  reconcile log ${printed.verdict.clean}`);
plain(`   locked (work+cannot)      report ${workFromRows + v.buckets.unanswerable}  ·  reconcile file ${s.differCount}  ·  reconcile log ${printed.verdict.differ}`);
plain(`   absent / phantom          report ${v.documents.absent} / ${v.documents.phantom}  ·  reconcile log ${printed.summary.absent} / ${printed.summary.phantom}`);
for (const [axis, docs] of s.perAxis || []) {
  plain(`   axis ${axis.padEnd(32)} report ${String(v.axes.find((a) => a.axis === axis).docs).padStart(5)}  ·  reconcile ${String(docs).padStart(5)}`);
}
plain(
  "   Every axis lines up. The reconcile is the only thing that compared anything; this report classified its " +
    "findings and re-stated its counts, and the two were checked against each other before a single number was printed.",
);

/* The one-line answer, LAST and as a notice, so it is what an operator sees in
   the run's annotations without opening the log. */
log(
  isTallied(v)
    ? `SALES ORDERS TALLIED — ${v.documents.population} documents, 0 differ. ` +
      `${v.buckets.unanswerable} sofa build(s) cannot be compared and are the owner's to adjudicate.`
    : `SALES ORDERS NOT TALLIED — ${v.buckets.work} of ${v.documents.population} document(s) still differ from the ` +
      `account book. ${v.buckets.unanswerable} more cannot be compared at all.`,
);

/* Read-only by construction: no connection was opened here and the reconcile
   holds no transaction open. Exit 0 whichever the answer is. */
process.exit(0);
