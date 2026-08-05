#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-ocr-learning.mjs — is the scanner actually learning, or only designed to?
//
// WHY. Owner, 2026-08-05: "他们更改了东西之后，你有没有去学习？要不然，他们如果没
// 有自我进化的话，这个 OCR 永远都会不准" — then, directly: "自我学习的确定是没有
// 问题是吧？"
//
// The MECHANISM exists. scm.so_scan_samples (mig 0023) stores the raw extraction
// in `extracted` (status EXTRACTED) and the operator's corrected JSON in
// `corrected` (status CONFIRMED), and the 5 most recent CONFIRMED rows are
// injected back into the extraction prompt as few-shot examples, filtered PER
// SALESPERSON because handwriting differs per rep.
//
// But a mechanism that exists is not a mechanism that runs. If `corrected` is
// never written — the operator edits the New SO form without the confirm step
// firing, say — every row stays EXTRACTED, the few-shot pool stays empty, and
// the extractor learns NOTHING while looking exactly as if it does. That is the
// owner's fear stated precisely, and it is answerable with one query.
//
// READ-ONLY. SELECT only. Exits 0 always.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const pad = (v, n) => String(v ?? "").padEnd(n);
const rpad = (v, n) => String(v ?? "").padStart(n);
const num = (v) => Number(v ?? 0);
const day = (v) => (v ? String(v).slice(0, 10) : "never");

try {
  const [tot] = await pg`
    SELECT COUNT(*) AS all_rows,
           COUNT(*) FILTER (WHERE corrected IS NOT NULL) AS with_corrected,
           COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) = 'CONFIRMED') AS confirmed,
           MAX(created_at) FILTER (WHERE corrected IS NOT NULL) AS last_corrected,
           MAX(created_at) AS last_any
      FROM scm.so_scan_samples`;

  console.log(`\nSO SCAN SAMPLES\n`);
  console.log(`  rows total                 ${rpad(num(tot.all_rows), 8)}`);
  console.log(`  with a CORRECTED payload   ${rpad(num(tot.with_corrected), 8)}   <- the few-shot pool`);
  console.log(`  status = CONFIRMED         ${rpad(num(tot.confirmed), 8)}`);
  console.log(`  last scan                  ${day(tot.last_any)}`);
  console.log(`  last correction captured   ${day(tot.last_corrected)}\n`);

  /* Per rep, because the few-shot examples are filtered per salesperson — a
     global pool that looks healthy can still leave an individual rep with none. */
  const perRep = await pg`
    SELECT COALESCE(NULLIF(TRIM(salesperson), ''), '(unattributed)') AS rep,
           COUNT(*) AS scans,
           COUNT(*) FILTER (WHERE corrected IS NOT NULL) AS corrections,
           MAX(created_at) FILTER (WHERE corrected IS NOT NULL) AS last_corr
      FROM scm.so_scan_samples
     GROUP BY 1 ORDER BY 2 DESC`;
  if (perRep.length > 0) {
    console.log(`  PER SALESPERSON (few-shot examples are filtered per rep)\n`);
    console.log(`      ${pad("rep", 24)} ${rpad("scans", 7)} ${rpad("corrections", 13)}  last correction`);
    for (const r of perRep) {
      console.log(`      ${pad(r.rep, 24)} ${rpad(num(r.scans), 7)} ${rpad(num(r.corrections), 13)}  ${day(r.last_corr)}`);
    }
    console.log("");
  }

  const [rules] = await pg`SELECT COUNT(*) AS n FROM scm.so_scan_rules`;
  console.log(`  distilled rule rows (so_scan_rules): ${num(rules.n)}\n`);

  console.log("=".repeat(70));
  if (num(tot.with_corrected) === 0) {
    console.log("VERDICT: NOT LEARNING. Every sample is still raw — no operator correction");
    console.log("has ever been written back, so the few-shot pool is empty and the");
    console.log("extractor sees no examples. The mechanism exists and is not running.");
  } else {
    console.log(`VERDICT: LEARNING. ${num(tot.with_corrected)} correction(s) are in the pool;`);
    console.log(`the extractor draws its 5 most recent per rep from these.`);
    console.log(`Reps showing 0 corrections above get NO personalised examples yet.`);
  }
  console.log("=".repeat(70));
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally { await pg.end({ timeout: 5 }); }
