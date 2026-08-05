#!/usr/bin/env node
// READ-ONLY: dump the master data needed to align AutoCount SKUs into the ERP.
// For a given company_id, writes JSON snapshots of the SKU master (mfg_products
// -- the Houzs manufacturer SKU master), the retail catalog (products), product
// models, fabrics, the supplier master and the AutoCount creditor mirror, so a
// local fuzzy-match can decide which AutoCount items/suppliers are missing.
// SELECT only -- no writes.
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

  // Discovery: every base table that could hold an item/SKU/product/material,
  // with a per-company row count where a company_id column exists.
  try {
    const tabs = await sql`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type='BASE TABLE'
        AND table_schema IN ('scm','public')
        AND (table_name ~* '(product|item|sku|model|fabric|material|catalog|stock)')
      ORDER BY 1,2`;
    console.log(`DISCOVERY: ${tabs.length} candidate tables`);
    for (const t of tabs) {
      const has = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=${t.table_schema} AND table_name=${t.table_name} AND column_name='company_id' LIMIT 1`;
      let line;
      if (has.length) {
        const b = await sql.unsafe(
          `SELECT company_id, count(*)::int n FROM ${t.table_schema}.${t.table_name} GROUP BY company_id ORDER BY company_id`
        );
        line = b.map((r) => `co${r.company_id}=${r.n}`).join(",");
      } else {
        const c = await sql.unsafe(`SELECT count(*)::int n FROM ${t.table_schema}.${t.table_name}`);
        line = `total=${c[0].n} (no company_id)`;
      }
      console.log(`  ${t.table_schema}.${t.table_name}: ${line}`);
    }
  } catch (e) {
    console.log("DISCOVERY ERROR", e.message);
  }

  await dump("companies", "companies.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM public.companies t ORDER BY id`).map((r) => r.j)
  );
  await dump("mfg_products", "mfg_products.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM scm.mfg_products t WHERE t.company_id = ${cid}`).map((r) => r.j)
  );
  await dump("product_models", "product_models.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM scm.product_models t WHERE t.company_id = ${cid}`).map((r) => r.j)
  );
  await dump("fabrics", "fabrics.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM scm.fabrics t`).map((r) => r.j)
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
  await dump("categories", "categories.json", async () =>
    (await sql`SELECT to_jsonb(t) AS j FROM scm.categories t WHERE t.company_id = ${cid} ORDER BY sort_order`).map((r) => r.j)
  );
  // distinct brandings actually in use (the branding picker source)
  try {
    const b = await sql`SELECT branding, count(*)::int n FROM scm.product_models WHERE company_id = ${cid} AND branding IS NOT NULL AND branding <> '' GROUP BY branding ORDER BY 2 DESC`;
    console.log("BRANDINGS_IN_MODELS:", JSON.stringify(b));
  } catch (e) { console.log("BRANDINGS ERROR", e.message); }
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
