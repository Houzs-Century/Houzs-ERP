#!/usr/bin/env node
/* check-po-gr-tally — 「然后把PO GR也tally掉」, answered once, in one place.
 *
 * The owner, 2026-09-08, immediately after the sales orders were answered: do
 * for PURCHASE ORDERS and GOODS RECEIPTS what was just done for sales orders.
 * Same four buckets, same one-line answer, same refusal to print when the two
 * instruments disagree.
 *
 * READ-ONLY. It opens no database connection of its own. It RUNS
 * check-ac-erp-reconcile.mjs — itself read-only, SELECTs only, one connection —
 * and reads the machine-readable verdicts that run writes. Nothing here writes
 * to production and there is no MODE=apply: this lane is a report.
 *
 * ── ONE RUN, EVERY TYPE ─────────────────────────────────────────────────────
 * The reconcile is spawned ONCE and asked for every requested type. That is not
 * only cheaper — it is what makes the answers commensurable. Two runs may read
 * the ERP a minute apart, and a report that puts purchase orders beside goods
 * receipts while quoting two different comparisons is the "three true sentences
 * about three different measurements" failure the sales-order lane was built to
 * end, wearing a different hat.
 *
 * ── WHY SO IS RUN TOO, BY DEFAULT ───────────────────────────────────────────
 * As a CONTROL. This lane extends the shared verdict module and the reconcile's
 * emission block; the way to show it moved no sales-order figure is to print
 * the sales-order figures from the same run and set them beside the sales-order
 * lane's own. If SO moves, this lane broke something, and the number is right
 * there rather than in somebody's memory.
 *
 * ── IT MEASURES NOTHING ─────────────────────────────────────────────────────
 * Every number comes out of the reconcile's own verdict files. This classifies
 * rows that run already decided; it never compares a book value to an ERP value
 * and must never learn how. lib/tally-crosscheck.mjs then proves this report
 * and that run state the same numbers, and a disagreement REFUSES rather than
 * printing.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────
 * 0 for every legitimate answer, TALLIED or not: the answer IS the output and a
 * red job reads as "the check broke". Non-zero only when the check cannot
 * answer — the reconcile refused, a verdict file is missing, or the cross-check
 * found this report and the reconcile stating different numbers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderVerdict, tallyVerdict, isTallied, docTypeSpec } from "./lib/so-tally-verdict.mjs";
import { crossCheck } from "./lib/tally-crosscheck.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOW = Math.max(1, Number(process.env.SHOW || 20));
const CO = String(process.env.COMPANY_ID || "1");
const ECHO_RECONCILE = /^(1|true|yes)$/i.test(String(process.env.RECONCILE_LOG || ""));
const TYPES = String(process.env.TYPES || "PO,GR,SO")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const refuse = (why) => {
  console.error(`REFUSED: ${why}`);
  process.exit(2);
};

if (!process.env.DATABASE_URL) refuse("DATABASE_URL not set.");
/* A typo in the input must not silently produce a report about nothing. */
for (const t of TYPES) docTypeSpec(t);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-gr-tally-"));

plain(`Running check-ac-erp-reconcile.mjs ONCE for ${TYPES.join(", ")} — the comparison. This report measures nothing itself.`);
const run = spawnSync(
  process.execPath,
  [path.join(here, "check-ac-erp-reconcile.mjs")],
  {
    cwd: path.join(here, ".."),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      VERDICT_DIR: dir,
      VERDICT_TYPES: TYPES.join(","),
      COMPANY_ID: CO,
      SHOW: String(SHOW),
      /* The reconcile emits ::notice:: when it thinks it is in Actions, and one
         notice per line of a 1,300-line log would bury the verdicts this job
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

/* ── EVERY TYPE IS CROSS-CHECKED BEFORE A SINGLE ONE IS PRINTED ─────────────
   Deliberately two passes. A report that prints purchase orders, then discovers
   the goods receipts do not reconcile and dies, has already put a number in
   front of the owner that it cannot stand behind. Either all of it is proven,
   or none of it is shown. */
const answers = [];
const problems = [];
for (const type of TYPES) {
  const file = path.join(dir, `${type}-verdict.json`);
  if (!fs.existsSync(file)) {
    problems.push(`${type}: the reconcile exited 0 but wrote no verdict file. It compared no documents of this type.`);
    continue;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`${type}: the verdict file is not readable JSON: ${e.message}`);
    continue;
  }
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    problems.push(`${type}: the verdict file carries zero rows. That is a broken reconcile, not a clean corpus.`);
    continue;
  }
  const v = tallyVerdict(payload);
  const cc = crossCheck({ type, v, payload, log: reconcileLog });
  for (const p of cc.problems) problems.push(`${type}: ${p}`);
  answers.push({ type, v, payload, cc });
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

for (const { type, v, payload, cc } of answers) {
  for (const line of renderVerdict(v, { show: SHOW, type })) plain(line);

  plain("");
  plain(`─── PROOF: this report and the reconcile agree, on THIS run (${type}) ───`);
  plain(`   documents compared        report ${v.documents.compared}  ·  reconcile file ${payload.summary.docCount}  ·  reconcile log ${cc.printed.verdict.docs}`);
  plain(`   clean (identical+bookgap) report ${v.buckets.identical + v.buckets["book-gap"]}  ·  reconcile file ${payload.summary.cleanCount}  ·  reconcile log ${cc.printed.verdict.clean}`);
  plain(`   locked (work+cannot)      report ${cc.workFromRows + v.buckets.unanswerable}  ·  reconcile log ${cc.printed.verdict.differ}`);
  plain(`   absent / phantom          report ${v.documents.absent} / ${v.documents.phantom}  ·  reconcile log ${cc.printed.summary.absent} / ${cc.printed.summary.phantom}`);
  plain(
    "   Every axis lines up. The reconcile is the only thing that compared anything; this report classified its " +
      "findings and re-stated its counts, and the two were checked against each other before a number was printed.",
  );
}

/* ── THE ONE-LINE ANSWERS, LAST ─────────────────────────────────────────────
   As notices, so an operator sees them in the run's annotations without opening
   the log. One per type, in the order asked for. */
plain("");
plain("═════════════ 一句话 — THE ANSWER, PER DOCUMENT TYPE ═════════════");
for (const { type, v } of answers) {
  const spec = docTypeSpec(type);
  log(
    isTallied(v)
      ? `${spec.headline} TALLIED — ${v.documents.population} documents, 0 differ.` +
        (v.buckets.unanswerable ? ` ${v.buckets.unanswerable} cannot be compared and are the owner's to adjudicate.` : "")
      : `${spec.headline} NOT TALLIED — ${v.buckets.work} of ${v.documents.population} document(s) still differ from ` +
        `the account book.${v.buckets.unanswerable ? ` ${v.buckets.unanswerable} more cannot be compared at all.` : ""}`,
  );
}

/* Read-only by construction: no connection was opened here and the reconcile
   holds no transaction open. Exit 0 whichever the answer is. */
process.exit(0);
