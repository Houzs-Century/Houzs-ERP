// READ-ONLY. The MRP demand/supply formula and the SO<->PO pairing it produces.
//
// The owner's questions, in his words (2026-07-31):
//   (3) "对于 SO 和 DO 已经根据库存拿到现货的情况，需要确认它们具体拿的是哪张 PO 和
//        GR 的货。如果货物目前还没到，我通过 MRP 系统跑出来的'软匹配'关系具体是怎样的？"
//   (4) 需求量 = 现有库存 + 尚未开 DO 的 SO 需求 - PO Outstanding，and
//       "是否做到了'每一个人（订单行）都有正确的配对对象'？"
//   (5) every physical category (accessories / mattress / bedframe / sofa) must
//       trace to its soft-matched PO, in BOTH directions.
//   plus: "当开了 DO 就变成硬匹配了".
//
// ⚠ THIS SCRIPT REPLICATES computeMrp — IT DOES NOT CALL IT. The engine lives in
// a Cloudflare Worker behind PostgREST; a CI node process cannot invoke it. So
// the allocation below is a hand-port of backend/src/scm/routes/mrp.ts sections
// 1-8, and every rule is annotated with the line it ports. A replica can DRIFT
// from its original, which is why nothing here is reported as "MRP says X" —
// what it reports is "the rules as written in mrp.ts, applied to today's rows".
// If a figure here disagrees with the MRP page, the replica is the first suspect
// and the diff between this file and mrp.ts is where to look.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
//
// ENUM TRAP (inherited from check-hard-committed-po.mjs): status columns are
// ENUMS. COALESCE(col,'') coerces '' INTO the enum and throws. Always ::text
// first.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });

const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const num = (v) => Number(v ?? 0);

/* ── ported: scm/shared/variant-key.ts computeVariantKey ─────────────────── */
const ATTRS_BY_GROUP = {
  sofa: ["fabricCode", "seatHeight", "legHeight"],
  bedframe: ["fabricCode", "gap", "divanHeight", "legHeight", "totalHeight"],
  mattress: [], accessory: [], others: [], service: [],
};
const vnorm = (v) => (v == null ? "" : String(v).trim().toLowerCase());
const normSpecials = (specials) => {
  if (!Array.isArray(specials) || specials.length === 0) return "";
  return specials
    .map((s) => (typeof s === "string" ? s : (s?.code ?? s?.label ?? "")))
    .map(vnorm).filter(Boolean).sort().join(",");
};
function computeVariantKey(itemGroup, attrs) {
  const group = vnorm(itemGroup);
  const a = attrs ?? {};
  const parts = [];
  for (const k of ATTRS_BY_GROUP[group] ?? []) {
    const raw = k === "fabricCode"
      ? (a.fabricCode ?? a.colorCode ?? a.colourCode ?? a.fabricColor)
      : k === "seatHeight" ? (a.seatHeight ?? a.depth)
      : k === "legHeight" ? (a.legHeight ?? a.sofaLegHeight)
      : a[k];
    const val = vnorm(raw);
    if (val) parts.push(`${k.toLowerCase()}=${val}`);
  }
  const sp = normSpecials(a.specials);
  if (sp) parts.push(`special=${sp}`);
  return parts.join("|");
}

/* ── ported: scm/shared/service-sku.ts isServiceLine ─────────────────────── */
const snorm = (v) => (v ?? "").trim().toUpperCase();
const isServiceLine = ({ itemGroup, itemCode, category }) =>
  snorm(itemGroup).includes("SERVICE")
  || snorm(category) === "SERVICE"
  || (snorm(itemCode).length > 4 && snorm(itemCode).startsWith("SVC-"));

/* ── ported: mrp.ts catFromGroup (L820-828) ──────────────────────────────── */
const catFromGroup = (g) => {
  const s = snorm(g);
  if (s.includes("BEDFRAME")) return "BEDFRAME";
  if (s.includes("SOFA")) return "SOFA";
  if (s.includes("MATTRESS")) return "MATTRESS";
  if (s.includes("ACCESSOR")) return "ACCESSORY";
  if (s.includes("SERVICE")) return "SERVICE";
  return null;
};

/* ── ported: mrp.ts L94-99 ───────────────────────────────────────────────── */
const SO_DONE = new Set(["DELIVERED", "INVOICED", "CLOSED", "CANCELLED", "DRAFT"]);
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);

/* ── ported: mrp.ts L171-173 ─────────────────────────────────────────────── */
const WH_NONE = "NOWH";
const composite = (wh, code, vkey) => `${wh ?? WH_NONE}|${code}|${vkey}`;

/* ── ported: mrp.ts byDateAsc (L403-408) ─────────────────────────────────── */
const byDateAsc = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : (a < b ? -1 : 1));

/* ── ported: shared/effective-delivery.ts ────────────────────────────────── */
const effectiveDelivery = (...ds) => {
  let best = null;
  for (const d of ds) { if (!d) continue; if (best === null || d > best) best = d; }
  return best;
};

/* ── ported: scm/lib/so-warehouse.ts ─────────────────────────────────────── */
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
function resolveSoWarehouseId(so, warehouses, mappings) {
  if (!so) return null;
  const needle = (so.sales_location ?? "").trim().toLowerCase();
  if (needle) {
    const hit = warehouses.find((w) =>
      (w.code ?? "").trim().toLowerCase() === needle || (w.name ?? "").trim().toLowerCase() === needle);
    if (hit) return hit.id;
  }
  const want = canonState(so.customer_state);
  if (want) for (const m of mappings) if (m.warehouse_id && canonState(m.state) === want) return m.warehouse_id;
  return null;
}

const d2 = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : (x ?? null));

async function main() {
  notice("=== MRP ALLOCATION / SOFT-MATCH AUDIT — READ-ONLY, NOTHING WRITTEN ===");
  notice("Replica of backend/src/scm/routes/mrp.ts computeMrp. See header caveat.");

  const companies = (await sql`
    SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`)
    .map((r) => r.company_id);
  notice(`companies with Sales Orders: ${JSON.stringify(companies)}`);

  const warehouses = await sql`SELECT id, code, name, company_id FROM scm.warehouses`;
  const stateMaps = await sql`SELECT state, warehouse_id, company_id FROM scm.state_warehouse_mappings`;
  const whById = new Map(warehouses.map((w) => [w.id, w]));

  for (const companyId of companies) {
    notice("");
    notice(`################ COMPANY ${companyId} ################`);
    await auditCompany(companyId, warehouses, stateMaps, whById);
  }

  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

async function auditCompany(companyId, allWarehouses, allStateMaps, whById) {
  const warehouses = allWarehouses.filter((w) => w.company_id == null || w.company_id === companyId);
  const stateMaps = allStateMaps.filter((m) => m.company_id == null || m.company_id === companyId);

  /* ── 1. DEMAND — mrp.ts §1 (L545-576) ─────────────────────────────────── */
  const demandRaw = await sql`
    SELECT i.id, i.doc_no, i.item_code, i.item_group, i.variants, i.qty,
           i.warehouse_id, i.line_delivery_date, i.line_no, i.stock_status,
           s.status::text AS so_status, s.customer_delivery_date,
           s.customer_state, s.sales_location
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${companyId} AND i.cancelled = FALSE`;

  /* deliverable remaining — mrp.ts L568-576 via soDeliverableRemaining
     (delivery-orders-mfg.ts L1896-1905): qty - (delivered on DOs that are
     neither CANCELLED nor DRAFT) + (returned on non-cancelled DRs).
     NOTE the DRAFT exclusion: so-stock-allocation.ts's own inline copy of this
     sum omits it, which is measured under (A) as an engine divergence. */
  const delivered = await sql`
    SELECT di.so_item_id, SUM(di.qty)::numeric AS delivered
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
       AND UPPER(COALESCE(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY di.so_item_id`;
  const deliveredInclDraft = await sql`
    SELECT di.so_item_id, SUM(di.qty)::numeric AS delivered
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     GROUP BY di.so_item_id`;
  const returned = await sql`
    SELECT di.so_item_id, SUM(ri.qty_returned)::numeric AS returned
      FROM scm.delivery_return_items ri
      JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id
      JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
     WHERE di.so_item_id IS NOT NULL
       AND UPPER(COALESCE(r.status::text,'')) <> 'CANCELLED'
     GROUP BY di.so_item_id`;
  const delMap = new Map(delivered.map((r) => [r.so_item_id, num(r.delivered)]));
  const delMapDraft = new Map(deliveredInclDraft.map((r) => [r.so_item_id, num(r.delivered)]));
  const retMap = new Map(returned.map((r) => [r.so_item_id, num(r.returned)]));
  let draftDoDivergence = 0;
  for (const [id, q] of delMapDraft) if (q !== (delMap.get(id) ?? 0)) draftDoDivergence += 1;
  const effQtyOf = (r) =>
    Math.max(0, num(r.qty) - Math.max(0, (delMap.get(r.id) ?? 0) - (retMap.get(r.id) ?? 0)));

  /* Product master — category (mrp.ts §2). NOT company-scoped on `code` here on
     purpose: the same read in so-stock-allocation.ts is a union across
     companies, and a category disagreement is itself worth reporting. */
  const prods = await sql`SELECT code, name, category::text AS category, company_id FROM scm.mfg_products`;
  const prodByCode = new Map();
  const catConflicts = [];
  for (const p of prods) {
    const seen = prodByCode.get(p.code);
    if (seen && (seen.category ?? "") !== (p.category ?? "")) catConflicts.push(`${p.code}(${seen.category}/${p.category})`);
    if (!seen || p.company_id === companyId) prodByCode.set(p.code, p);
  }

  /* mrp.ts includeUndated=false on the page; the po-so-coverage callers pass
     TRUE. Audit the page's default and report the undated set separately. */
  const activeAll = demandRaw.filter((r) => r.item_code && !SO_DONE.has(snorm(r.so_status)) && num(r.qty) > 0);
  const undated = activeAll.filter((r) => !(r.line_delivery_date ?? r.customer_delivery_date));
  const demandActive = activeAll.filter((r) => Boolean(r.line_delivery_date ?? r.customer_delivery_date));
  const demand = demandActive.filter((r) => effQtyOf(r) > 0);

  /* warehouse follows the SO — mrp.ts L632-662 */
  let whFromLine = 0, whFromSo = 0, whUnresolved = 0;
  for (const d of demand) {
    if (d.warehouse_id) { whFromLine += 1; continue; }
    const resolved = resolveSoWarehouseId(d, warehouses, stateMaps);
    d.warehouse_id = resolved;
    if (resolved) whFromSo += 1; else whUnresolved += 1;
  }

  /* ── 3. STOCK ─────────────────────────────────────────────────────────── */
  const balances = await sql`
    SELECT product_code, warehouse_id, variant_key, qty
      FROM scm.inventory_balances WHERE company_id = ${companyId}`;
  const stockByKey = new Map();
  for (const b of balances) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + num(b.qty));
  }

  /* ── 4. PO SUPPLY — mrp.ts §4 (L677-730) ──────────────────────────────── */
  const poRaw = await sql`
    SELECT pi.id AS po_item_id, pi.material_code, pi.item_group, pi.variants,
           pi.qty, pi.received_qty, pi.delivery_date,
           pi.supplier_delivery_date_2, pi.supplier_delivery_date_3, pi.supplier_delivery_date_4,
           pi.warehouse_id, pi.so_item_id,
           po.id AS po_id, po.po_number, po.status::text AS po_status, po.expected_at,
           po.supplier_delivery_date_2 AS h2, po.supplier_delivery_date_3 AS h3,
           po.supplier_delivery_date_4 AS h4,
           po.purchase_location_id, po.supplier_id, po.notes
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE pi.company_id = ${companyId}`;

  const poOpen = [];
  let poOverReceived = 0, poDead = 0, poFullyReceived = 0;
  const poDrafts = [];
  for (const r of poRaw) {
    if (PO_DEAD.has(snorm(r.po_status))) { poDead += 1; continue; }
    const left = num(r.qty) - num(r.received_qty);
    if (num(r.received_qty) > num(r.qty)) poOverReceived += 1;
    if (left <= 0) { poFullyReceived += 1; continue; }
    const eta = effectiveDelivery(d2(r.delivery_date), d2(r.supplier_delivery_date_2), d2(r.supplier_delivery_date_3), d2(r.supplier_delivery_date_4))
      ?? effectiveDelivery(d2(r.expected_at), d2(r.h2), d2(r.h3), d2(r.h4))
      ?? null;
    const poWh = r.warehouse_id ?? r.purchase_location_id ?? null;
    const bucketKey = composite(poWh, r.material_code, computeVariantKey(r.item_group, r.variants));
    const entry = { ...r, left, eta, poWh, bucketKey };
    poOpen.push(entry);
    poDrafts.push({ bucketKey, poNumber: r.po_number, eta, qtyLeft: left, supplierId: r.supplier_id, poItemId: r.po_item_id });
  }

  /* ── 4b. COMMITTED SHIPMENTS — mrp.ts loadCommittedShipments + ship-commitment.ts */
  const openPoNumbers = [...new Set(poDrafts.map((d) => d.poNumber).filter(Boolean))];
  const committed = new Map();
  if (openPoNumbers.length > 0) {
    const movs = await sql`
      SELECT m.id, m.warehouse_id, m.product_code, m.variant_key, m.batch_no, m.qty, m.source_doc_id,
             UPPER(COALESCE(d.status::text,'')) AS do_status, d.is_dropship,
             COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                        WHERE c.movement_id = m.id), 0)::numeric AS consumed,
             EXISTS (SELECT 1 FROM scm.delivery_order_items di
                      WHERE di.delivery_order_id = d.id
                        AND di.committed_po_batch_no = m.batch_no
                        AND di.item_code = m.product_code
                        AND COALESCE(di.committed_variant_key,'') = COALESCE(m.variant_key,'')) AS line_committed
        FROM scm.inventory_movements m
        LEFT JOIN scm.delivery_orders d ON d.id = m.source_doc_id
       WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
         AND m.batch_no IN ${sql(openPoNumbers)}`;
    for (const m of movs) {
      if (!m.batch_no || !m.source_doc_id) continue;
      if (m.do_status === "CANCELLED" || m.do_status === "") continue;
      if (m.is_dropship !== true && m.line_committed !== true) continue;
      const short = Math.max(0, Math.abs(num(m.qty)) - num(m.consumed));
      if (short <= 0) continue;
      const k = `${composite(m.warehouse_id ?? null, m.product_code, m.variant_key ?? "")}|${m.batch_no}`;
      const cur = committed.get(k);
      if (cur) cur.qty += short;
      else committed.set(k, { qty: short, batchNo: m.batch_no, itemCode: m.product_code });
    }
  }
  /* applyCommittedSupply — ship-commitment.ts L345-372 */
  const supplyEntries = [];
  const stockAddBack = new Map();
  const pool = new Map([...committed].map(([k, v]) => [k, { ...v }]));
  for (const e of poDrafts) {
    const k = `${e.bucketKey}|${e.poNumber}`;
    const owed = pool.get(k);
    if (!owed || owed.qty <= 0) { if (e.qtyLeft > 0) supplyEntries.push(e); continue; }
    const take = Math.min(owed.qty, e.qtyLeft);
    owed.qty -= take;
    if (take > 0) stockAddBack.set(e.bucketKey, (stockAddBack.get(e.bucketKey) ?? 0) + take);
    const left = e.qtyLeft - take;
    if (left > 0) supplyEntries.push({ ...e, qtyLeft: left });
  }
  const unmatchedCommitments = [...pool.values()].filter((u) => u.qty > 0);
  for (const [k, add] of stockAddBack) stockByKey.set(k, (stockByKey.get(k) ?? 0) + add);

  const poByKey = new Map();
  const poOutstandingByKey = new Map();
  for (const e of supplyEntries) {
    const arr = poByKey.get(e.bucketKey) ?? [];
    arr.push({ poNumber: e.poNumber, eta: e.eta, qtyLeft: e.qtyLeft, poItemId: e.poItemId });
    poByKey.set(e.bucketKey, arr);
    poOutstandingByKey.set(e.bucketKey, (poOutstandingByKey.get(e.bucketKey) ?? 0) + e.qtyLeft);
  }
  for (const arr of poByKey.values()) arr.sort((a, b) => byDateAsc(a.eta, b.eta));

  /* ── 6/8. BUCKET the demand — mrp.ts §6 (L829-848) and §8 (L992-1006) ─── */
  const catOf = (d) => prodByCode.get(d.item_code)?.category ?? catFromGroup(d.item_group);
  const generalBuckets = new Map();
  const sofaBuckets = new Map();
  let serviceSkipped = 0;
  for (const d of demand) {
    const cat = catOf(d);
    if (isServiceLine({ itemGroup: d.item_group, itemCode: d.item_code, category: cat })) { serviceSkipped += 1; continue; }
    const vkey = computeVariantKey(d.item_group, d.variants);
    const k = composite(d.warehouse_id ?? null, d.item_code, vkey);
    if (cat === "SOFA") {
      const b = sofaBuckets.get(k) ?? { whId: d.warehouse_id ?? null, code: d.item_code, vkey, rows: [] };
      b.rows.push(d); sofaBuckets.set(k, b);
    } else {
      const b = generalBuckets.get(k) ?? { whId: d.warehouse_id ?? null, code: d.item_code, vkey, rows: [] };
      b.rows.push(d); generalBuckets.set(k, b);
    }
  }

  const sortRows = (rows) => rows.sort((a, b) => {
    const bd = byDateAsc(d2(a.line_delivery_date) ?? d2(a.customer_delivery_date), d2(b.line_delivery_date) ?? d2(b.customer_delivery_date));
    return bd !== 0 ? bd : (a.doc_no ?? "").localeCompare(b.doc_no ?? "");
  });

  /* ── 7. GREEDY ALLOCATION — mrp.ts §7 (L856-967) ──────────────────────── */
  const results = [];                       // one per demand line
  const poConsumedBy = new Map();           // poNumber -> [{soItemId, qty, bucketKey}]
  const legacyShared = [];                  // double-allocation evidence
  const legacyUseByWhCode = new Map();      // `${wh}|${code}` -> [vkeys using the legacy pool]

  const allocate = (bucketMap, isSofa) => {
    for (const [k, bucket] of bucketMap) {
      const { whId, code, vkey } = bucket;
      const rows = sortRows(bucket.rows);
      let stockLeft = stockByKey.get(k) ?? 0;
      const ownPo = poByKey.get(k) ?? [];
      let poQueue;
      if (isSofa) {
        poQueue = ownPo.map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));
      } else {
        /* mrp.ts L884-890 — the legacy '' fallback pool. */
        const legacyKey = composite(whId, code, "");
        const useLegacy = vkey !== "" && legacyKey !== k && ownPo.length === 0;
        if (useLegacy && (poByKey.get(legacyKey) ?? []).length > 0) {
          const gk = `${whId ?? WH_NONE}|${code}`;
          const arr = legacyUseByWhCode.get(gk) ?? [];
          arr.push(vkey); legacyUseByWhCode.set(gk, arr);
        }
        poQueue = [...ownPo, ...(useLegacy ? (poByKey.get(legacyKey) ?? []) : [])]
          .map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));
      }
      for (const r of rows) {
        const eff = effQtyOf(r);
        let need = eff;
        const fromStock = Math.min(stockLeft, need);
        stockLeft -= fromStock; need -= fromStock;
        let poNumber = null, poEta = null;
        const takenFrom = [];
        while (need > 0 && poQueue.length > 0) {
          const front = poQueue[0];
          if (!front) break;
          const take = Math.min(front.qtyLeft, need);
          if (poNumber == null) { poNumber = front.poNumber; poEta = front.eta; }
          takenFrom.push({ poNumber: front.poNumber, qty: take });
          front.qtyLeft -= take; need -= take;
          if (front.qtyLeft <= 0) poQueue.shift();
        }
        const source = need > 0 ? "shortage" : poNumber != null ? "po" : "stock";
        for (const t of takenFrom) {
          const arr = poConsumedBy.get(t.poNumber) ?? [];
          arr.push({ soItemId: r.id, soDocNo: r.doc_no, qty: t.qty, bucketKey: k });
          poConsumedBy.set(t.poNumber, arr);
        }
        results.push({
          row: r, cat: catOf(r), isSofa, bucketKey: k,
          eff, fromStock, source, poNumber, poEta, shortage: need,
          coveringPos: takenFrom.length,
        });
      }
    }
  };
  allocate(generalBuckets, false);
  allocate(sofaBuckets, true);

  for (const [gk, vkeys] of legacyUseByWhCode) {
    if (new Set(vkeys).size > 1) legacyShared.push({ gk, vkeys: [...new Set(vkeys)] });
  }

  /* ═══════════════ (A) THE FORMULA, AS IMPLEMENTED ═══════════════════════ */
  notice("");
  notice("======== (A) THE FORMULA — what computeMrp actually computes ========");
  const totalDemand = results.reduce((a, r) => a + r.eff, 0);
  const totalStockUsed = results.reduce((a, r) => a + r.fromStock, 0);
  const totalShortage = results.reduce((a, r) => a + r.shortage, 0);
  const totalPoOutstanding = [...poOutstandingByKey.values()].reduce((a, v) => a + v, 0);
  const totalOnHandAll = [...stockByKey.values()].reduce((a, v) => a + v, 0);
  notice(`  SO lines loaded (non-cancelled, live SO)   : ${activeAll.length}`);
  notice(`   - dropped as UNDATED (page default)       : ${undated.length}   (?includeUndated=true brings them back)`);
  notice("     ⚠ the MRP PAGE passes includeUndated=false; the SO drill-down, the PO 'Assigned SO'");
  notice("       column and both agents pass TRUE. So the same allocation is computed over two");
  notice("       different demand sets and the two screens can legitimately disagree by this many lines.");
  notice(`   - dropped: already fully delivered        : ${demandActive.length - demand.length}`);
  notice(`   - dropped as SERVICE (never MRP demand)   : ${serviceSkipped}`);
  notice(`   = PHYSICAL demand lines allocated         : ${results.length}`);
  notice(`  demand units still to fulfil               : ${totalDemand}`);
  notice(`  of which filled from ON-HAND               : ${totalStockUsed}`);
  notice(`  of which filled from OPEN PO (soft match)  : ${totalDemand - totalStockUsed - totalShortage}`);
  notice(`  SHORTAGE units (no counterpart at all)     : ${totalShortage}`);
  notice(`  PO Outstanding pool (qty - received_qty)   : ${totalPoOutstanding}`);
  notice(`  on-hand across every bucket                : ${totalOnHandAll}`);
  notice("  ---- formula conformance ----");
  notice(`  PO lines on dead POs (CANCELLED/DRAFT) excluded from supply : ${poDead}`);
  notice(`  PO lines fully received (left <= 0) excluded from supply    : ${poFullyReceived}`);
  notice(`  PO lines with received_qty > qty (OVER-receipt)             : ${poOverReceived}  ` +
         `${poOverReceived ? "-- these contribute NEGATIVE outstanding? no: mrp.ts L722 drops left<=0, so the over-receipt is simply invisible" : ""}`);
  const partial = poOpen.filter((r) => num(r.received_qty) > 0).length;
  notice(`  PARTIALLY received open PO lines            : ${partial}  (supply counted = qty - received_qty, NOT full qty)`);
  notice(`  committed ship-before-arrival deductions    : ${committed.size} (bucket,batch) pairs`);
  notice(`  ... of which UNMATCHED (no open PO left)    : ${unmatchedCommitments.length}`);
  for (const u of unmatchedCommitments.slice(0, 15)) notice(`      ${pad(u.itemCode, 24)} ${pad(u.batchNo, 20)} qty ${u.qty}`);
  notice("  ---- THE .limit(5000) CEILING (mrp.ts L552 demand, L688 PO supply) ----");
  notice("  Neither read filters status in SQL and neither carries an ORDER BY, so the cap lands");
  notice("  on EVERY non-cancelled SO line and EVERY PO line ever written, in an unspecified");
  notice("  order. Crossing it truncates silently — no error, just a wrong plan.");
  const [{ so_rows, po_rows }] = await sql`
    SELECT (SELECT COUNT(*)::int FROM scm.mfg_sales_order_items
             WHERE company_id = ${companyId} AND cancelled = FALSE) AS so_rows,
           (SELECT COUNT(*)::int FROM scm.purchase_order_items
             WHERE company_id = ${companyId}) AS po_rows`;
  const verdict = (n) => (n > 5000 ? `TRUNCATED — ${n - 5000} rows are invisible to MRP` : `${5000 - n} rows of headroom`);
  notice(`  non-cancelled mfg_sales_order_items rows   : ${so_rows}   ${verdict(so_rows)}`);
  notice(`  purchase_order_items rows (all statuses)   : ${po_rows}   ${verdict(po_rows)}`);
  notice("  ---- SO header statuses that still create demand ----");
  const byStatus = new Map();
  for (const r of activeAll) {
    const s = snorm(r.so_status);
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) notice(`    ${pad(s, 20)} ${n} live line(s)`);
  const shippedDemanding = demand.filter((r) => snorm(r.so_status) === "SHIPPED").length;
  const onHoldDemanding = demand.filter((r) => snorm(r.so_status) === "ON_HOLD").length;
  notice(`  SHIPPED-status lines still demanding : ${shippedDemanding}  -- MRP's SO_DONE (L94) omits SHIPPED,`);
  notice("                                          so-stock-allocation.ts L112 EXCLUDES it: the two engines disagree.");
  notice(`  ON_HOLD-status lines still demanding : ${onHoldDemanding}  -- a held order still drives purchasing (owner call)`);
  notice(`  SO lines whose delivered sum changes if DRAFT DOs count : ${draftDoDivergence}`);
  notice("     (MRP excludes DRAFT DOs from delivered; so-stock-allocation.ts L232-237 does not.)");
  notice("  ---- warehouse binding (the 'warehouse follows the SO' change) ----");
  notice(`  demand lines with their OWN warehouse_id   : ${whFromLine}`);
  notice(`  demand lines inheriting the SO's warehouse : ${whFromSo}`);
  notice(`  demand lines STILL unresolved (WH_NONE)    : ${whUnresolved}  ` +
         `${whUnresolved ? "-- these can never see stock: inventory always carries a warehouse" : ""}`);
  if (catConflicts.length) notice(`  ⚠ mfg_products category disagrees across companies for: ${catConflicts.slice(0, 10).join(", ")}`);

  /* ═══════════════ (B) SO -> PO PAIRING, PER CATEGORY ════════════════════ */
  notice("");
  notice("======== (B) FORWARD PAIRING: does every physical SO line have a counterpart? ========");
  const CATS = ["ACCESSORY", "MATTRESS", "BEDFRAME", "SOFA", "(uncategorised)"];
  const catKey = (c) => (CATS.includes(c) ? c : "(uncategorised)");
  const fwd = new Map(CATS.map((c) => [c, { lines: 0, units: 0, stock: 0, po: 0, short: 0, partSplit: 0, shortUnits: 0 }]));
  for (const r of results) {
    const b = fwd.get(catKey(r.cat));
    b.lines += 1; b.units += r.eff; b.stock += r.fromStock;
    b.po += (r.eff - r.fromStock - r.shortage);
    b.shortUnits += r.shortage;
    if (r.source === "shortage") b.short += 1;
    if (r.coveringPos > 1) b.partSplit += 1;
  }
  notice(`  ${pad("category", 16)} ${pad("lines", 7)} ${pad("units", 8)} ${pad("<-stock", 9)} ${pad("<-PO", 8)} ${pad("shortLn", 8)} ${pad("shortUn", 8)} split>1PO`);
  for (const c of CATS) {
    const b = fwd.get(c);
    if (!b.lines) continue;
    notice(`  ${pad(c, 16)} ${pad(b.lines, 7)} ${pad(b.units, 8)} ${pad(b.stock, 9)} ${pad(b.po, 8)} ${pad(b.short, 8)} ${pad(b.shortUnits, 8)} ${b.partSplit}`);
  }
  notice("  A 'shortage' line is NOT a defect — it is the honest third answer (nothing on hand,");
  notice("  nothing on order). It IS a defect only if an open PO for that bucket exists and was");
  notice("  not offered; the next block tests exactly that.");
  const orphanShort = results.filter((r) => r.source === "shortage" && (poOutstandingByKey.get(r.bucketKey) ?? 0) > 0);
  notice(`  shortage lines whose OWN bucket still has open PO units  : ${orphanShort.length}  (expected 0 unless demand > supply)`);
  const noBucketAtAll = results.filter((r) => r.source === "shortage"
    && (stockByKey.get(r.bucketKey) ?? 0) === 0 && (poOutstandingByKey.get(r.bucketKey) ?? 0) === 0);
  notice(`  shortage lines with NO stock and NO PO in the bucket     : ${noBucketAtAll.length}  (genuinely unmatched — nothing to pair with)`);
  for (const r of noBucketAtAll.slice(0, 20)) {
    notice(`      ${pad(r.row.doc_no, 18)} ${pad(r.row.item_code, 26)} ${pad(catKey(r.cat), 11)} qty ${r.shortage} wh=${r.row.warehouse_id ? (whById.get(r.row.warehouse_id)?.code ?? "?") : "NONE"}`);
  }

  /* ═══════════════ (C) PO -> SO PAIRING, PER CATEGORY ════════════════════ */
  notice("");
  notice("======== (C) REVERSE PAIRING: does every OPEN PO line name the SO(s) it covers? ========");
  notice("  Layers, in po-so-coverage.ts precedence order:");
  notice("    (a) delivered DO-lock  (b) stored so_item_id / 'From SOs:' note  (c) MRP floating  (d) dash");
  const noteDocsByPo = new Map();
  for (const r of poRaw) {
    if (noteDocsByPo.has(r.po_id)) continue;
    const m = /^\s*From SOs?:\s*(.+)$/im.exec(String(r.notes ?? "").trim());
    noteDocsByPo.set(r.po_id, m ? [...new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean))] : []);
  }
  /* delivered DO-lock: any lot/movement stamped batch_no = this PO number that a DO consumed. */
  const deliveredPos = new Set((await sql`
    SELECT DISTINCT l.batch_no
      FROM scm.inventory_lots l
      JOIN scm.inventory_lot_consumptions c ON c.lot_id = l.id AND c.source_doc_type = 'DO'
     WHERE l.batch_no IS NOT NULL`).map((r) => r.batch_no));
  for (const r of await sql`
    SELECT DISTINCT batch_no FROM scm.inventory_movements
     WHERE movement_type = 'OUT' AND source_doc_type = 'DO' AND batch_no IS NOT NULL`) {
    deliveredPos.add(r.batch_no);
  }

  const rev = new Map(CATS.map((c) => [c, { lines: 0, units: 0, deliveredLock: 0, stored: 0, note: 0, mrp: 0, none: 0, noneUnits: 0 }]));
  const unpaired = [];
  for (const e of poOpen) {
    const cat = catKey(prodByCode.get(e.material_code)?.category ?? catFromGroup(e.item_group));
    const b = rev.get(cat);
    b.lines += 1; b.units += e.left;
    const hasDelivered = deliveredPos.has(e.po_number);
    const hasStored = !!e.so_item_id;
    const hasNote = (noteDocsByPo.get(e.po_id) ?? []).length > 0;
    const hasMrp = (poConsumedBy.get(e.po_number) ?? []).some((a) => a.bucketKey === e.bucketKey);
    if (hasDelivered) b.deliveredLock += 1;
    else if (hasStored) b.stored += 1;
    else if (hasNote) b.note += 1;
    else if (hasMrp) b.mrp += 1;
    else { b.none += 1; b.noneUnits += e.left; unpaired.push({ ...e, cat }); }
  }
  notice(`  ${pad("category", 16)} ${pad("openLn", 8)} ${pad("units", 8)} ${pad("delivrd", 8)} ${pad("stored", 8)} ${pad("note", 7)} ${pad("mrp", 7)} ${pad("NONE", 7)} noneUnits`);
  for (const c of CATS) {
    const b = rev.get(c);
    if (!b.lines) continue;
    notice(`  ${pad(c, 16)} ${pad(b.lines, 8)} ${pad(b.units, 8)} ${pad(b.deliveredLock, 8)} ${pad(b.stored, 8)} ${pad(b.note, 7)} ${pad(b.mrp, 7)} ${pad(b.none, 7)} ${b.noneUnits}`);
  }
  notice(`  OPEN PO lines that name NO Sales Order at all: ${unpaired.length}`);
  notice("  (a PO with no SO is legitimate when it is stock replenishment — the point is that");
  notice("   the system must be able to SAY which it is, not that every PO must have an SO.)");
  for (const u of unpaired.slice(0, 30)) {
    notice(`      ${pad(u.po_number, 18)} ${pad(u.material_code, 26)} ${pad(u.cat, 11)} left ${pad(u.left, 5)} eta ${u.eta ?? "-"}`);
  }

  /* stored-link coverage across ALL PO lines (open + closed), the owner's 47/20 figure */
  const [{ total_po_lines, linked_po_lines, note_pos }] = await sql`
    SELECT (SELECT COUNT(*)::int FROM scm.purchase_order_items WHERE company_id = ${companyId}) AS total_po_lines,
           (SELECT COUNT(*)::int FROM scm.purchase_order_items WHERE company_id = ${companyId} AND so_item_id IS NOT NULL) AS linked_po_lines,
           (SELECT COUNT(*)::int FROM scm.purchase_orders WHERE company_id = ${companyId} AND notes ~* 'From SOs?:') AS note_pos`;
  notice(`  ALL purchase_order_items rows              : ${total_po_lines}`);
  notice(`   - with a STORED so_item_id                : ${linked_po_lines}`);
  notice(`   - POs carrying a 'From SOs:' note         : ${note_pos}`);

  /* ── (C2) THE STORED LINK vs THE POOL ─────────────────────────────────── */
  notice("");
  notice("  ---- (C2) a STORED link MRP's pooling cannot see ----");
  notice("  A PO line raised FROM an SO line carries so_item_id, but MRP ignores that link and");
  notice("  pools by (warehouse, item_code, variant_key). If the PO line's bucket differs from");
  notice("  its own SO line's bucket, the two never meet: the SO shows a shortage while the PO");
  notice("  it was literally raised from shows no assigned SO. Same document, two buckets.");
  const demandById = new Map(demand.map((r) => [r.id, r]));
  const mismatch = { warehouse: [], variant: [], code: [], soGone: 0 };
  for (const e of poOpen) {
    if (!e.so_item_id) continue;
    const so = demandById.get(e.so_item_id);
    if (!so) { mismatch.soGone += 1; continue; }
    const soKey = composite(so.warehouse_id ?? null, so.item_code, computeVariantKey(so.item_group, so.variants));
    if (soKey === e.bucketKey) continue;
    const row = { po: e.po_number, code: e.material_code, soDoc: so.doc_no, soKey, poKey: e.bucketKey };
    if (so.item_code !== e.material_code) mismatch.code.push(row);
    else if ((so.warehouse_id ?? null) !== (e.poWh ?? null)) mismatch.warehouse.push(row);
    else mismatch.variant.push(row);
  }
  notice(`  open PO lines whose stored SO line is no longer live demand : ${mismatch.soGone}  (shipped/closed — expected)`);
  notice(`  stored links split by WAREHOUSE : ${mismatch.warehouse.length}  (PO ships to a different warehouse than the SO draws from)`);
  for (const m of mismatch.warehouse.slice(0, 15)) notice(`      ${pad(m.po, 18)} ${pad(m.code, 24)} SO ${pad(m.soDoc, 18)} soKey=${m.soKey} poKey=${m.poKey}`);
  notice(`  stored links split by VARIANT   : ${mismatch.variant.length}  (same SKU + warehouse, different fabric/leg/gap key)`);
  for (const m of mismatch.variant.slice(0, 15)) notice(`      ${pad(m.po, 18)} ${pad(m.code, 24)} SO ${pad(m.soDoc, 18)} soKey=${m.soKey} poKey=${m.poKey}`);
  notice(`  stored links split by ITEM CODE : ${mismatch.code.length}  (cross-category / substituted SKU)`);
  for (const m of mismatch.code.slice(0, 15)) notice(`      ${pad(m.po, 18)} ${pad(m.code, 24)} SO ${pad(m.soDoc, 18)} soKey=${m.soKey} poKey=${m.poKey}`);

  /* ═══════════════ (D) DOUBLE-ALLOCATION ════════════════════════════════ */
  notice("");
  notice("======== (D) CAN THE SAME UNIT BE PROMISED TWICE? ========");
  notice("  Within one computeMrp pass the pool is a single mutable queue per bucket, so a unit");
  notice("  taken by one SO line is gone for the next. Two things can break that:");
  notice(`  1. LEGACY '' VARIANT POOL (mrp.ts L884-890). A real-variant bucket with no PO supply`);
  notice(`     of its own falls back to the same-warehouse EMPTY-variant PO pool. The R4 fix stops`);
  notice(`     it being added ON TOP of a bucket's own supply — it does NOT stop TWO different`);
  notice(`     variant buckets of the same (warehouse, item) each cloning the SAME legacy pool.`);
  notice(`     Each bucket clones the legacy entries (mrp.ts L890 .map(p => ({...p}))), so two clones
     decrement independently and the SAME physical units cover both.
     BLAST RADIUS IS NARROW BY CONSTRUCTION: variant_key is '' for MATTRESS and ACCESSORY
     (ATTRS_BY_GROUP has no attributes for them), so 'vkey !== ""' is false and they never
     take the fallback. The SOFA path (mrp.ts L1021) does not fold the legacy pool in at
     all. That leaves BEDFRAME as the only category this can reach.
     (warehouse,item) groups where >1 variant bucket draws on one legacy pool: ${legacyShared.length}`);
  for (const l of legacyShared.slice(0, 20)) notice(`      ${pad(l.gk, 46)} variants: ${l.vkeys.map((v) => v || "''").join(" ; ")}`);
  const legacySofaOrphans = [];
  for (const [k, b] of sofaBuckets) {
    if (b.vkey === "") continue;
    if ((poByKey.get(k) ?? []).length > 0) continue;
    const legacyKey = composite(b.whId, b.code, "");
    if ((poByKey.get(legacyKey) ?? []).length > 0) legacySofaOrphans.push(k);
  }
  notice(`  1b. THE MIRROR IMAGE: sofa buckets with no own PO supply while a legacy '' PO for the`);
  notice(`      same (warehouse, item) IS open — invisible to the sofa path, so it reads as a`);
  notice(`      phantom shortage: ${legacySofaOrphans.length}`);
  for (const k of legacySofaOrphans.slice(0, 15)) notice(`      ${k}`);
  const claimTotals = new Map();
  for (const [poNumber, claims] of poConsumedBy) claimTotals.set(poNumber, claims.reduce((a, c) => a + c.qty, 0));
  const poLeftByNumber = new Map();
  for (const e of supplyEntries) poLeftByNumber.set(e.poNumber, (poLeftByNumber.get(e.poNumber) ?? 0) + e.qtyLeft);
  const overClaimed = [...claimTotals.entries()].filter(([p, q]) => q > (poLeftByNumber.get(p) ?? 0) + 1e-9);
  notice(`  2. PO NUMBER over-claimed across buckets (soft claims > that PO's open units): ${overClaimed.length}`);
  for (const [p, q] of overClaimed.slice(0, 20)) notice(`      ${pad(p, 20)} claimed ${pad(q, 8)} open ${poLeftByNumber.get(p) ?? 0}`);
  notice("  3. ON-HAND double promise: a bucket's stock is decremented in the same walk, and the");
  notice("     sofa and general paths never share a bucket (a code is one category). Measured:");
  const stockOver = [];
  const stockUsedByBucket = new Map();
  for (const r of results) stockUsedByBucket.set(r.bucketKey, (stockUsedByBucket.get(r.bucketKey) ?? 0) + r.fromStock);
  for (const [bk, used] of stockUsedByBucket) {
    const have = stockByKey.get(bk) ?? 0;
    if (used > have + 1e-9) stockOver.push({ bk, used, have });
  }
  notice(`     buckets whose assigned on-hand exceeds the bucket's balance: ${stockOver.length}`);
  for (const s of stockOver.slice(0, 20)) notice(`      ${pad(s.bk, 60)} assigned ${s.used} > on-hand ${s.have}`);
  notice("  4. The auto-allocation job (so-stock-allocation.ts) runs a SECOND, independent walk");
  notice("     that sets stock_status=READY. It uses a different priority order and a different");
  notice("     definition of the bucket. Divergence between the two is counted in section (E).");

  /* ═══════════════ (E) READY — does it name the source PO? ══════════════ */
  notice("");
  notice("======== (E) READY / ALLOCATION — which PO did the goods come from? ========");
  const readyRows = await sql`
    SELECT i.item_code, i.item_group, i.stock_status, i.allocated_batch_no, i.doc_no, i.qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${companyId} AND i.cancelled = FALSE
       AND UPPER(COALESCE(i.stock_status,'')) IN ('READY','PARTIAL')
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','CLOSED','DELIVERED','INVOICED','DRAFT')`;
  const readyByCat = new Map(CATS.map((c) => [c, { n: 0, withBatch: 0 }]));
  for (const r of readyRows) {
    const c = catKey(prodByCode.get(r.item_code)?.category ?? catFromGroup(r.item_group));
    const b = readyByCat.get(c);
    b.n += 1; if (r.allocated_batch_no) b.withBatch += 1;
  }
  notice(`  ${pad("category", 16)} ${pad("READY/PARTIAL lines", 22)} with allocated_batch_no (= the source PO)`);
  for (const c of CATS) {
    const b = readyByCat.get(c);
    if (!b.n) continue;
    notice(`  ${pad(c, 16)} ${pad(b.n, 22)} ${b.withBatch}${b.withBatch === 0 ? "   <-- READY names NO source PO" : ""}`);
  }
  notice("  so-stock-allocation.ts L311-318 routes ONLY sofa (isBatchedLine) down the batch path;");
  notice("  every other category is filled from a qty bucket, so its READY state carries a QUANTITY");
  notice("  and no identity. The source PO for a non-sofa line only becomes knowable at DO time,");
  notice("  when FIFO picks a lot and that lot's batch_no = the PO number.");

  /* ═══════════════ (F) SOFT -> HARD AT DO ═══════════════════════════════ */
  notice("");
  notice("======== (F) SOFT -> HARD: does raising a DO anchor the pairing? ========");
  const [shipStats] = await sql`
    SELECT COUNT(*)::int AS out_movements,
           COUNT(*) FILTER (WHERE m.batch_no IS NOT NULL)::int AS with_batch,
           COUNT(*) FILTER (WHERE m.batch_no IS NULL)::int AS without_batch
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.company_id = ${companyId}
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'`;
  const [consStats] = await sql`
    SELECT COUNT(*)::int AS consumptions,
           COUNT(*) FILTER (WHERE l.batch_no IS NOT NULL)::int AS lot_batched,
           COUNT(*) FILTER (WHERE l.batch_no IS NULL)::int AS lot_unbatched
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
     WHERE c.source_doc_type = 'DO'`;
  notice(`  DO OUT movements (non-cancelled DOs)        : ${shipStats.out_movements}`);
  notice(`   - carrying batch_no (= the source PO)      : ${shipStats.with_batch}`);
  notice(`   - NO batch_no on the movement              : ${shipStats.without_batch}  (plain FIFO: identity lives on the consumed LOT, below)`);
  notice(`  DO lot consumptions                         : ${consStats.consumptions}`);
  notice(`   - consumed lot carries batch_no            : ${consStats.lot_batched}`);
  notice(`   - consumed lot has NO batch_no             : ${consStats.lot_unbatched}  <-- shipped goods whose source PO is UNKNOWABLE`);
  const untraceable = await sql`
    SELECT d.do_number, c.product_code, SUM(c.qty_consumed)::numeric AS qty
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
      JOIN scm.delivery_orders d ON d.id = c.source_doc_id
     WHERE c.source_doc_type = 'DO' AND l.batch_no IS NULL
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     GROUP BY d.do_number, c.product_code ORDER BY 3 DESC LIMIT 20`;
  for (const u of untraceable) notice(`      ${pad(u.do_number, 20)} ${pad(u.product_code, 26)} qty ${u.qty}`);
  /* A FULLY shipped line leaves demand entirely (effQty 0), so layer (c) cannot
     apply to it. What can still float is the RESIDUAL of a partly-shipped line. */
  const partiallyShipped = results.filter((r) => (delMap.get(r.row.id) ?? 0) > 0);
  notice(`  demand lines still floating that have ALREADY shipped some units: ${partiallyShipped.length}`);
  notice(`   - of those, still soft-matched to a PO     : ${partiallyShipped.filter((r) => r.source === "po").length}`);
  notice("   (legitimate: the residual has not shipped. The SHIPPED part is anchored by its batch.)");
  const shippedStillFull = results.filter((r) => (delMap.get(r.row.id) ?? 0) >= num(r.row.qty) && r.eff > 0);
  notice(`  ⚠ lines fully shipped yet STILL carrying demand: ${shippedStillFull.length}  (expected 0)`);

  /* ═══════════════ (G) SOFA SETS ════════════════════════════════════════ */
  notice("");
  notice("======== (G) SOFA — is the colour-matched SET kept whole? ========");
  const sofaBySo = new Map();
  for (const r of results) {
    if (!r.isSofa) continue;
    const k = `${r.row.warehouse_id ?? WH_NONE}|${r.row.doc_no}`;
    const arr = sofaBySo.get(k) ?? [];
    arr.push(r); sofaBySo.set(k, arr);
  }
  let setsSplitAcrossPos = 0, setsMixedSource = 0;
  const splitExamples = [];
  for (const [k, mods] of sofaBySo) {
    const pos = new Set(mods.filter((m) => m.poNumber).map((m) => m.poNumber));
    const sources = new Set(mods.map((m) => m.source));
    if (pos.size > 1) { setsSplitAcrossPos += 1; splitExamples.push({ k, pos: [...pos], n: mods.length }); }
    if (sources.size > 1) setsMixedSource += 1;
  }
  notice(`  sofa sets (warehouse|SO) in open demand      : ${sofaBySo.size}`);
  notice(`  sets whose modules soft-match >1 DIFFERENT PO: ${setsSplitAcrossPos}`);
  for (const s of splitExamples.slice(0, 20)) notice(`      ${pad(s.k, 46)} ${s.n} modules across ${s.pos.join(" + ")}`);
  notice(`  sets with MIXED coverage (stock+PO+shortage) : ${setsMixedSource}`);
  notice("  MRP allocates each sofa module independently from its own (wh, code, variant) pool");
  notice("  (mrp.ts §8) — there is no set-level atomicity on the PLANNING side. Atomicity exists");
  notice("  on the ALLOCATION side (so-stock-allocation.ts 7b: one covering batch or PENDING) and");
  notice("  on the SHIP side (ship-commitment.ts planSofaSetPoConflicts refuses a 2-batch set).");
  const sofaWhSplit = await sql`
    SELECT i.doc_no, COUNT(DISTINCT COALESCE(i.warehouse_id::text,'NULL'))::int AS wh_variants
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${companyId} AND i.cancelled = FALSE
       AND UPPER(COALESCE(s.status::text,'')) NOT IN ('CANCELLED','CLOSED','DELIVERED','INVOICED','DRAFT')
     GROUP BY i.doc_no HAVING COUNT(DISTINCT COALESCE(i.warehouse_id::text,'NULL')) > 1`;
  notice(`  live SOs whose LINES carry >1 distinct warehouse_id (incl. NULL): ${sofaWhSplit.length}`);
  notice("   -- before the 2026-07-31 'warehouse follows the SO' change every one of these split");
  notice("      into two MRP rows; the resolver now folds the NULL side onto the SO's warehouse.");
  for (const s of sofaWhSplit.slice(0, 15)) notice(`      ${pad(s.doc_no, 20)} ${s.wh_variants} distinct warehouse values`);
}

main().then(() => sql.end()).catch((e) => {
  console.error("MRP_PAIRING_AUDIT_FAIL", e?.message ?? e);
  process.exit(1);
});
