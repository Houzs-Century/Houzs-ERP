#!/usr/bin/env node
// Opens AutoCount SKUs that are missing from scm.mfg_products for one company.
// Idempotent: only inserts codes not already present for that company_id, so a
// re-run is a no-op. MODE=dry-run (default) reports what WOULD insert and writes
// nothing; MODE=apply performs the inserts.
//
// Source rows come from a committed JSON so the exact write is reviewable in the
// PR. Env: DATABASE_URL (required), MODE (dry-run|apply), DATA_FILE.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const mode = (process.env.MODE || "dry-run").toLowerCase();
const dataFile = process.env.DATA_FILE || "scripts/data/align-skus-houzs-century.json";
const payload = JSON.parse(readFileSync(dataFile, "utf-8"));
const cid = String(payload.company_id);
const rows = payload.rows || [];

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

function tally(list, key) {
  const m = {};
  for (const r of list) m[r[key]] = (m[r[key]] || 0) + 1;
  return m;
}

async function main() {
  console.log(`MODE=${mode} company_id=${cid} source_rows=${rows.length} source="${payload.source}"`);

  const existing = new Set(
    (await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${cid}`).map((r) => String(r.code).trim())
  );
  console.log(`existing mfg_products for company ${cid}: ${existing.size}`);

  const toInsert = rows.filter((r) => !existing.has(String(r.code).trim()));
  const skipped = rows.length - toInsert.length;
  console.log(`WILL_INSERT=${toInsert.length} ALREADY_PRESENT_SKIPPED=${skipped}`);
  console.log("by category:", JSON.stringify(tally(toInsert, "category")));
  console.log("by status:", JSON.stringify(tally(toInsert, "status")));
  const known = new Set(["BEDFRAME", "MATTRESS", "SOFA", "ACCESSORY", "SERVICE"]);
  const newCats = [...new Set(toInsert.map((r) => r.category))].filter((c) => !known.has(c));
  console.log("new categories introduced:", JSON.stringify(newCats));
  console.log("sample (first 8):", JSON.stringify(toInsert.slice(0, 8)));

  if (mode !== "apply") {
    console.log("DRY-RUN: no rows written.");
    return;
  }

  const now = new Date().toISOString();
  const records = toInsert.map((r) => ({
    id: "mfg-" + randomBytes(6).toString("hex"),
    code: r.code,
    name: r.name,
    company_id: cid,
    category: r.category,
    status: r.status || "ACTIVE",
    barcode: r.barcode ?? null,
    created_at: now,
    updated_at: now,
  }));

  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const res = await sql`INSERT INTO scm.mfg_products ${sql(
      chunk,
      "id", "code", "name", "company_id", "category", "status", "barcode", "created_at", "updated_at"
    )} ON CONFLICT DO NOTHING`;
    inserted += res.count;
    console.log(`  inserted batch ${i / BATCH + 1}: +${res.count} (running ${inserted})`);
  }
  console.log(`APPLIED: inserted ${inserted} rows into scm.mfg_products (company ${cid}).`);

  const after = Number((await sql`SELECT count(*)::int AS n FROM scm.mfg_products WHERE company_id = ${cid}`)[0].n);
  console.log(`mfg_products for company ${cid} now: ${after}`);
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
