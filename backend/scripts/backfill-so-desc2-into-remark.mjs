#!/usr/bin/env node
// Carry AutoCount's Description 2 onto the migrated sales-order line's REMARK.
//
// Owner, 2026-09-08: 「记得把autocount的这个description2 remain着搬进去我们的
// remark」.
//
// The composition rule, the marker and the reasoning all live in
// scripts/lib/desc2-remark.mjs, which is where the tests point. In one line:
// the book's Desc2 is APPENDED to the existing remark on its own final line
// behind `AC原文: `, so the importer's own sofa notes survive and a script can
// still split the two apart. The words are AutoCount's, verbatim.
//
// SOURCE OF TRUTH is the COMMITTED snapshot data/ac-reconcile-truth.json.gz
// (types.SO.desc2 — one row per DtlKey whose book Desc2 is not blank). No live
// AutoCount read: a wide scan of the book is a LOCK TIMEOUT that presents as a
// permissions refusal.
//
// Rows are paired to the book on `linked_ac_dtlkey` and NEVER on position
// (docs/bugs/0690).
//
// MODE: plan by default (reads only, writes a plan file).
//       MODE=apply + CONFIRM="CARRY AC DESC2 INTO REMARK" writes.
// PLAN: apply reads the COMMITTED plan and refuses if its digest no longer
//       matches what the database now holds — a plan built before another lane
//       rewrote these remarks is stale, and a stale plan must not be applied.
//
// RE-RUN: inert. `composeRemark` returns null for any remark that already
// carries the marked block or already quotes the book text, so a second run
// plans zero rows and writes nothing. Proved by tests/desc2IntoRemark.test.mjs
// ("running it twice is a no-op", "a second plan over the already-applied rows
// is empty"), and by re-running the planner after the apply.

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { planRows, planDigest, splitRemark, AC_MARK } from "./lib/desc2-remark.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "CARRY AC DESC2 INTO REMARK";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" — refusing.`);
  process.exit(2);
}

const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = process.env.PLAN_PATH || path.join(here, "data", "desc2-remark-plan.json");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/** The book's own Desc2, keyed by AutoCount DtlKey. */
function loadBookDesc2() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))));
  const rows = snap?.types?.SO?.desc2;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("snapshot has no types.SO.desc2 — refusing to plan against nothing");
  }
  return new Map(rows.map(([k, v]) => [String(k).trim(), v]));
}

const SELECT_TARGETS = `
  SELECT id::text AS id, doc_no, line_no, linked_ac_dtlkey::text AS linked_ac_dtlkey, remark
    FROM scm.mfg_sales_order_items
   WHERE company_id = $1 AND linked_ac_dtlkey IS NOT NULL`;

/**
 * The CONTROL: a fingerprint of everything this job must NOT touch — money,
 * quantity, the variants blob, the item code. Taken before and after the write
 * and asserted identical, so "only the remark moved" is measured rather than
 * asserted.
 */
const CONTROL_SQL = `
  SELECT md5(string_agg(sig, '' ORDER BY sig)) AS control, count(*)::int AS n
    FROM (SELECT id::text || '|' || coalesce(item_code,'') || '|' || coalesce(qty::text,'')
                 || '|' || coalesce(unit_price_sen::text,'') || '|' || coalesce(total_sen::text,'')
                 || '|' || coalesce(balance_sen::text,'') || '|' || coalesce(variants::text,'')
                 || '|' || coalesce(description2,'') AS sig
            FROM scm.mfg_sales_order_items
           WHERE company_id = $1 AND linked_ac_dtlkey IS NOT NULL) s`;

async function readTargets(sql) {
  return sql.unsafe(SELECT_TARGETS, [COMPANY_ID]);
}

async function main() {
  const book = loadBookDesc2();
  log(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"} company=${COMPANY_ID} book Desc2 rows=${book.size}`);

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const rows = await readTargets(sql);
    const withKey = rows.length;
    const { updates, skipped } = planRows(rows, book);
    const carried = rows.filter((r) => splitRemark(r.remark).acDesc2 !== null).length;
    const haveBook = withKey - skipped.noKey - skipped.noBookText;

    log(`migrated company-${COMPANY_ID} SO lines carrying an AutoCount line key: ${withKey}`);
    log(`  of those, the book has a Description 2 for: ${haveBook}`);
    log(`  already carrying it in the remark (no change): ${skipped.alreadyCarried + skipped.alreadyQuoted}`);
    log(`      - already marked with ${AC_MARK.trim()} : ${skipped.alreadyCarried}`);
    log(`      - remark already quotes the text        : ${skipped.alreadyQuoted}`);
    log(`  MISSING from the remark today (the backfill): ${updates.length}`);
    log(`  no book Description 2 at all (left blank)   : ${skipped.noBookText}`);
    log(`plan digest: ${planDigest(updates)}`);

    if (!APPLY) {
      const plan = {
        built_at: new Date().toISOString(),
        company_id: COMPANY_ID,
        marker: AC_MARK,
        counts: { withKey, haveBook, toUpdate: updates.length, alreadyCarried: carried, ...skipped },
        digest: planDigest(updates),
        updates,
      };
      fs.mkdirSync(path.dirname(PLAN_PATH), { recursive: true });
      fs.writeFileSync(PLAN_PATH, `${JSON.stringify(plan, null, 1)}\n`);
      log(`PLAN ONLY — nothing written to the database. Plan saved: ${PLAN_PATH}`);
      return;
    }

    // ---- APPLY -------------------------------------------------------------
    if (!fs.existsSync(PLAN_PATH)) {
      console.error(`MODE=apply needs the committed plan at ${PLAN_PATH}. Run the plan first.`);
      process.exit(2);
    }
    const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
    if (plan.company_id !== COMPANY_ID) {
      console.error(`plan is for company ${plan.company_id}, this run is company ${COMPANY_ID} — refusing.`);
      process.exit(2);
    }
    /* THE STALENESS GATE. The plan was built against remarks that another lane
       may since have rewritten. Re-planning from the CURRENT rows must produce
       the identical digest, or the committed plan no longer describes reality
       and applying it would clobber somebody's work. */
    const nowDigest = planDigest(updates);
    if (nowDigest !== plan.digest) {
      console.error("REFUSING: the committed plan is STALE.");
      console.error(`  plan digest : ${plan.digest} (${plan.updates.length} rows, built ${plan.built_at})`);
      console.error(`  live  digest: ${nowDigest} (${updates.length} rows, now)`);
      console.error("  Something changed these remarks since the plan was built. Re-plan, review, re-commit.");
      process.exit(2);
    }
    if (updates.length === 0) { log("nothing to do — already carried."); return; }

    const control = (await sql.unsafe(CONTROL_SQL, [COMPANY_ID]))[0];
    log(`control before: ${control.control} over ${control.n} rows`);

    /* Per-row optimistic guard on top of the batch-level digest gate: each row
       is updated only while its remark is still the one the plan read. A row
       somebody edits between the digest check and this statement is skipped,
       not clobbered — and the row-count assertion below turns that into a loud
       failure rather than a silent partial write. */
    let changed = 0;
    await sql.begin(async (tx) => {
      const CHUNK = 500;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const batch = updates.slice(i, i + CHUNK);
        const res = await tx.unsafe(
          `UPDATE scm.mfg_sales_order_items AS t
              SET remark = v.after
             FROM (SELECT unnest($1::uuid[]) AS id,
                          unnest($2::text[]) AS after,
                          unnest($3::text[]) AS before) AS v
            WHERE t.id = v.id
              AND t.company_id = $4
              AND t.remark IS NOT DISTINCT FROM v.before`,
          [
            batch.map((u) => u.id),
            batch.map((u) => u.after),
            batch.map((u) => u.before),
            COMPANY_ID,
          ],
        );
        changed += res.count ?? 0;
      }
      if (changed !== updates.length) {
        throw new Error(`expected to update ${updates.length} lines, updated ${changed} — a remark moved under us; rolling back.`);
      }
    });
    log(`UPDATE applied to ${changed} lines.`);

    // ---- VERIFY on a FRESH connection, asserting the SHAPE ------------------
    await sql.end({ timeout: 5 });
    const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
    try {
      const after = await readTargets(check);
      const byId = new Map(after.map((r) => [r.id, r]));
      let good = 0;
      const bad = [];
      for (const u of updates) {
        const row = byId.get(u.id);
        const parsed = splitRemark(row?.remark);
        const shapeOk = typeof row?.remark === "string"
          && parsed.acDesc2 === splitRemark(u.after).acDesc2
          && parsed.base === splitRemark(u.after).base;
        if (shapeOk) good += 1; else bad.push({ id: u.id, docNo: u.docNo, got: row?.remark ?? null });
      }
      log(`fresh re-read: ${good}/${updates.length} lines now carry the book text, split back to the same two halves`);
      if (bad.length) {
        console.error(`SHAPE FAILURE on ${bad.length} lines, first 5:`, JSON.stringify(bad.slice(0, 5)));
        process.exit(1);
      }
      const still = planRows(after, book);
      log(`re-plan on the fresh connection: ${still.updates.length} rows left to do (idempotence: expect 0)`);
      if (still.updates.length !== 0) { console.error("NOT IDEMPOTENT — a second run would write again."); process.exit(1); }

      const control2 = (await check.unsafe(CONTROL_SQL, [COMPANY_ID]))[0];
      log(`control after : ${control2.control} over ${control2.n} rows`);
      if (control2.control !== control.control || control2.n !== control.n) {
        console.error("CONTROL FAILURE: a money / quantity / variant / description2 value moved. Investigate before trusting this run.");
        process.exit(1);
      }
      log("CONTROL HELD: item code, qty, unit price, line total, balance, variants and description2 are byte-identical.");
    } finally {
      await check.end({ timeout: 5 });
    }
    return;
  } finally {
    try { await sql.end({ timeout: 5 }); } catch { /* already closed on the apply path */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
