#!/usr/bin/env node
// READ-ONLY harvest of the AutoCount "vocabulary" already synced into the ERP
// DB, so the ERP->AutoCount Sales Order writeback can be aligned without a live
// middleware call. Reports, across ALL companies, the distinct values AutoCount
// validates on a SO (debtor_code, agent, sales_location, branding, venue) plus
// the ERP salesperson master and the sofa parent-prefix collapse.
//
// No writes, no DDL, single connection.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
function h(t) { console.log(`\n===== ${t} =====`); }
async function safe(l, fn) { try { return await fn(); } catch (e) { console.log(`  [${l}] ${e.message}`); return null; } }
const pad = (n) => n.toString().padStart(6);

async function main() {
  console.log("AutoCount vocabulary harvest (read-only, all companies)");

  await safe("companies", async () => {
    h("companies");
    const co = await sql`SELECT id, code, name FROM public.companies ORDER BY id`;
    for (const r of co) console.log(`  id=${r.id}  ${r.code}  ${r.name}`);
  });

  // The single generic debtor account, if that's the pattern.
  await safe("debtor", async () => {
    h("debtor_code by company (find the fixed account code)");
    const rows = await sql`
      SELECT company_id, coalesce(nullif(btrim(debtor_code),''),'(blank)') dc, count(*)::int n
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`;
    for (const r of rows) console.log(`  co${r.company_id}  ${pad(r.n)}  ${r.dc}`);
  });

  await safe("agent", async () => {
    h("agent by company (AutoCount SalesAgent vocabulary)");
    const rows = await sql`
      SELECT company_id, coalesce(nullif(btrim(agent),''),'(blank)') a, count(*)::int n
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 1, 3 DESC`;
    for (const r of rows) console.log(`  co${r.company_id}  ${pad(r.n)}  ${r.a}`);
  });

  await safe("loc", async () => {
    h("sales_location by company (AutoCount Location vocabulary)");
    const rows = await sql`
      SELECT company_id, coalesce(nullif(btrim(sales_location),''),'(blank)') l, count(*)::int n
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 1, 3 DESC`;
    for (const r of rows) console.log(`  co${r.company_id}  ${pad(r.n)}  ${r.l}`);
  });

  await safe("branding", async () => {
    h("branding by company");
    const rows = await sql`
      SELECT company_id, coalesce(nullif(btrim(branding),''),'(blank)') b, count(*)::int n
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 1, 3 DESC`;
    for (const r of rows) console.log(`  co${r.company_id}  ${pad(r.n)}  ${r.b}`);
  });

  await safe("venue", async () => {
    h("venue by company (top 40)");
    const rows = await sql`
      SELECT company_id, coalesce(nullif(btrim(venue),''),'(blank)') v, count(*)::int n
      FROM scm.mfg_sales_orders GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`;
    for (const r of rows) console.log(`  co${r.company_id}  ${pad(r.n)}  ${r.v}`);
  });

  // ERP salesperson master -> to map onto AutoCount agents.
  await safe("staff", async () => {
    h("ERP staff (sales-facing) for agent mapping");
    const rows = await sql`
      SELECT staff_code, name, role::text role, active FROM public.staff
      ORDER BY active DESC, name LIMIT 80`;
    console.log(`  rows: ${rows.length}`);
    for (const r of rows) console.log(`    ${r.active ? " " : "x"} ${r.staff_code}  ${r.name}  [${r.role}]`);
  });

  // Sofa: our compartment SKUs collapse to a single AutoCount code + Desc2.
  // Show, per parent prefix, how many unlinked compartments and whether the
  // parent already has an AutoCount code somewhere.
  await safe("sofa", async () => {
    h("sofa parent-prefix collapse (company 1, unlinked SOFA)");
    const rows = await sql`
      SELECT split_part(p.code,'-',1) parent, count(*)::int n
      FROM scm.mfg_products p
      WHERE p.company_id='1' AND p.category::text='SOFA'
        AND NOT EXISTS (SELECT 1 FROM scm.supplier_material_bindings b
          WHERE b.material_code=p.code AND b.company_id=p.company_id
            AND b.material_kind='mfg_product'
            AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>'')
      GROUP BY 1 ORDER BY 1`;
    for (const r of rows) {
      const [hit] = await sql`
        SELECT count(*)::int n, max(supplier_sku) ac FROM scm.supplier_material_bindings
        WHERE company_id='1' AND material_kind='mfg_product'
          AND (btrim(supplier_sku)=${r.parent} OR material_code LIKE ${r.parent + '-%'})`;
      console.log(`  ${r.parent.padEnd(10)} unlinked=${r.n}  parent_ac_code=${hit.ac || '-'} (hits ${hit.n})`);
    }
  });

  console.log("\nDONE (read-only).");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
