// Append the compartment code to sofa compartment bindings' supplier_sku.
//
// Owner 2026-08-09: "Supplier SKU 这一边没有 compartment code — 让人家怎样知道
// 是什么 compartment?" The 2026-08 load stamped every compartment binding
// with the model-level AutoCount item (AutoCount has one code per sofa), so
// a PO line for 9050-1A(RHF) showed just "AMN-SF9050 SOFA".
//
// Fix: supplier_sku := "<current> <COMP>" for every HOUZS mfg_product
// binding whose material_code is a sofa compartment SKU ({MODEL}-{COMP})
// and whose supplier_sku does not already mention the compartment. The
// AutoCount prefix stays intact for cross-referencing.
//
// DRY-RUN default; APPLY=1 writes. One transaction.
//
// RE-RUN: inert. The rewrite is computed from the current supplier_sku and a corrected value no longer matches the pattern it looks for.
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// compartment suffix grammar: 1S/2S/3S, 1NA/2NA, 1A/2A/1B/2B (+(P)/(R), +(LHF)/(RHF)),
// L(LHF)/L(RHF), 1S(R)/1S(P), 1NA(R)/1NA(P), CNR, Console, STOOL
const COMP_RE = /^(?:[123](?:S|NA|A|B)(?:\((?:P|R)\))?(?:\((?:LHF|RHF)\))?|L\((?:LHF|RHF)\)|CNR|Console|STOOL)$/;

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const rows = await sql`
    SELECT b.id, b.material_code, b.supplier_sku, s.code AS sup_code
    FROM scm.supplier_material_bindings b
    JOIN scm.suppliers s ON s.id = b.supplier_id
    JOIN scm.mfg_products p ON p.code = b.material_code AND p.company_id = b.company_id
    WHERE b.company_id = ${co.id} AND b.material_kind = 'mfg_product' AND p.category = 'SOFA'`;
  let fix = 0, ok = 0, skip = 0;
  const samples = [];
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    for (const r of rows) {
      const dash = r.material_code.indexOf("-");
      if (dash < 1) { skip++; continue; }
      const comp = r.material_code.slice(dash + 1);
      if (!COMP_RE.test(comp)) { skip++; continue; }
      const cur = r.supplier_sku || "";
      if (cur.includes(comp)) { ok++; continue; }
      const next = `${cur} ${comp}`.trim();
      fix++;
      if (samples.length < 8) samples.push(`${r.sup_code} ${r.material_code}: "${cur}" -> "${next}"`);
      if (APPLY) await tx`UPDATE scm.supplier_material_bindings
        SET supplier_sku = ${next}, updated_at = ${now} WHERE id = ${r.id}`;
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: fixed ${fix}, already-ok ${ok}, non-compartment ${skip} of ${rows.length}`);
    for (const s of samples) console.log("  " + s);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
