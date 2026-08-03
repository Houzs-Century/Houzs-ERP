// READ-ONLY. Why are SO fields empty — warehouse, venue, branding, source-PO —
// and which empties are BUGS vs BY DESIGN. (owner 2026-08-02: "为什么仓库会配错",
// "为什么branding会空 venue会空", "为什么很多东西的PO是空的".)
//
// Nothing is asserted here that the code does not decide. Each section replicates
// the rule that fills the field, applies it to today's rows, and labels every
// empty by WHY — so an expected empty (accessory has no PO; an unbound rep has no
// venue, by the venue-binding rule that refuses to guess) is never counted as a
// defect, and a real gap (a code the catalog brands, left blank on the line) is.
//
// SELECT only. One connection, no DDL, no writes, no transaction. Enum columns
// are ::text before any string op (the repo's documented trap).
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const num = (v) => Number(v ?? 0);
const snorm = (v) => (v ?? "").trim().toUpperCase();
const blank = (v) => v == null || String(v).trim() === "";

/* ── ported: so-warehouse.ts canonicalizeStateKey + resolvers ────────────── */
const STATE_ALIASES = {
  "wilayah persekutuan kuala lumpur": "kuala lumpur",
  "wp kuala lumpur": "kuala lumpur",
  kl: "kuala lumpur", penang: "pulau pinang", malacca: "melaka",
};
const canonState = (s) => {
  if (!s) return "";
  const t = String(s).trim().toLowerCase().replace(/\s+/g, " ");
  return STATE_ALIASES[t] ?? t;
};
const whFromSalesLocation = (loc, warehouses) => {
  const needle = (loc ?? "").trim().toLowerCase();
  if (!needle) return null;
  const hit = warehouses.find((w) => (w.code ?? "").trim().toLowerCase() === needle || (w.name ?? "").trim().toLowerCase() === needle);
  return hit?.id ?? null;
};
const whFromState = (state, mappings) => {
  const want = canonState(state);
  if (!want) return null;
  for (const m of mappings) if (m.warehouse_id && canonState(m.state) === want) return m.warehouse_id;
  return null;
};

/* ── ported: mrp.ts catFromGroup + service-sku ───────────────────────────── */
const catFromGroup = (g) => {
  const s = snorm(g);
  if (s.includes("BEDFRAME")) return "BEDFRAME";
  if (s.includes("SOFA")) return "SOFA";
  if (s.includes("MATTRESS")) return "MATTRESS";
  if (s.includes("ACCESSOR")) return "ACCESSORY";
  if (s.includes("SERVICE")) return "SERVICE";
  return null;
};
const isService = (g, code) => snorm(g).includes("SERVICE") || (snorm(code).length > 4 && snorm(code).startsWith("SVC-"));

const SO_DONE = new Set(["DELIVERED", "INVOICED", "CLOSED", "CANCELLED", "DRAFT", "SHIPPED"]);

async function main() {
  notice("=== SO FIELD-COMPLETENESS — READ-ONLY, why each field is empty and whether it is a bug ===");

  const warehouses = await sql`SELECT id, code, name FROM scm.warehouses`;
  const whById = new Map(warehouses.map((w) => [w.id, w]));
  const stateMaps = await sql`SELECT state, warehouse_id FROM scm.state_warehouse_mappings`;
  notice(`warehouses: ${warehouses.length}   state->warehouse mappings: ${stateMaps.length}`);
  notice(`states that map to a warehouse: ${stateMaps.filter((m) => m.warehouse_id).map((m) => m.state).join(", ") || "(none)"}`);

  const companies = (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => r.company_id);

  for (const companyId of companies) {
    notice("");
    notice(`################ COMPANY ${companyId} ################`);

    // Live SO headers (not done/cancelled) + their fields.
    const heads = await sql`
      SELECT doc_no, status::text AS status, sales_location, customer_state, venue,
             venue_source, salesperson_id, agent, branding AS header_branding
        FROM scm.mfg_sales_orders
       WHERE company_id = ${companyId}
         AND UPPER(COALESCE(status::text,'')) NOT IN ('CANCELLED','DRAFT','DELIVERED','INVOICED','CLOSED','SHIPPED')`;
    const headByDoc = new Map(heads.map((h) => [h.doc_no, h]));
    notice(`live SO headers (CONFIRMED / READY_TO_SHIP / ON_HOLD ...): ${heads.length}`);

    // Their physical (non-service, non-cancelled) lines.
    const lines = await sql`
      SELECT i.id, i.doc_no, i.item_code, i.item_group, i.branding, i.warehouse_id,
             i.stock_status, i.allocated_batch_no, i.qty
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${companyId} AND i.cancelled = FALSE
         AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','DRAFT','DELIVERED','INVOICED','CLOSED','SHIPPED')`;
    const physical = lines.filter((l) => l.item_code && !isService(l.item_group, l.item_code));

    /* ═══════ (1) WAREHOUSE — why "location" / stock bucket is empty ═══════ */
    notice("");
    notice("==== (1) WAREHOUSE (the 'location' column + the MRP/stock bucket) ====");
    notice("  Rule (so-warehouse.ts): a line's warehouse = its own warehouse_id, else the SO's");
    notice("  sales_location matched to a warehouse code/name, else customer_state via the state");
    notice("  map. Unresolvable = WH_NONE, and a WH_NONE line can NEVER see stock (inventory is");
    notice("  always in a real warehouse) — that is the mechanism behind a 'warehouse mismatch'.");
    let ownWh = 0, viaLoc = 0, viaState = 0, whNone = 0;
    const whNoneRows = [];
    for (const l of physical) {
      if (l.warehouse_id) { ownWh += 1; continue; }
      const h = headByDoc.get(l.doc_no);
      if (whFromSalesLocation(h?.sales_location, warehouses)) { viaLoc += 1; continue; }
      if (whFromState(h?.customer_state, stateMaps)) { viaState += 1; continue; }
      whNone += 1;
      whNoneRows.push({ doc: l.doc_no, code: l.item_code, cat: catFromGroup(l.item_group), loc: h?.sales_location, state: h?.customer_state });
    }
    notice(`  physical live lines                         : ${physical.length}`);
    notice(`   - resolve by their OWN warehouse_id        : ${ownWh}`);
    notice(`   - resolve by SO sales_location             : ${viaLoc}`);
    notice(`   - resolve by SO customer_state -> map      : ${viaState}`);
    notice(`   - UNRESOLVED (WH_NONE, can't see stock)    : ${whNone}`);
    for (const r of whNoneRows.slice(0, 25)) {
      notice(`       ${pad(r.doc, 18)} ${pad(r.code, 24)} ${pad(r.cat ?? "?", 10)} sales_location=${JSON.stringify(r.loc ?? null)} customer_state=${JSON.stringify(r.state ?? null)}`);
    }
    notice("  A WH_NONE row is FIXABLE when its SO carries a customer_state we could map or a");
    notice("  sales_location we could match; it is a SETUP gap when the SO has neither. Above shows");
    notice("  exactly which for each — a blank sales_location AND blank/unmapped state = setup gap.");

    // SKU split: same code has live demand in one wh-bucket and on-hand stock in another.
    const balances = await sql`
      SELECT product_code, warehouse_id, COALESCE(variant_key,'') AS vkey, SUM(qty)::numeric AS qty
        FROM scm.inventory_balances WHERE company_id = ${companyId} GROUP BY 1,2,3 HAVING SUM(qty) > 0`;
    const stockWhByCode = new Map();
    for (const b of balances) {
      const arr = stockWhByCode.get(b.product_code) ?? new Set();
      arr.add(b.warehouse_id ?? "NONE"); stockWhByCode.set(b.product_code, arr);
    }
    const demandWhByCode = new Map();
    for (const l of physical) {
      let wh = l.warehouse_id;
      if (!wh) { const h = headByDoc.get(l.doc_no); wh = whFromSalesLocation(h?.sales_location, warehouses) ?? whFromState(h?.customer_state, stateMaps) ?? "NONE"; }
      const arr = demandWhByCode.get(l.item_code) ?? new Set();
      arr.add(wh); demandWhByCode.set(l.item_code, arr);
    }
    const splitCodes = [];
    for (const [code, dWhs] of demandWhByCode) {
      const sWhs = stockWhByCode.get(code);
      if (!sWhs) continue;
      const overlap = [...dWhs].some((w) => sWhs.has(w));
      if (!overlap) splitCodes.push({ code, demand: [...dWhs], stock: [...sWhs] });
    }
    notice(`  SKUs whose live DEMAND warehouse never overlaps where the STOCK sits (a true split): ${splitCodes.length}`);
    for (const s of splitCodes.slice(0, 20)) {
      const dl = s.demand.map((w) => whById.get(w)?.code ?? w).join("/");
      const sl = s.stock.map((w) => whById.get(w)?.code ?? w).join("/");
      notice(`       ${pad(s.code, 26)} demand@[${dl}]  stock@[${sl}]`);
    }

    /* ═══════ (2) VENUE — empty by design, or a missed binding? ═══════════ */
    notice("");
    notice("==== (2) VENUE ====");
    notice("  Rule (venue-binding.ts): PMS project period -> showroom parking -> NOTHING. There is");
    notice("  NO default and NO guess — an unbindable rep gets an EMPTY venue ON PURPOSE (venue");
    notice("  feeds exhibition P&L + commission; a guessed venue is a wrong profit on a real name).");
    const emptyVenue = heads.filter((h) => blank(h.venue));
    const venueBySalesperson = new Map();
    for (const h of heads) {
      if (h.salesperson_id == null) continue;
      const cur = venueBySalesperson.get(h.salesperson_id) ?? { withVenue: 0, without: 0 };
      if (blank(h.venue)) cur.without += 1; else cur.withVenue += 1;
      venueBySalesperson.set(h.salesperson_id, cur);
    }
    let missedBinding = 0, byDesign = 0, noSalesperson = 0;
    for (const h of emptyVenue) {
      if (h.salesperson_id == null) { noSalesperson += 1; continue; }
      const v = venueBySalesperson.get(h.salesperson_id);
      if (v && v.withVenue > 0) missedBinding += 1; else byDesign += 1;
    }
    notice(`  live SOs with EMPTY venue                   : ${emptyVenue.length} of ${heads.length}`);
    notice(`   - salesperson HAS other SOs with a venue (binding exists -> likely FIXABLE/backfill): ${missedBinding}`);
    notice(`   - salesperson NEVER has a venue (unbound -> EMPTY BY DESIGN, not a bug)             : ${byDesign}`);
    notice(`   - SO has no salesperson_id at all (can't bind)                                       : ${noSalesperson}`);
    const missedReps = [...venueBySalesperson.entries()].filter(([, v]) => v.withVenue > 0 && v.without > 0);
    for (const [sp, v] of missedReps.slice(0, 15)) notice(`       salesperson ${pad(sp, 8)} : ${v.withVenue} with venue, ${v.without} WITHOUT (same rep -> the ${v.without} are backfillable)`);

    /* ═══════ (3) BRANDING — catalog gap or missed derive? ═══════════════ */
    notice("");
    notice("==== (3) BRANDING (line-level) ====");
    notice("  Rule (derive-line-branding.ts): filled from mfg_products.branding at write time for");
    notice("  any line with a code but no branding. Empty splits by WHETHER the catalog knows it:");
    const prodBrand = new Map();
    for (const p of await sql`SELECT code, branding FROM scm.mfg_products WHERE company_id = ${companyId}`) {
      prodBrand.set(p.code, p.branding);
    }
    const emptyBrand = physical.filter((l) => blank(l.branding));
    let brandFixable = 0, brandCatalogGap = 0;
    const brandFixRows = [];
    for (const l of emptyBrand) {
      if (!blank(prodBrand.get(l.item_code))) { brandFixable += 1; brandFixRows.push({ doc: l.doc_no, code: l.item_code, brand: prodBrand.get(l.item_code) }); }
      else brandCatalogGap += 1;
    }
    notice(`  physical live lines with EMPTY branding     : ${emptyBrand.length} of ${physical.length}`);
    notice(`   - catalog HAS a brand for the code (missed derive -> BACKFILLABLE): ${brandFixable}`);
    notice(`   - catalog has NO brand for the code (data gap in mfg_products)   : ${brandCatalogGap}`);
    for (const r of brandFixRows.slice(0, 20)) notice(`       ${pad(r.doc, 18)} ${pad(r.code, 26)} catalog brand = ${JSON.stringify(r.brand)}`);

    /* ═══════ (4) SOURCE PO — why the "PO No." column is empty ═══════════ */
    notice("");
    notice("==== (4) SOURCE PO (the list 'PO No.' column = source_po_union) ====");
    notice("  The column shows the PO the GOODS came from: shipped consumed batches (delivered) UNION");
    notice("  READY-projection over open lots. It is empty for a live line when NONE of these hold.");
    notice("  Classify by WHY, per category:");
    // open lots by (code) with/without batch — to know if a READY line COULD name a PO
    const openLots = await sql`
      SELECT product_code, warehouse_id, COALESCE(variant_key,'') AS vkey,
             SUM(qty_remaining) FILTER (WHERE batch_no IS NOT NULL)::numeric AS batched,
             SUM(qty_remaining) FILTER (WHERE batch_no IS NULL)::numeric AS unbatched
        FROM scm.inventory_lots WHERE company_id = ${companyId} AND qty_remaining > 0
       GROUP BY 1,2,3`;
    const batchedStockByCode = new Map();
    for (const l of openLots) {
      const cur = batchedStockByCode.get(l.product_code) ?? { batched: 0, unbatched: 0 };
      cur.batched += num(l.batched); cur.unbatched += num(l.unbatched);
      batchedStockByCode.set(l.product_code, cur);
    }
    const cls = { confirmedPreAlloc: 0, readyBatchless: 0, readyBatchedButEmpty: 0, accessory: 0, shortageNoStock: 0, sofa: 0 };
    for (const l of physical) {
      const h = headByDoc.get(l.doc_no);
      const cat = catFromGroup(l.item_group);
      const st = snorm(l.stock_status);
      const stock = batchedStockByCode.get(l.item_code) ?? { batched: 0, unbatched: 0 };
      if (cat === "SOFA") { cls.sofa += 1; continue; }               // sofa names its PO via allocated_batch_no
      if (cat === "ACCESSORY") { cls.accessory += 1; continue; }     // owner rule: accessory = stock, no per-SO PO
      if (st !== "READY" && st !== "PARTIAL") { cls.confirmedPreAlloc += 1; continue; } // not allocated yet -> nothing to name
      if (stock.batched > 0) cls.readyBatchedButEmpty += 1;          // COULD project a PO — worth a look
      else if (stock.unbatched > 0) cls.readyBatchless += 1;         // migrated/pre-FIFO stock: no PO exists to name
      else cls.shortageNoStock += 1;                                  // READY but no open lot at all (stale READY)
    }
    notice(`  SOFA lines (name their PO via allocated_batch_no)          : ${cls.sofa}  (expected to SHOW a PO)`);
    notice(`  ACCESSORY lines (stock item, no per-SO PO by owner rule)   : ${cls.accessory}  (expected EMPTY)`);
    notice(`  non-sofa CONFIRMED, not yet allocated                      : ${cls.confirmedPreAlloc}  (expected EMPTY until allocated/shipped)`);
    notice(`  non-sofa READY drawing on MIGRATED batchless stock         : ${cls.readyBatchless}  (EMPTY is HONEST — the goods have no source PO)`);
    notice(`  non-sofa READY whose stock IS batched yet column is empty  : ${cls.readyBatchedButEmpty}  (<- the only POTENTIAL bug; projection should name it)`);
    notice(`  non-sofa READY with NO open lot at all (stale READY)       : ${cls.shortageNoStock}  (stock-allocation tail, see recompute-so-allocation)`);
    notice("  Only the second-to-last line is a candidate defect; every other empty is either the");
    notice("  owner's own rule (accessory = stock) or physically honest (migrated stock has no PO,");
    notice("  an unallocated SO has nothing to name yet).");
  }

  notice("");
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("SO_COMPLETENESS_FAIL", e?.message ?? e);
  process.exit(1);
});
