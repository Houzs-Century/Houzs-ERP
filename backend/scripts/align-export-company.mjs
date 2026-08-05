#!/usr/bin/env node
// READ-ONLY: dump the master data needed to align AutoCount SKUs into the ERP.
// For a given company_id, writes JSON snapshots of the product + supplier
// masters (and the AutoCount creditor mirror) so a local fuzzy-match can decide
// which AutoCount items/suppliers are missing. No writes -- SELECT only.
//
// Env: DATABASE_URL (required), COMPANY_ID (default "1" = HOUZS/Houzs Century).
// Output: out/*.json, uploaded as a workflow artifact.
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";

const cid = process.env.COMPANY_ID || "1";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

mkdirSync("out", { recursive: true });

async function dump(label, file, query) {
  try {
    const rows = await query();
    writeFileSync(`out/${file}`, JSON.stringify(rows, null, 0));
    console.log(`${label}: ${rows.length} rows -> out/${file}`);
  } catch (e) {
    console.log(`${label}: ERROR ${e.message}`);
    writeFileSync(`out/${file}`, "[]");
  }
}

async function main() {
  console.log(`COMPANY_ID=${cid}`);
  await dump("companies", "companies.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM public.companies t ORDER BY id`).map((r) => r.j)
  );
  await dump("products", "products.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM scm.products t WHERE t.company_id = ${cid}`).map((r) => r.j)
  );
  await dump("suppliers", "suppliers.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM scm.suppliers t`).map((r) => r.j)
  );
  await dump("creditors", "creditors.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM public.creditors t`).map((r) => r.j)
  );
  // product count per company for a sanity cross-check
  try {
    const byCo = await sql`SELECT company_id, count(*)::int AS n FROM scm.products GROUP BY company_id ORDER BY company_id`;
    console.log("PRODUCTS_PER_COMPANY:", JSON.stringify(byCo));
  } catch (e) {
    console.log("PRODUCTS_PER_COMPANY: ERROR", e.message);
  }
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
