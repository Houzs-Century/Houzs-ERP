// READ-ONLY. Is any supplier bound to the same item twice in production?
//
// scm.supplier_material_bindings has no unique index on (company_id,
// supplier_id, material_kind, item_code) (prod schema dump 2026-11-09), and MRP
// lists every binding row, so a duplicate shows the same supplier twice for an
// item. The create / PATCH routes now refuse a duplicate. A unique index may be
// added only if this reports ZERO duplicate groups; if it reports any, the index
// waits and the rows need a decision (PO lines can point at a binding by id).
//
// SELECT only. No DDL, no writes, no transaction. Exits 0 for every answer;
// only an unreachable database or a query error exits non-zero.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60, prepare: false });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM scm.supplier_material_bindings`;
  notice(`bindings scanned: ${total}`);
  if (total === 0) {
    notice("ZERO binding rows read — not evidence of a clean table. Check the DSN before trusting this.");
    return;
  }

  const groups = await sql`
    SELECT b.company_id, b.supplier_id, s.code AS supplier_code, b.material_kind, b.item_code,
           COUNT(*)::int AS n,
           array_agg(b.id ORDER BY b.created_at) AS ids,
           COUNT(*) FILTER (WHERE b.is_main_supplier)::int AS mains,
           (SELECT COUNT(*)::int FROM scm.purchase_order_items poi WHERE poi.binding_id = ANY (array_agg(b.id))) AS po_lines
      FROM scm.supplier_material_bindings b
      LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     GROUP BY b.company_id, b.supplier_id, s.code, b.material_kind, b.item_code
    HAVING COUNT(*) > 1
     ORDER BY b.company_id, COUNT(*) DESC, s.code, b.item_code`;

  const extra = groups.reduce((a, g) => a + g.n - 1, 0);
  notice(`duplicate groups (same company + supplier + kind + item): ${groups.length}; surplus rows: ${extra}`);
  const byCo = new Map();
  for (const g of groups) byCo.set(g.company_id, (byCo.get(g.company_id) ?? 0) + 1);
  for (const [co, n] of byCo) notice(`  company_id ${co}: ${n} group(s)`);
  for (const g of groups.slice(0, 200)) {
    console.log(`  co=${g.company_id} supplier=${g.supplier_code ?? g.supplier_id} ${g.material_kind} ${g.item_code} x${g.n} mains=${g.mains} po_lines=${g.po_lines} ids=${g.ids.join(",")}`);
  }
  if (groups.length > 200) console.log(`  ... ${groups.length - 200} more group(s) not printed`);
  notice(groups.length === 0
    ? "VERDICT: no duplicates — a unique index can be added."
    : "VERDICT: duplicates exist — the unique index must wait; the route refusal still applies to new rows.");
}

main()
  .catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
