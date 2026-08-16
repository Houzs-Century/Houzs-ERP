#!/usr/bin/env node
/* Read-only: how much live sales-order demand carries NO delivery date, WHO
   wrote it, and whether requiring the field would refuse live work — BOTH
   companies.

   WHY. The MRP page hides undated demand by default (Commander 2026-05-29 — an
   undated line is not ready to order). Run 31962771658 measured company 1
   (HOUZS) on production 2026-08-16 and the share is not the 43% the owner
   measured by hand on 2990, it is **81.9% of live SO lines** (11,392 of 13,916)
   and 81.0% of live headers (2,207 of 2,724). The owner: "明明这个东西没有
   ready,可是我的 MRP 却 show 不出来."

   WHAT THAT RUN ESTABLISHED, which this one must not lose:
     - 2,207 undated live headers, of which 2,199 carry NEITHER date.
     - **0** headers whose lines carry a date the header lacks. So this is
       genuinely MISSING data, not misplaced data — that rules out a whole
       family of wrong fixes, and the assertion stays (section C(c)).
     - 2,203 are CONFIRMED and were created inside a FIVE-DAY window,
       2026-08-09 .. 2026-08-13. That is a bulk write, not salespeople
       forgetting a field one order at a time.
     - 8 headers carry a processing date with NO delivery date — a pair
       `so-save-problems.ts` REFUSES on save. Section C(a2) names them.

   AND WHAT IT DID NOT MEASURE. It died on section C(b), before company 2 (2990)
   ran AT ALL:
       FAIL subquery uses ungrouped column "h.created_at" from outer query
   **So the 82% is HOUZS ONLY — 2990 is still unmeasured by this probe.** Two
   things changed as a result:
     1. the SQL moved to `scripts/lib/undated-demand-queries.mjs` and is now
        EXECUTED by `tests-pg/probeUndatedDemandSql.pg.test.ts` against CI's real
        postgres:16, because `node --check` cannot see inside a SQL string;
     2. each company runs in its own try/catch, so one company's failure can
        never again cost the other's answer. A partial run says INCOMPLETE and
        exits non-zero — "not measured" must never look like "zero".

   THE HYPOTHESIS, and what refutes it. This is no longer "the field is optional
   at create"; the code names a specific mechanism:

     H: the undated headers ARE the 2026-08 AutoCount cutover import.
        `backend/scripts/import-ac-outstanding-so.mjs` inserts with a 38-column
        list (its `HCOLS`) carrying NEITHER `customer_delivery_date` NOR
        `processing_date`, so both land NULL by column default; it stamps
        `status = 'CONFIRMED'` and writes `doc_no = 'HC-<AutoCount DocNo>'` with
        the raw number in `linked_ac_docno` (mig 0271). CONFIRMED + a five-day
        window + never-written dates is exactly the observed shape. (Its
        `procDate` goes to `proceeded_at`, NOT `processing_date` — so the
        importer cannot explain the 8 refused-pair rows, and those stay open.)

     REFUTED IF: the undated rows do NOT carry `linked_ac_docno` / an `HC-`
     doc_no; or undated ERP-BORN orders are still appearing this week (section
     E), which would mean a live surface is producing them too.

   THE DECISION THIS FEEDS is the owner's, not mine: whether to make
   `customer_delivery_date` required. Section E splits the 7- and 30-day counts
   by IMPORTED vs ERP-BORN, because "grandfather one import and require it going
   forward" and "2,207 people are working without dates" are very different
   decisions and only the split tells them apart.

   Writes NOTHING: every statement is a SELECT, no transaction, no DDL.
   RE-RUN: idempotent — reading twice changes nothing and gives the same answer
   for the same database. */
import postgres from "postgres";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";
import * as Q from "./lib/undated-demand-queries.mjs";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

const COMPANIES = [
  [1, "HOUZS"],
  [2, "2990"],
];

/* The provenance columns the SO header MIGHT carry. Reported as present/ABSENT
   rather than assumed — "name the mechanism, do not assume which one". */
const PROVENANCE_CANDIDATES = [
  "linked_ac_docno",   // mig 0271 — the AutoCount SO this row was imported from
  "created_by",        // who typed it (NULL on a script insert)
  "proceeded_at",      // the importer writes AutoCount's UDF_PDate HERE
  "processing_date",
  "target_date",
];

const has = async (schema, table, column) => (await Q.hasColumn(sql, schema, table, column))[0].n > 0;

async function perCompany(companyId, label) {
  note(`\n${"=".repeat(72)}`);
  note(`COMPANY ${companyId} — ${label}`);
  note("=".repeat(72));

  /* ── 0. What provenance the header actually carries ─────────────────────── */
  const present = {};
  for (const c of PROVENANCE_CANDIDATES) present[c] = await has("scm", "mfg_sales_orders", c);
  note(`\n=== 0. Provenance columns on scm.mfg_sales_orders ===`);
  for (const c of PROVENANCE_CANDIDATES) note(`  ${present[c] ? "present" : "ABSENT "}  ${c}`);
  const hasAc = present.linked_ac_docno;

  /* ── A. What MRP hides ──────────────────────────────────────────────────── */
  const [lines] = await Q.liveLines(sql, companyId);
  note(`\n=== A. Live SO LINES (MRP's demand set) ===`);
  note(`  live lines:                 ${lines.live}`);
  note(`  undated (no line, no hdr):  ${lines.undated}   ${pct(lines.undated, lines.live)}  <- what the MRP page hides by default`);

  /* ── B. Live headers ────────────────────────────────────────────────────── */
  const [hdr] = await Q.liveHeaders(sql, companyId);
  note(`\n=== B. Live SO HEADERS ===`);
  note(`  live orders:                ${hdr.live}`);
  note(`  no customer_delivery_date:  ${hdr.undated}   ${pct(hdr.undated, hdr.live)}`);

  /* ── C(a). The pair the save path refuses ───────────────────────────────── */
  const [xor] = await Q.undatedXor(sql, companyId);
  note(`\n=== C(a). Of the undated headers, do any carry a PROCESSING date? ===`);
  note(`  neither date (legal save):  ${xor.no_proc}`);
  note(`  processing but NO delivery: ${xor.with_proc}   ${Number(xor.with_proc) ? "<- the save path REFUSES this pair" : "(none)"}`);

  /* ── C(a2). NAME them. Rows the save path says cannot exist are worth more
        than their count: they are the thread that names the writer. The
        importer is NOT a candidate (it writes neither date), so
        `linked_ac_docno` here separates "imported row edited afterwards" from
        "ERP-born" — different faults, different fixes. */
  if (Number(xor.with_proc) > 0) {
    const offenders = await Q.refusedPairRows(sql, companyId, hasAc);
    note(`\n=== C(a2). The refused-pair rows, NAMED (${offenders.length}) ===`);
    for (const r of offenders) {
      note(`  ${String(r.doc_no).padEnd(20)} ${String(r.status).padEnd(12)} proc=${r.processing_date}  created=${r.created}  updated=${r.updated}  ac=${r.linked_ac_docno ?? "(none — ERP-born)"}`);
    }
  }

  /* ── C(c). Missing, or misplaced? ───────────────────────────────────────── */
  const [split] = await Q.lineVsHeader(sql, companyId);
  note(`\n=== C(c). Undated HEADER — is the date on the lines instead? ===`);
  note(`  header blank, some line dated: ${split.some_line_dated}   ${Number(split.some_line_dated) ? "<- NOT hidden by MRP (it coalesces line -> header)" : ""}`);
  note(`  header blank, no line dated:   ${split.no_line_dated}   <- genuinely MISSING data, not misplaced`);

  /* ── C. by STATUS ───────────────────────────────────────────────────────── */
  const statuses = await Q.byStatus(sql, companyId);
  note(`\n=== C. Undated live headers, by STATUS ===`);
  if (!statuses.length) note(`  none`);
  for (const r of statuses) {
    note(`  ${String(r.status).padEnd(14)} ${String(r.n).padStart(5)}   ${r.first_seen} .. ${r.last_seen}`);
  }

  /* ── D. THE IMPORT TEST ─────────────────────────────────────────────────── */
  if (!hasAc) {
    note(`\n=== D. IMPORTED vs ERP-BORN: NOT RUN — scm.mfg_sales_orders has no linked_ac_docno column ===`);
  } else {
    const [imp] = await Q.importedVsErpBorn(sql, companyId);
    const [all] = await Q.allLiveByOrigin(sql, companyId);
    note(`\n=== D. Undated live headers — IMPORTED or ERP-BORN? ===`);
    note(`  undated total:                     ${imp.undated}`);
    note(`    carrying linked_ac_docno:        ${imp.by_ac_col}   ${pct(imp.by_ac_col, imp.undated)}`);
    note(`    doc_no LIKE 'HC-%':              ${imp.by_docno}   ${pct(imp.by_docno, imp.undated)}`);
    note(`    ERP-born (neither marker):       ${imp.erp_born}   ${pct(imp.erp_born, imp.undated)}`);
    if (Number(imp.by_ac_col) !== Number(imp.by_docno)) {
      note(`  NOTE: the two import fingerprints DISAGREE (${imp.by_ac_col} vs ${imp.by_docno}) — that gap is itself a finding, not a rounding.`);
    }
    note(`  for scale, ALL live headers:  imported ${all.imported} / ERP-born ${all.erp_born}`);
    const [ebRate] = await Q.erpBornRate(sql, companyId);
    note(`  ERP-BORN live orders: ${ebRate.erp_live}, of which undated ${ebRate.erp_undated}  ${pct(ebRate.erp_undated, ebRate.erp_live)}  <- the rate a required field would bite`);
  }

  /* ── C(b)-1. by MONTH — the query that crashed the last run ──────────────── */
  const months = await Q.byMonth(sql, companyId);
  note(`\n=== C(b)-1. Live headers by CREATED month (newest first) ===`);
  note(`  month     undated / live   share`);
  for (const r of months) {
    note(`  ${r.mon}   ${String(r.undated).padStart(5)} / ${String(r.live_that_month).padStart(5)}    ${pct(r.undated, r.live_that_month)}`);
  }
  note(`  (one spike = a bulk write; a flat share = users never fill it)`);

  /* ── C(b)-2. by DAY — a five-day window is invisible in monthly buckets ──── */
  const days = await Q.byDay(sql, companyId);
  note(`\n=== C(b)-2. Top 20 DAYS by undated count — the spike, if there is one ===`);
  note(`  day          undated / live   share`);
  for (const r of days) {
    note(`  ${r.d}   ${String(r.undated).padStart(5)} / ${String(r.live_that_day).padStart(5)}    ${pct(r.undated, r.live_that_day)}`);
  }

  /* ── C(b)-3. by CREATOR — never reached on the failed run ────────────────── */
  if (!present.created_by) {
    note(`\n=== C(b)-3. by CREATOR: NOT RUN — scm.mfg_sales_orders has no created_by column ===`);
  } else {
    const named = await has("public", "users", "email");
    const byWho = await Q.byCreator(sql, companyId, named);
    note(`\n=== C(b)-3. Undated live headers by CREATOR ${named ? "" : "(raw ids — public.users.email not found)"} ===`);
    for (const r of byWho) {
      note(`  ${String(r.who).padEnd(38)} ${String(r.undated).padStart(5)}   ${r.first_seen} .. ${r.last_seen}`);
    }
    note(`  ((null) or one account dominating = written by a script, not typed)`);
  }

  /* ── E. THE DECISION INPUT ──────────────────────────────────────────────── */
  const [r0] = await Q.stillProduced(sql, companyId, hasAc);
  note(`\n=== E. Still being produced? (the required-field decision input) ===`);
  note(`  undated live orders created in the last  7 days: ${r0.d7}   of which ERP-BORN: ${r0.d7_erp ?? "(unknown — no import marker)"}`);
  note(`  undated live orders created in the last 30 days: ${r0.d30}   of which ERP-BORN: ${r0.d30_erp ?? "(unknown — no import marker)"}`);
  note(`  Reading it: the ERP-BORN number is the one a required field would refuse.`);
  note(`  ERP-born 0    => grandfather the import and require it going forward.`);
  note(`  ERP-born high => a live surface is producing them too; close that first.`);

  const eg = await Q.newestUndated(sql, companyId);
  note(`\n=== newest 10 undated live orders ===`);
  for (const r of eg) {
    note(`  ${String(r.doc_no).padEnd(20)} ${String(r.status ?? "-").padEnd(12)} proc=${r.processing_date ?? "-"}  created=${r.created}`);
  }
}

async function main() {
  note(`terminal (done) statuses excluded: ${SO_TERMINAL_STATES.join(", ")}`);

  /* Per-company isolation. Run 31962771658 lost company 2 entirely because a
     SQL error in company 1 aborted the process — and the answer for a company
     never read is "NOT MEASURED", which must never look like zero. */
  const failures = [];
  for (const [id, label] of COMPANIES) {
    try {
      await perCompany(id, label);
    } catch (e) {
      failures.push([id, label, e.message]);
      note(`\n!! COMPANY ${id} — ${label}: FAILED — ${e.message}`);
      note(`!! Continuing to the next company so one bad statement cannot cost the other's answer.`);
    }
  }

  note(`\n${"=".repeat(72)}`);
  if (failures.length) {
    note(`INCOMPLETE — ${failures.length} of ${COMPANIES.length} companies failed:`);
    for (const [id, label, msg] of failures) note(`  company ${id} (${label}): ${msg}`);
    note(`Any company that DID print above is complete and usable. The failed ones are NOT MEASURED, which is not the same as zero.`);
  } else {
    note(`Both companies measured. Read-only: every statement was a SELECT. Nothing was written.`);
  }
  await sql.end({ timeout: 5 });
  /* Non-zero ONLY when the probe itself is broken. A legitimate answer, however
     unwelcome, exits 0; a partial run is a broken probe. */
  if (failures.length) process.exit(1);
}
main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
