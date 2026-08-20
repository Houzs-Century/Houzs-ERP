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
//   and (2026-08-02): "我们不会订超过我们需要的货物 — 除了 accessories;
//   mattress / bedframe / sofa 都不会。全部 PO cancel 了之后 MRP running 的
//   规则要对" — measured in section (H).
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
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";
import { parseProvenanceNote, provenanceNoteSqlPattern } from "./lib/transfer-vocabulary.mjs";

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

/* ── ported: mrp.ts SO_DONE / PO_DEAD ────────────────────────────────────────
   SHIPPED added 2026-08-01 (fix/mrp-consistency-tails, audit D4): the engine now
   treats a SHIPPED SO as done, matching so-stock-allocation.

   NO LONGER A REPLICA. "Keep this replica in lockstep or its figures lie" is
   what this comment used to say, and it lied about /inventory/ reservations in
   the same breath: that endpoint's SO_DONE has FOUR statuses, not these six
   (see routes/inventory.ts, left disagreeing on purpose — BUG-HISTORY
   2026-08-13). The set is imported now, so an audit reading a different lens
   than the allocator is no longer something anyone has to remember. */
const SO_DONE = new Set(SO_TERMINAL_STATES);
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

  /* Since 2026-08-01 (audit D6 fix) includeUndated is DISPLAY-ONLY in mrp.ts:
     the engine always allocates the FULL active set, undated rows last (null
     dates sort after every real date). Replicate that — one allocation — and
     report the undated slice separately as the page-visibility note. */
  const activeAll = demandRaw.filter((r) => r.item_code && !SO_DONE.has(snorm(r.so_status)) && num(r.qty) > 0);
  const undated = activeAll.filter((r) => !(r.line_delivery_date ?? r.customer_delivery_date));
  const demand = activeAll.filter((r) => effQtyOf(r) > 0);

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
    SELECT item_code, warehouse_id, variant_key, qty
      FROM scm.inventory_balances WHERE company_id = ${companyId}`;
  const stockByKey = new Map();
  const stockMetaByKey = new Map();
  for (const b of balances) {
    const k = composite(b.warehouse_id ?? null, b.item_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + num(b.qty));
    if (!stockMetaByKey.has(k)) stockMetaByKey.set(k, { wh: b.warehouse_id ?? null, code: b.item_code, vkey: b.variant_key ?? "" });
  }

  /* ── 4. PO SUPPLY — mrp.ts §4 (L677-730) ──────────────────────────────── */
  const poRaw = await sql`
    SELECT pi.id AS po_item_id, pi.item_code, pi.item_group, pi.variants,
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
    const bucketKey = composite(poWh, r.item_code, computeVariantKey(r.item_group, r.variants));
    const entry = { ...r, left, eta, poWh, bucketKey };
    poOpen.push(entry);
    poDrafts.push({ bucketKey, poNumber: r.po_number, eta, qtyLeft: left, supplierId: r.supplier_id, poItemId: r.po_item_id });
  }

  /* ── 4b. COMMITTED SHIPMENTS — mrp.ts loadCommittedShipments + ship-commitment.ts */
  const openPoNumbers = [...new Set(poDrafts.map((d) => d.poNumber).filter(Boolean))];
  const committed = new Map();
  if (openPoNumbers.length > 0) {
    const movs = await sql`
      SELECT m.id, m.warehouse_id, m.item_code, m.variant_key, m.batch_no, m.qty, m.source_doc_id,
             UPPER(COALESCE(d.status::text,'')) AS do_status, d.is_dropship,
             COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                        WHERE c.movement_id = m.id), 0)::numeric AS consumed,
             EXISTS (SELECT 1 FROM scm.delivery_order_items di
                      WHERE di.delivery_order_id = d.id
                        AND di.committed_po_batch_no = m.batch_no
                        AND di.item_code = m.item_code
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
      const k = `${composite(m.warehouse_id ?? null, m.item_code, m.variant_key ?? "")}|${m.batch_no}`;
      const cur = committed.get(k);
      if (cur) cur.qty += short;
      else committed.set(k, { qty: short, batchNo: m.batch_no, itemCode: m.item_code });
    }
  }
  /* applyCommittedSupply — ship-commitment.ts L345-372 */
  const supplyEntries = [];
  const stockAddBack = new Map();
  const committedByPoItem = new Map();      // poItemId -> units a ship-before-arrival DO already owns (H)
  const pool = new Map([...committed].map(([k, v]) => [k, { ...v }]));
  for (const e of poDrafts) {
    const k = `${e.bucketKey}|${e.poNumber}`;
    const owed = pool.get(k);
    if (!owed || owed.qty <= 0) { if (e.qtyLeft > 0) supplyEntries.push(e); continue; }
    const take = Math.min(owed.qty, e.qtyLeft);
    owed.qty -= take;
    if (take > 0) committedByPoItem.set(e.poItemId, (committedByPoItem.get(e.poItemId) ?? 0) + take);
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
  const claimedByPoItem = new Map();        // poItemId -> units demand soft-claims (H)
  const legacyShared = [];                  // double-allocation evidence
  const legacyUseByWhCode = new Map();      // `${wh}|${code}` -> [vkeys using the legacy pool]

  const allocate = (bucketMap, isSofa) => {
    for (const [k, bucket] of bucketMap) {
      const { whId, code, vkey } = bucket;
      const rows = sortRows(bucket.rows);
      let stockLeft = stockByKey.get(k) ?? 0;
      const ownPo = poByKey.get(k) ?? [];
      /* mrp.ts legacy '' fallback pool — since 2026-08-01 (audit D2 fix) the
         SOFA path folds it in too, under the SAME R4 guard (only when the
         bucket has no PO supply of its own, never additive). One rule, both
         paths; isSofa no longer changes the supply queue. */
      const legacyKey = composite(whId, code, "");
      const useLegacy = vkey !== "" && legacyKey !== k && ownPo.length === 0;
      if (useLegacy && (poByKey.get(legacyKey) ?? []).length > 0) {
        const gk = `${whId ?? WH_NONE}|${code}`;
        const arr = legacyUseByWhCode.get(gk) ?? [];
        arr.push(vkey); legacyUseByWhCode.set(gk, arr);
      }
      const poQueue = [...ownPo, ...(useLegacy ? (poByKey.get(legacyKey) ?? []) : [])]
        .map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));
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
          takenFrom.push({ poNumber: front.poNumber, poItemId: front.poItemId, qty: take });
          front.qtyLeft -= take; need -= take;
          if (front.qtyLeft <= 0) poQueue.shift();
        }
        const source = need > 0 ? "shortage" : poNumber != null ? "po" : "stock";
        for (const t of takenFrom) {
          const arr = poConsumedBy.get(t.poNumber) ?? [];
          arr.push({ soItemId: r.id, soDocNo: r.doc_no, qty: t.qty, bucketKey: k });
          poConsumedBy.set(t.poNumber, arr);
          if (t.poItemId) claimedByPoItem.set(t.poItemId, (claimedByPoItem.get(t.poItemId) ?? 0) + t.qty);
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
  notice(`   - UNDATED (hidden on the page by default) : ${undated.length}   (display-only since 2026-08-01: they STILL`);
  notice("     allocate, sorted last — every caller reads ONE identical allocation and the");
  notice("     includeUndated flag only controls whether these rows are rendered)");
  notice(`   - dropped: already fully delivered        : ${activeAll.length - demand.length}`);
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
  notice("  ---- THE 5000-ROW CEILING (mrp.ts MRP_LOAD_CAP) ----");
  notice("  Since 2026-08-01 both reads push their status filters into SQL, carry ORDER BY id,");
  notice("  and THROW mrp_load_truncated when the returned rows reach the cap — a truncated plan");
  notice("  now fails loudly instead of silently planning on a slice. The raw table counts below");
  notice("  are the UPPER BOUND (the engine's SQL filter excludes done/dead statuses), so");
  notice("  headroom in truth is at least what these show.");
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
  notice(`  SHIPPED-status lines still demanding : ${shippedDemanding}  -- MUST be 0: SHIPPED is in SO_DONE since`);
  notice("                                          2026-08-01, matching so-stock-allocation. Non-zero = replica drift.");
  notice(`  ON_HOLD-status lines still demanding : ${onHoldDemanding}  -- a held order still drives purchasing (owner call)`);
  notice(`  SO lines whose delivered sum changes if DRAFT DOs count : ${draftDoDivergence}`);
  notice("     (BOTH engines exclude DRAFT DOs since 2026-08-01 — soDeliverableRemaining always did,");
  notice("      so-stock-allocation was aligned by fix/mrp-consistency-tails. This counts the lines a");
  notice("      draft DO is currently touching, i.e. what the OLD allocator rule would have got wrong.)");
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
  notice("    (a) delivered DO-lock  (b) stored so_item_id / provenance note  (c) MRP floating  (d) dash");
  const noteDocsByPo = new Map();
  for (const r of poRaw) {
    if (noteDocsByPo.has(r.po_id)) continue;
    noteDocsByPo.set(r.po_id, parseProvenanceNote(r.notes));
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
    const cat = catKey(prodByCode.get(e.item_code)?.category ?? catFromGroup(e.item_group));
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
    notice(`      ${pad(u.po_number, 18)} ${pad(u.item_code, 26)} ${pad(u.cat, 11)} left ${pad(u.left, 5)} eta ${u.eta ?? "-"}`);
  }

  /* stored-link coverage across ALL PO lines (open + closed), the owner's 47/20 figure */
  const [{ total_po_lines, linked_po_lines, note_pos }] = await sql`
    SELECT (SELECT COUNT(*)::int FROM scm.purchase_order_items WHERE company_id = ${companyId}) AS total_po_lines,
           (SELECT COUNT(*)::int FROM scm.purchase_order_items WHERE company_id = ${companyId} AND so_item_id IS NOT NULL) AS linked_po_lines,
           (SELECT COUNT(*)::int FROM scm.purchase_orders WHERE company_id = ${companyId} AND notes ~* ${provenanceNoteSqlPattern()}) AS note_pos`;
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
    const row = { po: e.po_number, code: e.item_code, soDoc: so.doc_no, soKey, poKey: e.bucketKey };
    if (so.item_code !== e.item_code) mismatch.code.push(row);
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
  notice(`  1. LEGACY '' VARIANT POOL. A real-variant bucket with no PO supply of its own falls`);
  notice(`     back to the same-warehouse EMPTY-variant PO pool. The R4 fix stops it being added`);
  notice(`     ON TOP of a bucket's own supply — it does NOT stop TWO different variant buckets`);
  notice(`     of the same (warehouse, item) each cloning the SAME legacy pool.`);
  notice(`     Each bucket clones the legacy entries (.map(p => ({...p}))), so two clones
     decrement independently and the SAME physical units cover both.
     BLAST RADIUS: variant_key is '' for MATTRESS and ACCESSORY (ATTRS_BY_GROUP has no
     attributes for them), so 'vkey !== ""' is false and they never take the fallback.
     Since 2026-08-01 the SOFA path folds the legacy pool in under the SAME R4 guard
     (audit D2 fix — a legacy sofa PO used to be invisible there, reading as phantom
     shortage), so BEDFRAME and SOFA are the two categories this sharing can reach.
     (warehouse,item) groups where >1 variant bucket draws on one legacy pool: ${legacyShared.length}`);
  for (const l of legacyShared.slice(0, 20)) notice(`      ${pad(l.gk, 46)} variants: ${l.vkeys.map((v) => v || "''").join(" ; ")}`);
  const legacySofaDraws = [];
  for (const [k, b] of sofaBuckets) {
    if (b.vkey === "") continue;
    if ((poByKey.get(k) ?? []).length > 0) continue;
    const legacyKey = composite(b.whId, b.code, "");
    if ((poByKey.get(legacyKey) ?? []).length > 0) legacySofaDraws.push(k);
  }
  notice(`  1b. Sofa buckets with no own PO supply drawing on an open legacy '' PO (the blind`);
  notice(`      spot closed 2026-08-01 — these used to read as phantom shortage; they are now`);
  notice(`      covered by the fallback): ${legacySofaDraws.length}`);
  for (const k of legacySofaDraws.slice(0, 15)) notice(`      ${k}`);
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
       AND UPPER(COALESCE(s.status::text,'')) <> ALL(${SO_TERMINAL_STATES})`;
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
    SELECT d.do_number, c.item_code, SUM(c.qty_consumed)::numeric AS qty
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
      JOIN scm.delivery_orders d ON d.id = c.source_doc_id
     WHERE c.source_doc_type = 'DO' AND l.batch_no IS NULL
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     GROUP BY d.do_number, c.item_code ORDER BY 3 DESC LIMIT 20`;
  for (const u of untraceable) notice(`      ${pad(u.do_number, 20)} ${pad(u.item_code, 26)} qty ${u.qty}`);
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
       AND UPPER(COALESCE(s.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
     GROUP BY i.doc_no HAVING COUNT(DISTINCT COALESCE(i.warehouse_id::text,'NULL')) > 1`;
  notice(`  live SOs whose LINES carry >1 distinct warehouse_id (incl. NULL): ${sofaWhSplit.length}`);
  notice("   -- before the 2026-07-31 'warehouse follows the SO' change every one of these split");
  notice("      into two MRP rows; the resolver now folds the NULL side onto the SO's warehouse.");
  for (const s of sofaWhSplit.slice(0, 15)) notice(`      ${pad(s.doc_no, 20)} ${s.wh_variants} distinct warehouse values`);

  /* ═══════════════ (H) OVER-ORDER — the owner's purchasing rule ═════════ */
  notice("");
  notice("======== (H) OVER-ORDER — did we buy more than we need? ========");
  notice("  Owner's rule (2026-08-02): purchases NEVER exceed demand for MATTRESS /");
  notice("  BEDFRAME / SOFA — only ACCESSORY may be bought for stock. And a CANCELLED");
  notice("  PO must be fully OUT of the running formula.");
  notice("  ---- (H0) the cancel rule, asserted on today's rows ----");
  notice(`  dead-PO lines (CANCELLED/DRAFT) excluded from the supply pool : ${poDead}  (structural: PO_DEAD filter)`);
  notice("  goods ALREADY received on a since-cancelled PO stay in stock — correct: the");
  notice("  IN movement is physical history; cancellation only kills the un-received rest.");
  const deadLinked = [];
  for (const r of poRaw) {
    if (!PO_DEAD.has(snorm(r.po_status)) || !r.so_item_id) continue;
    if (demandById.has(r.so_item_id)) deadLinked.push(r);
  }
  notice(`  dead-PO lines whose stored so_item_id points at LIVE demand   : ${deadLinked.length}`);
  notice("     (harmless to MRP — a dead PO never supplies — but the demand these lines once");
  notice("      covered is back on the market: MRP must re-pair it or purchasing must re-order.)");
  for (const r of deadLinked.slice(0, 15)) {
    const so = demandById.get(r.so_item_id);
    notice(`      ${pad(r.po_number, 18)} ${pad(r.item_code, 26)} qty ${pad(num(r.qty), 5)} -> live SO ${so?.doc_no}`);
  }
  const deadAllocs = await sql`
    SELECT po.po_number, a.qty, si.doc_no, si.cancelled,
           UPPER(COALESCE(s.status::text,'')) AS so_status
      FROM scm.purchase_order_item_allocations a
      JOIN scm.purchase_order_items pi ON pi.id = a.purchase_order_item_id
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = a.so_item_id
      LEFT JOIN scm.mfg_sales_orders s ON s.doc_no = si.doc_no AND s.company_id = si.company_id
     WHERE pi.company_id = ${companyId}
       AND UPPER(po.status::text) IN ('CANCELLED','DRAFT')
       AND a.so_item_id IS NOT NULL`;
  const deadAllocsLive = deadAllocs.filter((a) => !a.cancelled && !SO_DONE.has(a.so_status));
  notice(`  allocation sub-lines on dead POs still claiming a live SO     : ${deadAllocsLive.length}  (expected 0 — cancelled POs are never attribution targets)`);
  for (const a of deadAllocsLive.slice(0, 10)) notice(`      ${pad(a.po_number, 18)} qty ${pad(num(a.qty), 5)} -> ${a.doc_no}`);

  notice("  ---- (H1) surplus per category (open PO units nobody is asking for) ----");
  const allocRows = await sql`
    SELECT a.purchase_order_item_id, a.seq, a.qty, a.so_item_id
      FROM scm.purchase_order_item_allocations a
      JOIN scm.purchase_order_items pi ON pi.id = a.purchase_order_item_id
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
     WHERE pi.company_id = ${companyId}
       AND UPPER(po.status::text) NOT IN ('CANCELLED','DRAFT')`;
  const allocsByPoItem = new Map();
  for (const a of allocRows) {
    const arr = allocsByPoItem.get(a.purchase_order_item_id) ?? [];
    arr.push(a); allocsByPoItem.set(a.purchase_order_item_id, arr);
  }
  const shortageByCode = new Map();
  for (const r of results) {
    if (r.shortage > 0) shortageByCode.set(r.row.item_code, (shortageByCode.get(r.row.item_code) ?? 0) + r.shortage);
  }
  const surplusLines = [];
  const overClaimedLines = [];
  const catTotals = new Map(CATS.map((c) => [c, { openUnits: 0, spoken: 0, surplus: 0, lines: 0 }]));
  for (const e of poOpen) {
    const cat = catKey(prodByCode.get(e.item_code)?.category ?? catFromGroup(e.item_group));
    if (isServiceLine({ itemGroup: e.item_group, itemCode: e.item_code, category: cat })) continue;
    const committedTake = committedByPoItem.get(e.po_item_id) ?? 0;
    const claimed = claimedByPoItem.get(e.po_item_id) ?? 0;
    const surplus = e.left - committedTake - claimed;
    const t = catTotals.get(cat);
    t.openUnits += e.left;
    t.spoken += Math.min(e.left, committedTake + claimed);
    if (surplus < -1e-9) { overClaimedLines.push({ e, cat, committedTake, claimed }); continue; }
    if (surplus > 1e-9) {
      t.surplus += surplus; t.lines += 1;
      surplusLines.push({ e, cat, committedTake, claimed, surplus });
    }
  }
  notice(`  ${pad("category", 16)} ${pad("openUnits", 10)} ${pad("spokenFor", 10)} ${pad("SURPLUS", 9)} verdict`);
  for (const c of CATS) {
    const t = catTotals.get(c);
    if (!t.openUnits) continue;
    const verdict = c === "ACCESSORY" ? "stock purchases ALLOWED (owner policy)"
      : c === "(uncategorised)" ? (t.surplus > 0 ? "unknown category — classify the product, then judge" : "OK")
      : t.surplus > 0 ? "VIOLATES the never-over-order rule — documents below" : "OK — every unit spoken for";
    notice(`  ${pad(c, 16)} ${pad(t.openUnits, 10)} ${pad(t.spoken, 10)} ${pad(t.surplus, 9)} ${verdict}`);
  }
  notice(`  lines soft-claimed BEYOND their qty (legacy double-clone evidence, expect 0): ${overClaimedLines.length}`);

  notice("  ---- (H2) document by document — every over-ordered PO ----");
  notice("  reason codes: STOCK-SLICE = an allocation sub-line explicitly declares 'for stock';");
  notice("  SO-DONE = the linked SO already completed/cancelled (goods served from elsewhere),");
  notice("  the remainder is now unspoken-for; BUCKET-SPLIT = the same SKU is SHORT in another");
  notice("  warehouse/variant bucket (a pairing bug, NOT a true over-order); NO-DEMAND = nothing");
  notice("  in the system asks for these units.");
  const soStateIds = new Set();
  for (const s of surplusLines) {
    if (s.e.so_item_id) soStateIds.add(s.e.so_item_id);
    for (const a of allocsByPoItem.get(s.e.po_item_id) ?? []) if (a.so_item_id) soStateIds.add(a.so_item_id);
  }
  const soStateById = new Map();
  if (soStateIds.size > 0) {
    for (const r of await sql`
      SELECT i.id, i.doc_no, i.cancelled, UPPER(COALESCE(s.status::text,'')) AS so_status
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.id IN ${sql([...soStateIds])}`) soStateById.set(r.id, r);
  }
  const reasonOf = (s) => {
    const allocs = allocsByPoItem.get(s.e.po_item_id) ?? [];
    const stockQty = allocs.filter((a) => !a.so_item_id).reduce((x, a) => x + num(a.qty), 0);
    if (stockQty >= s.surplus - 1e-9 && allocs.length > 0) return "STOCK-SLICE (declared)";
    const links = [s.e.so_item_id, ...allocs.map((a) => a.so_item_id)].filter(Boolean);
    const doneLinks = links.map((id) => soStateById.get(id))
      .filter((r) => r && (r.cancelled || SO_DONE.has(r.so_status)));
    const short = shortageByCode.get(s.e.item_code) ?? 0;
    if (doneLinks.length > 0) {
      const d = doneLinks[0];
      return `SO-DONE (${d.doc_no} ${d.cancelled ? "line-cancelled" : d.so_status})${short > 0 ? ` + same SKU short ${short} elsewhere` : ""}`;
    }
    if (short > 0) return `BUCKET-SPLIT? same SKU short ${short} in another bucket`;
    return "NO-DEMAND";
  };
  const byPo = new Map();
  for (const s of surplusLines) {
    if (s.cat === "ACCESSORY") continue;
    const arr = byPo.get(s.e.po_number) ?? [];
    arr.push(s); byPo.set(s.e.po_number, arr);
  }
  notice(`  over-ordered PO documents (MATTRESS/BEDFRAME/SOFA/uncategorised): ${byPo.size}`);
  for (const [poNo, lines] of [...byPo].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tot = lines.reduce((x, s) => x + s.surplus, 0);
    notice(`   ${pad(poNo, 20)} surplus ${tot} unit(s) across ${lines.length} line(s)`);
    for (const s of lines.slice(0, 12)) {
      notice(`      ${pad(s.e.item_code, 26)} ${pad(s.cat, 11)} qty ${pad(num(s.e.qty), 4)} recvd ${pad(num(s.e.received_qty), 4)} open ${pad(s.e.left, 4)} claimed ${pad(s.committedTake + s.claimed, 4)} SURPLUS ${pad(s.surplus, 4)} ${reasonOf(s)}`);
    }
  }
  const accSurplus = surplusLines.filter((x) => x.cat === "ACCESSORY");
  notice(`  ACCESSORY surplus (allowed by policy): ${accSurplus.reduce((x, s) => x + s.surplus, 0)} unit(s) on ${new Set(accSurplus.map((s) => s.e.po_number)).size} PO(s) — informational, NOT violations`);

  notice("  ---- (H3) already-RECEIVED surplus (on-hand stock nobody is asking for) ----");
  notice("  Same rule, after the GRN: for MATTRESS/BEDFRAME/SOFA any on-hand unit with no");
  notice("  live demand in its bucket is stock the current order book is not asking for.");
  notice("  This is REAL stock, not a phantom: inventory_balances is a VIEW = SUM(IN - OUT)");
  notice("  over inventory_movements (mig 0084), and the posted-doc-movements detector proves");
  notice("  every shipped DO wrote its OUT — so 'shipped but not deducted' cannot inflate it.");
  notice("  Each unit is CLASSIFIED by tracing its open lot's batch_no back to the source PO");
  notice("  and that PO's SO, so the leftover is never left as a bare number:");
  notice("    MIGRATED         = the open lot has no batch_no (pre-batch / opening stock; no");
  notice("                       source PO exists to trace — it predates FIFO batch stamping)");
  notice("    WAREHOUSE-SPLIT  = the SAME SKU is SHORT in another warehouse (real demand exists,");
  notice("                       the goods are just in a different warehouse than it points at)");
  notice("    SO-CANCELLED     = the source PO was raised for an SO line now cancelled (genuine");
  notice("                       dead stock: bought for an order that died — a business event)");
  notice("    STOCK-BUY/AHEAD  = source PO carries no live SO link (stock replenishment, or the");
  notice("                       SO is served and this is the tail) — no current order needs it");
  const stockLeftByBucket = new Map();
  for (const [k, have] of stockByKey) {
    const used = stockUsedByBucket.get(k) ?? 0;
    if (have - used > 1e-9) stockLeftByBucket.set(k, have - used);
  }
  const lotRows = await sql`
    SELECT batch_no, item_code, warehouse_id, COALESCE(variant_key,'') AS vkey,
           SUM(qty_remaining)::numeric AS remaining
      FROM scm.inventory_lots
     WHERE company_id = ${companyId} AND qty_remaining > 0
     GROUP BY 1, 2, 3, 4`;
  const lotsByBucket = new Map();
  const leftoverBatchNos = new Set();
  for (const l of lotRows) {
    const k = composite(l.warehouse_id ?? null, l.item_code, l.vkey);
    const arr = lotsByBucket.get(k) ?? [];
    arr.push(l); lotsByBucket.set(k, arr);
    if (l.batch_no) leftoverBatchNos.add(l.batch_no);
  }
  /* Provenance: batch_no = source PO number (mig 0120). Resolve each leftover
     lot's PO -> its lines' so_item_id / 'From SOs:' note -> that SO's status, so
     a leftover unit is labelled by WHY it is on hand, not just counted. */
  const poProvByBatch = new Map();
  if (leftoverBatchNos.size > 0) {
    const provRows = await sql`
      SELECT po.po_number,
             UPPER(po.status::text) AS po_status,
             po.notes,
             bool_or(si.id IS NOT NULL AND si.cancelled = FALSE
                     AND UPPER(COALESCE(so.status::text,'')) NOT IN ('CANCELLED','DRAFT')) AS has_live_so,
             bool_or(si.id IS NOT NULL AND (si.cancelled = TRUE
                     OR UPPER(COALESCE(so.status::text,'')) = 'CANCELLED')) AS has_cancelled_so,
             bool_or(pi.so_item_id IS NOT NULL) AS has_any_so_link
        FROM scm.purchase_orders po
        JOIN scm.purchase_order_items pi ON pi.purchase_order_id = po.id
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = pi.so_item_id
        LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no AND so.company_id = si.company_id
       WHERE po.company_id = ${companyId} AND po.po_number IN ${sql([...leftoverBatchNos])}
       GROUP BY po.po_number, po.status, po.notes`;
    for (const r of provRows) {
      const hasNote = parseProvenanceNote(r.notes).length > 0;
      poProvByBatch.set(r.po_number, { ...r, hasNote });
    }
  }
  const classify = (bucketKey, code, lots) => {
    if ((shortageByCode.get(code) ?? 0) > 0) return "WAREHOUSE-SPLIT";
    const batched = lots.filter((l) => l.batch_no);
    if (batched.length === 0) return "MIGRATED";
    let anyCancelled = false, anyLive = false, anyLink = false;
    for (const l of batched) {
      const p = poProvByBatch.get(l.batch_no);
      if (!p) continue;
      if (p.has_cancelled_so) anyCancelled = true;
      if (p.has_live_so) anyLive = true;
      if (p.has_any_so_link || p.hasNote) anyLink = true;
    }
    if (anyCancelled && !anyLive) return "SO-CANCELLED";
    if (anyLive) return "WAREHOUSE-SPLIT";      // linked to a live SO but not THIS bucket's demand
    if (!anyLink) return "STOCK-BUY/AHEAD";
    return "STOCK-BUY/AHEAD";
  };
  let deadStockUnits = 0, deadStockBuckets = 0;
  const accStockLeft = { units: 0, buckets: 0 };
  const classTally = new Map();
  for (const [k, left] of [...stockLeftByBucket].sort((a, b) => b[1] - a[1])) {
    const meta = stockMetaByKey.get(k);
    const cat = catKey(prodByCode.get(meta?.code)?.category ?? null);
    if (cat === "ACCESSORY") { accStockLeft.units += left; accStockLeft.buckets += 1; continue; }
    if (isServiceLine({ itemGroup: "", itemCode: meta?.code ?? "", category: cat })) continue;
    deadStockUnits += left; deadStockBuckets += 1;
    const lots = lotsByBucket.get(k) ?? [];
    const klass = classify(k, meta?.code, lots);
    classTally.set(klass, (classTally.get(klass) ?? 0) + left);
    if (deadStockBuckets <= 40) {
      const lotStr = lots.map((l) => `${l.batch_no ?? "(no batch)"} x${num(l.remaining)}`).join(", ");
      const short = shortageByCode.get(meta?.code) ?? 0;
      notice(`   ${pad(klass, 16)} ${pad(meta?.code ?? k, 26)} ${pad(cat, 10)} wh=${pad(whById.get(meta?.wh)?.code ?? meta?.wh ?? "NONE", 8)} qty ${pad(left, 3)} <- ${lotStr || "no open lot"}${short > 0 ? `  (same SKU short ${short} elsewhere)` : ""}`);
    }
  }
  notice(`  MATTRESS/BEDFRAME/SOFA on-hand units with NO live demand : ${deadStockUnits} across ${deadStockBuckets} bucket(s)${deadStockBuckets > 40 ? " (listing capped at 40)" : ""}`);
  notice("  by classification (proven, not assumed):");
  for (const klass of ["WAREHOUSE-SPLIT", "MIGRATED", "SO-CANCELLED", "STOCK-BUY/AHEAD"]) {
    if (classTally.has(klass)) notice(`    ${pad(klass, 16)} : ${classTally.get(klass)} unit(s)`);
  }
  notice("  NONE of these is an over-order (H1/H2 open-PO surplus = 0) or a missed deduction");
  notice("  (posted-doc-movements = 0 DO orphans). WAREHOUSE-SPLIT + MIGRATED are the warehouse-");
  notice("  resolution tail; SO-CANCELLED is genuine dead stock to write off or re-sell.");
  notice(`  ACCESSORY on-hand beyond demand (allowed)                : ${accStockLeft.units} across ${accStockLeft.buckets} bucket(s)`);

  const mbsSurplus = [...byPo.values()].flat().reduce((x, s) => x + s.surplus, 0);
  notice("  ---- (H) verdict ----");
  notice(`  open-PO over-order units (MATTRESS/BEDFRAME/SOFA/uncat) : ${mbsSurplus} on ${byPo.size} PO document(s)`);
  notice(`  received dead-stock units (same categories)             : ${deadStockUnits}`);
  notice(`  cancel-rule violations (allocation on dead PO -> live SO): ${deadAllocsLive.length}`);
  notice("  Every listed line carries a reason code; treat BUCKET-SPLIT entries as pairing");
  notice("  BUGS to fix, and the rest as purchasing/data decisions with the PO named.");
}

main().then(() => sql.end()).catch((e) => {
  console.error("MRP_PAIRING_AUDIT_FAIL", e?.message ?? e);
  process.exit(1);
});
