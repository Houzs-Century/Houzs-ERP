#!/usr/bin/env node
// READ-ONLY census of the master data that an ERP Sales Order references, so we
// can size the gap for writing an ERP SO back into AutoCount as a Sales Order.
//
// For each controlled master (the values AutoCount validates on a SO), report
// how many distinct ERP values exist and how many are already linked to an
// AutoCount code. Anything unlinked would make the writeback API reject the SO.
//
// No writes, no DDL, single connection. Default company_id=1 (Houzs Century,
// the one AutoCount account book). 2990 (id=2) is out of scope for writeback.
import postgres from "postgres";

const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

function h(t) { console.log(`\n===== ${t} =====`); }
async function safe(label, fn) {
  try { return await fn(); }
  catch (e) { console.log(`  [${label}] query failed: ${e.message}`); return null; }
}

async function main() {
  console.log(`AutoCount master-align census  company_id=${cid}  (read-only)`);

  // 1) SKU (StockItem) — the biggest controlled master. A SO line's ItemCode
  //    must exist in AutoCount. We treat "has a supplier binding carrying an
  //    AutoCount supplier_sku" as linked.
  h("1) SKU / ItemCode coverage");
  await safe("sku", async () => {
    const [tot] = await sql`SELECT count(*)::int n FROM scm.mfg_products WHERE company_id=${cid}`;
    const [linked] = await sql`
      SELECT count(DISTINCT p.code)::int n
      FROM scm.mfg_products p
      JOIN scm.supplier_material_bindings b
        ON b.item_code = p.code AND b.company_id = p.company_id
       AND b.material_kind = 'mfg_product'
       AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku) <> ''
      WHERE p.company_id=${cid}`;
    console.log(`  total SKUs:           ${tot.n}`);
    console.log(`  linked to AutoCount:  ${linked.n}`);
    console.log(`  UNLINKED (gap):       ${tot.n - linked.n}`);
    const unlinked = await sql`
      SELECT p.code, p.name, p.category::text AS category
      FROM scm.mfg_products p
      WHERE p.company_id=${cid}
        AND NOT EXISTS (
          SELECT 1 FROM scm.supplier_material_bindings b
          WHERE b.item_code=p.code AND b.company_id=p.company_id
            AND b.material_kind='mfg_product'
            AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku) <> '')
      ORDER BY p.code LIMIT 25`;
    if (unlinked.length) {
      console.log(`  sample unlinked (max 25):`);
      for (const r of unlinked) console.log(`    ${r.code}  |  ${r.name}  [${r.category}]`);
    }
  });

  // 2) Branding -> SOUDF_BRANDING (dropdown UDF, controlled)
  h("2) Branding (-> SOUDF_BRANDING dropdown)");
  await safe("branding", async () => {
    const prod = await sql`
      SELECT btrim(branding) AS v, count(*)::int n FROM scm.mfg_products
      WHERE company_id=${cid} AND branding IS NOT NULL AND btrim(branding)<>''
      GROUP BY 1 ORDER BY 1`;
    const so = await sql`
      SELECT btrim(branding) AS v, count(*)::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND branding IS NOT NULL AND btrim(branding)<>''
      GROUP BY 1 ORDER BY 1`;
    console.log(`  distinct branding on products: ${prod.length}`);
    console.log(`    ${prod.map(r => `${r.v}(${r.n})`).join(", ")}`);
    console.log(`  distinct branding on SOs:      ${so.length}`);
    console.log(`    ${so.map(r => `${r.v}(${r.n})`).join(", ")}`);
  });

  // 3) Venue -> SOUDF_VENUE (dropdown UDF, controlled)
  h("3) Venue (-> SOUDF_VENUE dropdown)");
  await safe("venue", async () => {
    const so = await sql`
      SELECT btrim(venue) AS v, count(*)::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND venue IS NOT NULL AND btrim(venue)<>''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 60`;
    console.log(`  distinct venue on SOs (top 60 by count): ${so.length}`);
    for (const r of so) console.log(`    ${r.n.toString().padStart(5)}  ${r.v}`);
    await safe("venues-table", async () => {
      const [vt] = await sql`SELECT count(*)::int n FROM venues`;
      console.log(`  venues master table rows: ${vt.n}`);
    });
  });

  // 4) Agent -> SalesAgent (master, controlled)
  h("4) Sales Agent (-> SalesAgent master)");
  await safe("agent", async () => {
    const so = await sql`
      SELECT btrim(agent) AS v, count(*)::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND agent IS NOT NULL AND btrim(agent)<>''
      GROUP BY 1 ORDER BY 2 DESC`;
    console.log(`  distinct agent on SOs: ${so.length}`);
    for (const r of so) console.log(`    ${r.n.toString().padStart(5)}  ${r.v}`);
    const [nullc] = await sql`
      SELECT count(*)::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND (agent IS NULL OR btrim(agent)='')`;
    console.log(`  SOs with NO agent: ${nullc.n}`);
  });

  // 5) Debtor -> DebtorCode/DebtorName (master, controlled)
  h("5) Debtor / customer (-> DebtorCode master)");
  await safe("debtor", async () => {
    const [tot] = await sql`SELECT count(*)::int n FROM scm.mfg_sales_orders WHERE company_id=${cid}`;
    const [dc] = await sql`
      SELECT count(DISTINCT btrim(debtor_code))::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND debtor_code IS NOT NULL AND btrim(debtor_code)<>''`;
    const [dn] = await sql`SELECT count(DISTINCT btrim(debtor_name))::int n FROM scm.mfg_sales_orders WHERE company_id=${cid}`;
    const [nodc] = await sql`
      SELECT count(*)::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND (debtor_code IS NULL OR btrim(debtor_code)='')`;
    console.log(`  total SOs:                 ${tot.n}`);
    console.log(`  distinct debtor_code:      ${dc.n}`);
    console.log(`  distinct debtor_name:      ${dn.n}`);
    console.log(`  SOs with NO debtor_code:   ${nodc.n}  (would need an AutoCount debtor first)`);
  });

  // 6) Sales Location -> SalesLocation (master, controlled)
  h("6) Sales Location (-> SalesLocation master)");
  await safe("loc", async () => {
    const so = await sql`
      SELECT btrim(sales_location) AS v, count(*)::int n FROM scm.mfg_sales_orders
      WHERE company_id=${cid} AND sales_location IS NOT NULL AND btrim(sales_location)<>''
      GROUP BY 1 ORDER BY 2 DESC`;
    console.log(`  distinct sales_location on SOs: ${so.length}`);
    for (const r of so) console.log(`    ${r.n.toString().padStart(5)}  ${r.v}`);
  });

  // 7) Creditor (line-level supplier on the SO) — AutoCount creditor master is
  //    mirrored locally in `creditors`.
  h("7) Creditor / supplier (line-level, mirrored in `creditors`)");
  await safe("creditor", async () => {
    const [cr] = await sql`SELECT count(*)::int n FROM creditors`;
    console.log(`  creditors mirrored from AutoCount: ${cr.n}`);
    const [sup] = await sql`SELECT count(*)::int n FROM scm.suppliers WHERE company_id=${cid}`;
    console.log(`  scm.suppliers (company ${cid}):      ${sup.n}`);
    const [bound] = await sql`
      SELECT count(DISTINCT supplier_id)::int n FROM scm.supplier_material_bindings
      WHERE company_id=${cid} AND material_kind='mfg_product'`;
    console.log(`  suppliers with >=1 SKU binding:    ${bound.n}`);
  });

  console.log("\nDONE (read-only).");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
