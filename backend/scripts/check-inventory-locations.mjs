// READ-ONLY. The full warehouse picture (owner 2026-08-02): which warehouses do
// 2990 POs order into, which Purchase-Consignment orders/receives were raised and
// where, and where all the physical stock sits — OWNED (from a GRN) kept strictly
// apart from CONSIGNMENT (held, not owned, from a PC Receive), because the two are
// different flows and consignment display units must NEVER be treated as
// mislocated owned stock to relocate.
//
// Owner's expected owned locations: KL WAREHOUSE + the 2990s PJ showroom display
// (Houzs: C&C DISPLAY). Consignment can sit at branches/showrooms by design.
//
// SELECT only. No writes. Enum columns ::text before string ops.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const num = (v) => Number(v ?? 0);
const d10 = (x) => (x ? String(x).slice(0, 10) : "?");

async function main() {
  notice("=== WAREHOUSE PICTURE: PO ship-to + consignment + owned/consignment stock (READ-ONLY) ===");
  const whs = await sql`SELECT id, code, name, is_showroom, type::text AS type FROM scm.warehouses`;
  const whById = new Map(whs.map((w) => [w.id, w]));
  const whLabel = (id) => (id ? (whById.get(id)?.code ?? whById.get(id)?.name ?? String(id)) : "NONE");
  const isShowroom = (id) => { const w = whById.get(id); return !!w && (w.is_showroom === true || (w.type ?? "").toLowerCase() === "showroom"); };

  const companies = (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => r.company_id);
  for (const companyId of companies) {
    notice("");
    notice(`################ COMPANY ${companyId} ################`);

    /* ── (A) OWNED PO — which warehouse does each PO line order into? ─────── */
    const poLines = await sql`
      SELECT COALESCE(pi.warehouse_id, po.purchase_location_id) AS wh, po.status::text AS status,
             COUNT(*)::int AS lines, SUM(pi.qty)::numeric AS units
        FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
       WHERE pi.company_id = ${companyId} AND UPPER(po.status::text) NOT IN ('CANCELLED','DRAFT')
       GROUP BY 1,2 ORDER BY 3 DESC`;
    const poByWh = new Map();
    for (const r of poLines) {
      const g = poByWh.get(r.wh) ?? { lines: 0, units: 0 };
      g.lines += r.lines; g.units += num(r.units); poByWh.set(r.wh, g);
    }
    notice("  ---- (A) OWNED PO: which warehouse do PO lines order into? ----");
    notice(`  ${pad("warehouse", 16)} ${pad("kind", 10)} ${pad("PO lines", 9)} units`);
    for (const [wh, g] of [...poByWh].sort((a, b) => b[1].lines - a[1].lines))
      notice(`  ${pad(whLabel(wh), 16)} ${pad(isShowroom(wh) ? "SHOWROOM" : "warehouse", 10)} ${pad(g.lines, 9)} ${g.units}`);

    /* ── (B) PURCHASE CONSIGNMENT orders — which, when, where ─────────────── */
    const pcos = await sql`
      SELECT o.pc_number, o.status::text AS status, o.purchase_location_id, o.created_at,
             s.name AS supplier,
             (SELECT COUNT(DISTINCT it.warehouse_id) FROM scm.purchase_consignment_order_items it WHERE it.purchase_consignment_order_id = o.id) AS wh_variants
        FROM scm.purchase_consignment_orders o
        LEFT JOIN scm.suppliers s ON s.id = o.supplier_id
       WHERE o.company_id = ${companyId}
       ORDER BY o.created_at DESC NULLS LAST LIMIT 20`;
    notice(`  ---- (B) PURCHASE CONSIGNMENT orders (PCO, most recent ${pcos.length}) ----`);
    for (const p of pcos)
      notice(`      ${pad(p.pc_number, 20)} ${pad(p.status, 10)} ${pad(d10(p.created_at), 10)} -> ${pad(whLabel(p.purchase_location_id), 14)} ${p.supplier ?? ""}`);

    /* ── (C) PURCHASE CONSIGNMENT receives (PCR) — which, when, where ─────── */
    const pcrs = await sql`
      SELECT r.receive_number, r.status::text AS status, r.warehouse_id, r.received_at, s.name AS supplier
        FROM scm.purchase_consignment_receives r
        LEFT JOIN scm.suppliers s ON s.id = r.supplier_id
       WHERE r.company_id = ${companyId}
       ORDER BY r.received_at DESC NULLS LAST LIMIT 20`;
    notice(`  ---- (C) PURCHASE CONSIGNMENT receives (PCR, most recent ${pcrs.length}) — where stock LANDED ----`);
    for (const r of pcrs)
      notice(`      ${pad(r.receive_number, 20)} ${pad(r.status, 10)} ${pad(d10(r.received_at), 10)} -> ${pad(whLabel(r.warehouse_id), 14)} ${r.supplier ?? ""}`);

    /* ── (D) STOCK by warehouse, OWNED vs CONSIGNMENT ────────────────────── */
    const lots = await sql`
      SELECT warehouse_id, item_code, batch_no, source_doc_type,
             SUM(qty_remaining)::numeric AS qty
        FROM scm.inventory_lots
       WHERE company_id = ${companyId} AND qty_remaining > 0
       GROUP BY 1,2,3,4`;
    const byWh = new Map();
    for (const l of lots) {
      const consign = (l.source_doc_type ?? "").toUpperCase() === "PC_RECEIVE";
      const g = byWh.get(l.warehouse_id) ?? { owned: 0, consign: 0 };
      if (consign) g.consign += num(l.qty); else g.owned += num(l.qty);
      byWh.set(l.warehouse_id, g);
    }
    notice("  ---- (D) STOCK on hand by warehouse: OWNED vs CONSIGNMENT ----");
    notice(`  ${pad("warehouse", 16)} ${pad("kind", 10)} ${pad("OWNED", 8)} ${pad("CONSIGN", 8)}`);
    let ownedOutside = 0;
    const OWNED_OK = new Set(["KL WAREHOUSE", "C&C DISPLAY", "PJ SHOWROOM"]); // owner's expected owned locations
    for (const [wh, g] of [...byWh].sort((a, b) => (b[1].owned + b[1].consign) - (a[1].owned + a[1].consign))) {
      const label = whLabel(wh);
      notice(`  ${pad(label, 16)} ${pad(isShowroom(wh) ? "SHOWROOM" : "warehouse", 10)} ${pad(g.owned, 8)} ${pad(g.consign, 8)}`);
      if (g.owned > 0 && !OWNED_OK.has(label)) ownedOutside += g.owned;
    }
    notice(`  OWNED units sitting OUTSIDE {KL WAREHOUSE, C&C DISPLAY, PJ SHOWROOM} : ${ownedOutside}  <- these are the real relocate candidates`);
    // list the owned-outside lots explicitly
    if (ownedOutside > 0) {
      for (const l of lots) {
        const consign = (l.source_doc_type ?? "").toUpperCase() === "PC_RECEIVE";
        if (consign) continue;
        const label = whLabel(l.warehouse_id);
        if (OWNED_OK.has(label)) continue;
        notice(`      OWNED ${pad(l.item_code, 26)} ${pad(label, 14)} qty ${l.qty} <- ${l.batch_no ?? "(no batch)"} (${l.source_doc_type ?? "?"})`);
      }
    }
  }
  notice("");
  notice("  OWNED = bought (GRN); CONSIGNMENT = held-not-owned (PC Receive), excluded from stock value and");
  notice("  legitimately placed at branches/showrooms for display — never a relocate candidate.");
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("WAREHOUSE_PICTURE_FAIL", e?.message ?? e);
  process.exit(1);
});
