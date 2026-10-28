#!/usr/bin/env node
/* publish-so-reconcile-verdict — put the reconcile's per-document answer where
 * the migrated-sales-order lock can read it.
 *
 * Owner, 2026-09-08: 「他们是要开 SO 和 edit SO 来 proceed 单;purchasing 要开 PO;
 * logistic 要 convert SO to DO」. Those all happen on the MIGRATED orders, which
 * the origin-grained lock forbids. This is the pipe that lets the lock ask a
 * better question — does THIS order match the account book? — instead of
 * shutting 2,882 documents because of where they came from.
 *
 * INPUT is the JSON that check-ac-erp-reconcile.mjs writes when VERDICT_OUT is
 * set. It is NOT re-derived here and it never will be: a second implementation
 * of "different" is how two statements of one rule come to disagree while both
 * report on "the same" documents, and that file's own header records the bill
 * for it twice.
 *
 * RE-RUN: idempotent and self-cleaning. Each run REPLACES the whole verdict set
 * for the company inside one transaction — the previous rows are deleted and
 * the new ones inserted together, so a document that was repaired since the last
 * run stops being locked and one that has broken since starts being locked. A
 * second run of the SAME input file produces byte-identical rows apart from
 * run_id and measured_at. There is no partial state to clean up: the transaction
 * either swaps the set or leaves the old one standing.
 *
 * WHAT A FAILED RUN LEAVES BEHIND: the PREVIOUS verdict, untouched. That is the
 * safe direction — an old verdict expires after two days and every document
 * reverts to LOCKED (backend/src/scm/lib/so-reconcile-verdict.ts) rather than
 * opening on evidence nobody refreshed.
 *
 * MODE=plan (the default) reads the file, prints exactly what it WOULD write,
 * and touches nothing.
 */
import fs from "node:fs";
import postgres from "postgres";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "publish-so-verdict";
const CONFIRM = String(process.env.CONFIRM ?? "").trim();
const IN = String(process.env.VERDICT_IN || process.argv[2] || "").trim();

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

if (!IN) {
  console.error("REFUSED: pass the verdict JSON path as VERDICT_IN or argv[1].");
  process.exit(2);
}
if (!fs.existsSync(IN)) {
  console.error(`REFUSED: ${IN} does not exist. Run check-ac-erp-reconcile.mjs with VERDICT_OUT set first.`);
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(IN, "utf8"));

/* ── REFUSALS, before anything is opened ────────────────────────────────────
   Every one of these publishes a WRONG verdict if it is waved through, and a
   wrong verdict OPENS documents. The check-soak-gate rule applies with the sign
   flipped: never make the evidence say what you want. */
const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

if (doc.version !== 1) refuse(`unknown verdict file version ${JSON.stringify(doc.version)}`);
if (doc.type !== "SO") refuse(`this publisher only handles SALES ORDERS; the file says ${JSON.stringify(doc.type)}`);
if (!Number.isInteger(doc.company_id)) refuse("the file names no company_id");
if (!Array.isArray(doc.rows) || doc.rows.length === 0) {
  /* A verdict of NO ROWS would delete the standing set and leave every document
     reading `no-verdict-published`, i.e. locked. That is the safe direction, so
     it is not dangerous — but it is almost certainly a broken run rather than a
     real answer, and publishing it would destroy a good verdict. Say so. */
  refuse("the file carries zero rows. That is a broken reconcile, not a verdict — nothing is published.");
}

const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000; // the guard's own limit
const measuredAt = Date.parse(doc.measured_at);
if (!Number.isFinite(measuredAt)) refuse("the file carries no readable measured_at");
if (Date.now() - measuredAt > MAX_AGE_MS) {
  refuse(
    `this verdict was measured ${((Date.now() - measuredAt) / 3600000).toFixed(1)}h ago and the guard expires one `
    + "after 48h. Publishing it would put rows in that are stale on arrival — re-run the reconcile.",
  );
}

const rows = doc.rows;
const clean = rows.filter((r) => r.clean === true).length;
const differ = rows.length - clean;

plain(`verdict file : ${IN}`);
plain(`measured_at  : ${doc.measured_at}  (snapshot ${doc.snapshot_exported_at ?? "unknown"})`);
plain(`company      : ${doc.company_id}`);
plain(`documents    : ${rows.length}  ->  ${clean} clean (WOULD OPEN), ${differ} differ (STAY LOCKED)`);
for (const r of rows.filter((x) => !x.clean)) {
  plain(`   LOCKED ${r.doc_no} (${r.ac_doc_no ?? "?"}) — ${(r.axes || []).join(", ") || "no axis recorded"}`);
}

if (!APPLY) {
  log(`PLAN only — nothing written. Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to publish.`);
  process.exit(0);
}
if (CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM=${CONFIRM_PHRASE}.`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) refuse("DATABASE_URL not set");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });

/* ONE TRANSACTION. The set is REPLACED, not merged: a document that has been
   repaired must stop being locked, and a merge would leave its old dirty row
   standing forever. A half-swapped set would open documents on evidence from
   two different runs, which is why this is not two statements. */
await sql.begin(async (tx) => {
  await tx`
    INSERT INTO scm.so_reconcile_verdict_run
      (id, company_id, measured_at, snapshot_exported_at, doc_count, clean_count, differ_count, source)
    VALUES (${doc.run_id}, ${doc.company_id}, ${doc.measured_at},
            ${doc.snapshot_exported_at ?? null}, ${rows.length}, ${clean}, ${differ}, ${doc.source ?? null})`;

  await tx`DELETE FROM scm.so_reconcile_verdict WHERE company_id = ${doc.company_id}`;

  /* Chunked because postgres.js builds one statement per call and 2,882 rows of
     eight columns is past what a single parameterised statement should carry. */
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({
      doc_no: String(r.doc_no),
      company_id: doc.company_id,
      ac_doc_no: r.ac_doc_no ?? null,
      clean: r.clean === true,
      axes: Array.isArray(r.axes) ? r.axes : [],
      detail: r.detail ?? null,
      measured_at: doc.measured_at,
      run_id: doc.run_id,
    }));
    await tx`INSERT INTO scm.so_reconcile_verdict ${tx(slice)}`;
  }
});
await sql.end({ timeout: 5 });

/* ── VERIFICATION, on a FRESH CONNECTION ───────────────────────────────────
   A new client, because the transaction above cannot be its own witness. And
   it re-reads the VALUES, not a count: on 2026-08-13 a repair reproduced the
   jsonb double-encoding bug on 7 production rows while its row count reported
   7 of 7, and only the shape check saw it. The shape that matters here is
   `clean` being a real boolean and `axes` being an ARRAY — a row whose axes
   arrived as the string "{}" would render as a locked document with an
   unreadable reason, and a `clean` that arrived as the string "false" is
   TRUTHY in the guard's `=== true` test only by luck of the driver. */
const check = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
const sample = await check`
  SELECT doc_no, clean, axes, measured_at, run_id
    FROM scm.so_reconcile_verdict
   WHERE company_id = ${doc.company_id}
   ORDER BY clean, doc_no
   LIMIT 5`;
const [tally] = await check`
  SELECT COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE clean)::int AS clean_n,
         COUNT(*) FILTER (WHERE run_id = ${doc.run_id})::int AS this_run
    FROM scm.so_reconcile_verdict WHERE company_id = ${doc.company_id}`;
await check.end({ timeout: 5 });

const problems = [];
if (tally.n !== rows.length) problems.push(`published ${tally.n} rows, expected ${rows.length}`);
if (tally.clean_n !== clean) problems.push(`published ${tally.clean_n} clean rows, expected ${clean}`);
if (tally.this_run !== rows.length) problems.push(`${rows.length - tally.this_run} row(s) do not carry this run_id`);
for (const r of sample) {
  if (typeof r.clean !== "boolean") problems.push(`${r.doc_no}: clean came back as ${typeof r.clean}, not a boolean`);
  if (!Array.isArray(r.axes)) problems.push(`${r.doc_no}: axes came back as ${typeof r.axes}, not an array`);
  if (r.clean === false && r.axes.length === 0) {
    /* Not fatal — the guard locks a row like this correctly — but it means the
       salesperson gets no reason, which is the failure this repo keeps paying
       for. Say it out loud. */
    plain(`   WARNING ${r.doc_no} is locked with no axis recorded; its refusal will name no reason.`);
  }
}

if (problems.length) {
  console.error("REFUSED: the published verdict does not read back as written:");
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}

log(
  `PUBLISHED — ${tally.n} sales-order verdicts for company ${doc.company_id}: `
  + `${tally.clean_n} match the book, ${tally.n - tally.clean_n} still differ. `
  + "The lock opens the clean ones only once scm.migrated_so_lock is set to 'verdict:<company>'; "
  + "this run did NOT touch that switch.",
);
