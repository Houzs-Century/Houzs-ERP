#!/usr/bin/env node
// READ-ONLY: (a) real per-parent sofa AutoCount codes (distinct supplier_sku
// among bound compartments) to validate the collapse mapping, and (b) the ERP
// salesperson master (sales_reps) to auto-match against the AutoCount agent list.
// No writes.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
function h(t) { console.log(`\n===== ${t} =====`); }
async function safe(l, fn) { try { return await fn(); } catch (e) { console.log(`  [${l}] ${e.message}`); return null; } }

// AutoCount Sales Agent list (from Sales Agent Maintenance screenshot, HOUZS
// CENTURY [LIVE]); the agent name IS the code. Partial (top of a 79-row list).
const AC_AGENTS = ["KINGSLEY","MK","WW","ALEX","OTHERS","SIANG","IDA","ALVIN","LIANG","JOEY","KRIS","PETER","STANLEY","WEI HOW","SHU HUI","LUIS","YUNY","ANTHONY","NINA","JUNIE","GRACE","YANG","JIA HOU","TERRY","MEI TING","SALLY","JANE","SHAWN","LAWRENCE","YURI","RACHAEL","SIA JONAS","SIA JOSIAH","DS","SHUANG"];
const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();

async function main() {
  console.log("Sofa parent codes + salesperson<->agent match (read-only)");

  await safe("sofa", async () => {
    h("sofa per-parent: DISTINCT AutoCount codes among BOUND compartments (co1)");
    const parents = await sql`
      SELECT DISTINCT split_part(code,'-',1) parent FROM scm.mfg_products
      WHERE company_id='1' AND category::text='SOFA' ORDER BY 1`;
    for (const { parent } of parents) {
      const codes = await sql`
        SELECT DISTINCT btrim(b.supplier_sku) ac, count(*)::int n
        FROM scm.mfg_products p
        JOIN scm.supplier_material_bindings b
          ON b.material_code=p.code AND b.company_id=p.company_id AND b.material_kind='mfg_product'
         AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>''
        WHERE p.company_id='1' AND p.category::text='SOFA' AND split_part(p.code,'-',1)=${parent}
        GROUP BY 1 ORDER BY 2 DESC`;
      const [tot] = await sql`
        SELECT count(*)::int n FROM scm.mfg_products
        WHERE company_id='1' AND category::text='SOFA' AND split_part(code,'-',1)=${parent}`;
      const bound = codes.reduce((a, c) => a + c.n, 0);
      const codeStr = codes.length ? codes.map(c => `${c.ac}(${c.n})`).join(" | ") : "(none bound)";
      console.log(`  ${parent.padEnd(8)} total=${tot.n} bound=${bound} unbound=${tot.n - bound}  ->  ${codeStr}`);
    }
  });

  await safe("reps", async () => {
    h("ERP sales_reps vs AutoCount agent list (auto-match by name)");
    const reps = await sql`SELECT to_jsonb(t) j FROM sales_reps t`;
    console.log(`  sales_reps rows: ${reps.length}`);
    const acSet = new Set(AC_AGENTS.map(norm));
    const matched = [], unmatched = [];
    for (const { j } of reps) {
      const name = j.name || j.full_name || j.display_name || "";
      const code = j.code || j.rep_code || "";
      const hit = acSet.has(norm(name)) || acSet.has(norm(code));
      (hit ? matched : unmatched).push(`${name}${code ? ` [${code}]` : ""}${j.active === false ? " (inactive)" : ""}`);
    }
    console.log(`  matched to an AC agent: ${matched.length}`);
    matched.forEach(m => console.log(`    OK   ${m}`));
    console.log(`  NOT matched (need owner or fuzzy): ${unmatched.length}`);
    unmatched.forEach(m => console.log(`    ??   ${m}`));
  });

  await safe("hrprof", async () => {
    h("scm.hr_salesperson_profiles (fallback salesperson source)");
    const rows = await sql`SELECT to_jsonb(t) j FROM scm.hr_salesperson_profiles t LIMIT 100`;
    console.log(`  rows: ${rows.length}`);
    for (const { j } of rows.slice(0, 40)) console.log(`    ${JSON.stringify(j).slice(0, 160)}`);
  });

  console.log("\nDONE (read-only).");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
