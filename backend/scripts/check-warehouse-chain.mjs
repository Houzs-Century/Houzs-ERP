// READ-ONLY. The owner's chain-integrity questions (2026-08-02): across the whole
// SO -> PO -> GR -> DO chain, is the WAREHOUSE consistent and correct at every
// step? Trigger: an ANGGN-FIRM MATT (K) stock lot sitting in PJ SHOWROOM (from
// GRN-2607-012 / PO-2607-005) while the ANGGN PO ships to KL WAREHOUSE.
//
// The receiving warehouse is the source PO LINE's bound warehouse (grns.ts:442,
// owner 2026-07-02 China/transit fix). So a lot in a showroom means the PO (and
// the SO it came from) already carried that showroom as its warehouse. This walks
// every link and reports where the warehouse diverges — and flags STOCK that
// landed in a SHOWROOM, which is a display location, not a stock warehouse.
//
//   Q1  PO assigned to an SO? PO line warehouse == its SO line's warehouse?
//   Q2  GR received-into warehouse == the PO line's warehouse? (+ showroom flag)
//   Q3  DO OUT-movement warehouse == the SO line's warehouse?
//
// SELECT only. No writes. Enum columns ::text before string ops.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const blank = (v) => v == null || String(v).trim() === "";

const STATE_ALIASES = {
  "wilayah persekutuan kuala lumpur": "kuala lumpur", "wp kuala lumpur": "kuala lumpur",
  kl: "kuala lumpur", penang: "pulau pinang", malacca: "melaka",
};
const canonState = (s) => { if (!s) return ""; const t = String(s).trim().toLowerCase().replace(/\s+/g, " "); return STATE_ALIASES[t] ?? t; };

async function main() {
  notice("=== WAREHOUSE CHAIN CONSISTENCY (SO -> PO -> GR -> DO) — READ-ONLY ===");
  const whs = await sql`SELECT id, code, name, is_showroom, type::text AS type FROM scm.warehouses`;
  const whById = new Map(whs.map((w) => [w.id, w]));
  const whByNameLc = new Map();
  for (const w of whs) { if (w.code) whByNameLc.set(w.code.trim().toLowerCase(), w.id); if (w.name) whByNameLc.set(w.name.trim().toLowerCase(), w.id); }
  const isShowroom = (id) => { const w = whById.get(id); return w && (w.is_showroom === true || (w.type ?? "").toLowerCase() === "showroom"); };
  const whLabel = (id) => (id ? (whById.get(id)?.code ?? whById.get(id)?.name ?? String(id)) : "NONE");
  const stateMaps = await sql`SELECT state, warehouse_id FROM scm.state_warehouse_mappings`;
  const whFromState = (s) => { const want = canonState(s); if (!want) return null; for (const m of stateMaps) if (m.warehouse_id && canonState(m.state) === want) return m.warehouse_id; return null; };
  const whFromLoc = (loc) => (blank(loc) ? null : whByNameLc.get(String(loc).trim().toLowerCase()) ?? null);
  notice(`warehouses: ${whs.length}  (showrooms: ${whs.filter((w) => w.is_showroom === true || (w.type ?? "").toLowerCase() === "showroom").map((w) => w.code).join(", ") || "none"})`);

  const companies = (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => r.company_id);
  for (const companyId of companies) {
    notice("");
    notice(`################ COMPANY ${companyId} ################`);

    // SO line warehouse resolver map (id -> resolved wh)
    const soItems = await sql`
      SELECT i.id, i.doc_no, i.item_code, i.warehouse_id, s.sales_location, s.customer_state
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${companyId}`;
    const soWh = new Map();
    for (const r of soItems) soWh.set(r.id, r.warehouse_id ?? whFromLoc(r.sales_location) ?? whFromState(r.customer_state) ?? null);

    /* ── Q1: PO assigned to SO + PO warehouse == SO warehouse ─────────────── */
    const poRows = await sql`
      SELECT pi.id AS po_item_id, pi.material_code, pi.warehouse_id AS po_line_wh, pi.so_item_id,
             po.po_number, po.status::text AS po_status, po.purchase_location_id
        FROM scm.purchase_order_items pi
        JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
       WHERE pi.company_id = ${companyId} AND UPPER(po.status::text) NOT IN ('CANCELLED','DRAFT')`;
    let poAssigned = 0, poStock = 0, poWhVsSoOk = 0, poWhVsSoMismatch = 0, poIntoShowroom = 0;
    const poMismatch = [], poShowroomRows = [];
    for (const r of poRows) {
      const poWh = r.po_line_wh ?? r.purchase_location_id ?? null;
      if (poWh && isShowroom(poWh)) { poIntoShowroom += 1; poShowroomRows.push(r); }
      if (!r.so_item_id) { poStock += 1; continue; }
      poAssigned += 1;
      const sWh = soWh.get(r.so_item_id) ?? null;
      if (sWh && poWh && sWh === poWh) poWhVsSoOk += 1;
      else if (sWh && poWh && sWh !== poWh) { poWhVsSoMismatch += 1; poMismatch.push({ po: r.po_number, code: r.material_code, poWh, sWh }); }
    }
    notice("  ---- Q1: PO -> SO assignment + PO warehouse vs SO warehouse ----");
    notice(`  open PO lines                         : ${poRows.length}  (assigned to an SO: ${poAssigned}, stock: ${poStock})`);
    notice(`  PO line warehouse == its SO's warehouse : ${poWhVsSoOk}`);
    notice(`  PO line warehouse != its SO's warehouse : ${poWhVsSoMismatch}`);
    for (const m of poMismatch.slice(0, 15)) notice(`      ${pad(m.po, 18)} ${pad(m.code, 24)} PO@${pad(whLabel(m.poWh), 12)} SO@${whLabel(m.sWh)}`);
    notice(`  PO lines whose warehouse is a SHOWROOM  : ${poIntoShowroom}  <- a showroom is a display point, stock should not be PURCHASED into it`);
    for (const r of poShowroomRows.slice(0, 15)) notice(`      ${pad(r.po_number, 18)} ${pad(r.material_code, 24)} -> ${whLabel(r.po_line_wh ?? r.purchase_location_id)}`);

    /* ── Q2: GR received-into warehouse == PO line warehouse ──────────────── */
    // Lots from a GRN; batch_no = source PO number. Compare lot warehouse to the
    // PO line's warehouse for that product.
    const lots = await sql`
      SELECT l.id, l.warehouse_id AS lot_wh, l.product_code, l.batch_no, l.qty_remaining,
             l.source_doc_type, g.grn_number, g.warehouse_id AS grn_wh
        FROM scm.inventory_lots l
        LEFT JOIN scm.grns g ON g.id = l.source_doc_id AND UPPER(COALESCE(l.source_doc_type,''))='GRN'
       WHERE l.company_id = ${companyId} AND UPPER(COALESCE(l.source_doc_type,'')) = 'GRN'`;
    // PO line warehouse by (po_number, product_code)
    const poWhByKey = new Map();
    for (const r of poRows) poWhByKey.set(`${r.po_number}|${r.material_code}`, r.po_line_wh ?? r.purchase_location_id ?? null);
    // also include received/closed POs (poRows is open-only) — pull all for batch match
    const allPoWh = await sql`
      SELECT po.po_number, pi.material_code, COALESCE(pi.warehouse_id, po.purchase_location_id) AS wh
        FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
       WHERE pi.company_id = ${companyId}`;
    for (const r of allPoWh) if (!poWhByKey.has(`${r.po_number}|${r.material_code}`)) poWhByKey.set(`${r.po_number}|${r.material_code}`, r.wh);
    let grOk = 0, grVsPoMismatch = 0, grIntoShowroom = 0, grNoPo = 0;
    const grMismatch = [], grShowroomRows = [];
    for (const l of lots) {
      if (isShowroom(l.lot_wh)) { grIntoShowroom += 1; grShowroomRows.push(l); }
      const poWh = l.batch_no ? poWhByKey.get(`${l.batch_no}|${l.product_code}`) : undefined;
      if (poWh === undefined || poWh === null) { grNoPo += 1; continue; }
      if (poWh === l.lot_wh) grOk += 1;
      else { grVsPoMismatch += 1; grMismatch.push({ grn: l.grn_number, code: l.product_code, batch: l.batch_no, lotWh: l.lot_wh, poWh, qty: l.qty_remaining }); }
    }
    notice("  ---- Q2: GR received-into warehouse vs the PO line's warehouse ----");
    notice(`  GRN lots total                        : ${lots.length}`);
    notice(`  lot warehouse == source PO line warehouse : ${grOk}`);
    notice(`  lot warehouse != source PO line warehouse : ${grVsPoMismatch}  <- goods received into a DIFFERENT warehouse than the PO bound`);
    for (const m of grMismatch.slice(0, 15)) notice(`      ${pad(m.grn ?? "?", 20)} ${pad(m.code, 24)} batch ${pad(m.batch, 18)} lot@${pad(whLabel(m.lotWh), 12)} PO@${whLabel(m.poWh)} (qty ${m.qty})`);
    notice(`  lots physically sitting in a SHOWROOM   : ${grIntoShowroom}  <- stock in a display location`);
    for (const l of grShowroomRows.slice(0, 15)) notice(`      ${pad(l.product_code, 24)} ${pad(whLabel(l.lot_wh), 12)} qty ${l.qty_remaining} <- ${l.grn_number ?? "?"} / batch ${l.batch_no ?? "-"}`);
    notice(`  GRN lots whose batch names no known PO line : ${grNoPo}  (pre-batch / migrated — can't compare)`);

    /* ── Q3: DO OUT-movement warehouse == SO line warehouse ───────────────── */
    const outs = await sql`
      SELECT m.warehouse_id AS out_wh, m.product_code, m.qty, di.so_item_id, d.do_number
        FROM scm.inventory_movements m
        JOIN scm.delivery_orders d ON d.id = m.source_doc_id
        LEFT JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id AND di.item_code = m.product_code
       WHERE m.company_id = ${companyId} AND m.movement_type='OUT' AND m.source_doc_type='DO'
         AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`;
    let doOk = 0, doMismatch = 0, doNoSo = 0, doFromShowroom = 0;
    const doMismRows = [];
    const seenOut = new Set();
    for (const o of outs) {
      const k = `${o.do_number}|${o.product_code}|${o.so_item_id ?? ""}`;
      if (seenOut.has(k)) continue; seenOut.add(k);
      if (isShowroom(o.out_wh)) doFromShowroom += 1;
      if (!o.so_item_id) { doNoSo += 1; continue; }
      const sWh = soWh.get(o.so_item_id) ?? null;
      if (sWh && o.out_wh && sWh === o.out_wh) doOk += 1;
      else if (sWh && o.out_wh && sWh !== o.out_wh) { doMismatch += 1; doMismRows.push({ do: o.do_number, code: o.product_code, outWh: o.out_wh, sWh }); }
    }
    notice("  ---- Q3: DO OUT-movement warehouse vs the SO line's warehouse ----");
    notice(`  DO OUT movements (deduped)            : ${seenOut.size}`);
    notice(`  OUT warehouse == SO warehouse          : ${doOk}`);
    notice(`  OUT warehouse != SO warehouse          : ${doMismatch}`);
    for (const m of doMismRows.slice(0, 15)) notice(`      ${pad(m.do, 20)} ${pad(m.code, 24)} OUT@${pad(whLabel(m.outWh), 12)} SO@${whLabel(m.sWh)}`);
    notice(`  OUT shipped FROM a showroom warehouse  : ${doFromShowroom}`);

    notice("  ---- CHAIN VERDICT ----");
    notice(`  Q1 PO->SO warehouse mismatches : ${poWhVsSoMismatch}   PO-into-showroom : ${poIntoShowroom}`);
    notice(`  Q2 GR->PO warehouse mismatches : ${grVsPoMismatch}   stock-in-showroom lots : ${grIntoShowroom}`);
    notice(`  Q3 DO->SO warehouse mismatches : ${doMismatch}`);
  }

  /* ── DIAGNOSIS: walk the chain for EVERY lot sitting in a showroom OR whose
        warehouse disagrees with its PO — both the 2990 ANGGN (showroom) and the
        Houzs AKEMI/TRION (C&C DISPLAY) cases the owner flagged. ─────────────── */
  notice("");
  notice("======== DIAGNOSIS: LOT <- GRN <- PO line <- SO line, for showroom / mismatched lots ========");
  const diag = await sql`
    SELECT l.company_id, l.product_code, l.warehouse_id AS lot_wh, l.batch_no, l.qty_remaining,
           g.grn_number, g.warehouse_id AS grn_wh, g.received_at
      FROM scm.inventory_lots l LEFT JOIN scm.grns g ON g.id = l.source_doc_id
     WHERE l.qty_remaining > 0 AND l.batch_no IS NOT NULL
       AND (l.warehouse_id IN (SELECT id FROM scm.warehouses WHERE is_showroom = true OR type = 'showroom')
            OR l.product_code ILIKE '%ANGGN%' OR l.product_code ILIKE '%AKEMI%' OR l.product_code ILIKE '%TRION%')
     ORDER BY l.company_id, l.product_code`;
  for (const d of diag) {
    notice(`  LOT   [co${d.company_id}] ${pad(d.product_code, 26)} in ${pad(whLabel(d.lot_wh), 12)} qty ${d.qty_remaining} <- ${d.grn_number ?? "?"} (GRN wh ${whLabel(d.grn_wh)}, recd ${d.received_at ? String(d.received_at).slice(0, 10) : "?"}) batch ${d.batch_no}`);
    const poLines = await sql`
      SELECT po.po_number, COALESCE(pi.warehouse_id, po.purchase_location_id) AS wh, pi.warehouse_id AS line_wh, po.purchase_location_id, pi.so_item_id
        FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
       WHERE po.po_number = ${d.batch_no} AND pi.material_code = ${d.product_code}`;
    for (const p of poLines) {
      notice(`  PO    ${pad(p.po_number, 20)} line wh=${pad(whLabel(p.line_wh), 12)} hdr ship-to=${pad(whLabel(p.purchase_location_id), 12)} so_item_id=${p.so_item_id ?? "(stock)"}`);
      if (p.so_item_id) {
        const [so] = await sql`
          SELECT i.doc_no, i.warehouse_id AS line_wh, s.sales_location, s.customer_state
            FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders s ON s.doc_no=i.doc_no AND s.company_id=i.company_id
           WHERE i.id = ${p.so_item_id}`;
        if (so) notice(`  SO    ${pad(so.doc_no, 20)} line wh=${pad(whLabel(so.line_wh), 12)} sales_location=${JSON.stringify(so.sales_location)} state=${JSON.stringify(so.customer_state)}`);
      }
    }
  }
  notice("  Reading: follow the warehouse UP the chain. If SO/PO already say the showroom, the wrong");
  notice("  warehouse was chosen at ORDER time. If SO/PO say KL but the LOT is elsewhere, the GR");
  notice("  received into the wrong warehouse (a pre-2026-07-02 GRN, before the receiving-warehouse fix).");

  notice("");
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("WAREHOUSE_CHAIN_FAIL", e?.message ?? e);
  process.exit(1);
});
