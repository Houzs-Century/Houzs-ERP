// READ-ONLY. Where is ALL the physical stock, by warehouse? (owner 2026-08-02:
// "most POs should be KL Warehouse, otherwise the 2990s PJ showroom display —
// we don't have goods anywhere else and don't need to.")
//
// This lists every on-hand lot grouped by warehouse, per company, so the owner
// can see exactly which warehouses hold stock and flag any that should not. For
// each lot it also shows the SOURCE PO's warehouse, so a lot sitting in a
// different warehouse than the PO bound (a GR that received into the wrong place)
// is visible in one line. Nothing is "corrected" here — this is the picture the
// correction plan is built from.
//
// SELECT only. No writes. Enum columns ::text before string ops.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const num = (v) => Number(v ?? 0);

async function main() {
  notice("=== INVENTORY BY WAREHOUSE — where is every on-hand unit? READ-ONLY ===");
  const whs = await sql`SELECT id, code, name, is_showroom, type::text AS type FROM scm.warehouses`;
  const whById = new Map(whs.map((w) => [w.id, w]));
  const whLabel = (id) => (id ? (whById.get(id)?.code ?? whById.get(id)?.name ?? String(id)) : "NONE");
  const isShowroom = (id) => { const w = whById.get(id); return !!w && (w.is_showroom === true || (w.type ?? "").toLowerCase() === "showroom"); };

  // PO line warehouse by (po_number, product_code), for the lot-vs-PO comparison.
  const poWh = new Map();
  for (const r of await sql`
    SELECT po.po_number, pi.material_code, COALESCE(pi.warehouse_id, po.purchase_location_id) AS wh, po.company_id
      FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id`)
    poWh.set(`${r.company_id}|${r.po_number}|${r.material_code}`, r.wh);

  const companies = (await sql`SELECT DISTINCT company_id FROM scm.inventory_lots WHERE qty_remaining > 0 ORDER BY company_id`).map((r) => r.company_id);
  for (const companyId of companies) {
    notice("");
    notice(`################ COMPANY ${companyId} ################`);
    const lots = await sql`
      SELECT warehouse_id, product_code, COALESCE(variant_key,'') AS vkey, batch_no,
             SUM(qty_remaining)::numeric AS qty, SUM(qty_remaining * COALESCE(unit_cost_sen,0))::numeric AS value_sen
        FROM scm.inventory_lots
       WHERE company_id = ${companyId} AND qty_remaining > 0
       GROUP BY 1,2,3,4 ORDER BY 1,2`;
    // group by warehouse
    const byWh = new Map();
    for (const l of lots) {
      const g = byWh.get(l.warehouse_id) ?? { qty: 0, value: 0, lots: [] };
      g.qty += num(l.qty); g.value += num(l.value_sen); g.lots.push(l);
      byWh.set(l.warehouse_id, g);
    }
    notice(`  warehouses holding stock: ${byWh.size}`);
    notice(`  ${pad("warehouse", 16)} ${pad("kind", 10)} ${pad("units", 8)} ${pad("value(RM)", 12)} distinct SKUs`);
    for (const [whId, g] of [...byWh].sort((a, b) => b[1].qty - a[1].qty)) {
      const kind = isShowroom(whId) ? "SHOWROOM" : "warehouse";
      notice(`  ${pad(whLabel(whId), 16)} ${pad(kind, 10)} ${pad(g.qty, 8)} ${pad((g.value / 100).toFixed(2), 12)} ${new Set(g.lots.map((l) => l.product_code)).size}`);
    }
    // per-lot detail + lot-vs-PO warehouse flag
    notice("  ---- every lot, and whether it sits where its source PO bound ----");
    let mismatch = 0, showroomUnits = 0;
    for (const [whId, g] of [...byWh].sort((a, b) => b[1].qty - a[1].qty)) {
      notice(`  == ${whLabel(whId)}${isShowroom(whId) ? " (SHOWROOM)" : ""} ==`);
      for (const l of g.lots) {
        const src = l.batch_no ? poWh.get(`${companyId}|${l.batch_no}|${l.product_code}`) : undefined;
        const flag = (src && src !== whId) ? `  <-- PO bound ${whLabel(src)}, stock is HERE (GR<>PO)` : "";
        if (src && src !== whId) mismatch += 1;
        if (isShowroom(whId)) showroomUnits += num(l.qty);
        notice(`      ${pad(l.product_code, 28)} qty ${pad(l.qty, 3)} <- ${pad(l.batch_no ?? "(no batch)", 20)}${flag}`);
      }
    }
    notice(`  lots whose warehouse != their source PO's warehouse : ${mismatch}`);
    notice(`  units physically recorded in a SHOWROOM              : ${showroomUnits}`);
  }
  notice("");
  notice("  Owner's expected locations (2026-08-02): KL WAREHOUSE + the 2990s PJ showroom display");
  notice("  (Houzs: C&C DISPLAY). Any OTHER warehouse holding stock above — or a lot flagged GR<>PO");
  notice("  — is a candidate to relocate. Nothing was changed; this is the plan's input.");
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("INVENTORY_LOCATIONS_FAIL", e?.message ?? e);
  process.exit(1);
});
