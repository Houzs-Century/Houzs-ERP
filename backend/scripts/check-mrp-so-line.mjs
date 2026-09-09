// READ-ONLY. "Why is this SO line not on the MRP page?" — per-line verdict for
// ONE Sales Order.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// Owner, 2026-09-09: "SO-013043 有一个 King 和一个 Queen — MRP 只有 King 需要
// order，为什么没有 Queen？" The answer lives only in production rows, and the
// owner is not a database console (CLAUDE.md). So the check runs in Actions
// against secrets.DATABASE_URL and prints the verdict; nobody handles the DSN.
//
// ⚠ REPLICA, NOT THE ENGINE. computeMrp runs in a Worker behind PostgREST and
// cannot be invoked from node, so the rules below are hand-ported from
// backend/src/scm/routes/mrp.ts §2/§3/§6/§7 — the same porting (and the same
// drift risk) as scripts/audit-mrp-pairing.mjs, which stays the canonical
// replica. Nothing here reports "MRP says X"; it reports "the rules as written
// in mrp.ts, applied to today's rows". A disagreement with the page means the
// replica is the first suspect.
//
// KNOWN GAPS vs the engine, called out so a reading is never over-trusted:
//   · ship-before-arrival commitments (mig 0230) are NOT modelled — they move
//     units from the PO pool to on-hand, which changes the SOURCE of a
//     covered line, not whether it is short;
//   · SOFA demand is grouped as colour-matched SETS (mrp.ts §8); a sofa line
//     is reported with its bucket facts and an explicit "sofa set path" note.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
// Exits 0 for every legitimate answer — the answer IS the output. Non-zero
// only for an unreachable database or a doc number that does not exist.
//
// ENUM TRAP: status columns are ENUMS — always ::text before string ops.
//
// Usage: SO_DOC=HC-SO-013043 node scripts/check-mrp-so-line.mjs
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }

const RAW_DOC = (process.env.SO_DOC ?? "").trim();
if (!RAW_DOC) { console.error("SO_DOC missing (e.g. SO_DOC=HC-SO-013043)"); process.exit(1); }

const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const num = (v) => Number(v ?? 0);
const snorm = (v) => (v ?? "").trim().toUpperCase();
const d2 = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : (x ?? null));

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
const isServiceLine = ({ itemGroup, itemCode, category }) =>
  snorm(itemGroup).includes("SERVICE")
  || snorm(category) === "SERVICE"
  || (snorm(itemCode).length > 4 && snorm(itemCode).startsWith("SVC-"));

/* ── ported: mrp.ts catFromGroup + SO_DONE / PO_DEAD + composite + byDateAsc */
const catFromGroup = (g) => {
  const s = snorm(g);
  if (s.includes("BEDFRAME")) return "BEDFRAME";
  if (s.includes("SOFA")) return "SOFA";
  if (s.includes("MATTRESS")) return "MATTRESS";
  if (s.includes("ACCESSOR")) return "ACCESSORY";
  if (s.includes("SERVICE")) return "SERVICE";
  return null;
};
const SO_DONE = new Set(["DELIVERED", "INVOICED", "CLOSED", "CANCELLED", "DRAFT", "SHIPPED"]);
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);
const WH_NONE = "NOWH";
const composite = (wh, code, vkey) => `${wh ?? WH_NONE}|${code}|${vkey}`;
const byDateAsc = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : (a < b ? -1 : 1));
const effectiveDelivery = (...ds) => {
  let best = null;
  for (const d of ds) { if (!d) continue; if (best === null || d > best) best = d; }
  return best;
};

/* ── ported: scm/lib/so-warehouse.ts — the warehouse follows the SO ───────── */
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

async function main() {
  notice("=== MRP LINE VISIBILITY — READ-ONLY, NOTHING WRITTEN ===");
  notice(`Replica of mrp.ts computeMrp (see header caveats). SO = ${RAW_DOC}`);

  const so = (await sql`
    SELECT doc_no, company_id, status::text AS so_status, customer_delivery_date,
           customer_state, sales_location, debtor_name
      FROM scm.mfg_sales_orders
     WHERE doc_no = ${RAW_DOC} OR doc_no LIKE ${"%" + RAW_DOC}
     ORDER BY doc_no LIMIT 1`)[0];
  if (!so) { notice(`NO SUCH SALES ORDER: ${RAW_DOC}`); await sql.end(); process.exit(1); }

  const companyId = so.company_id;
  notice(`${so.doc_no} — ${so.debtor_name ?? "?"} · status ${so.so_status} · company ${companyId}`
    + ` · SO delivery ${d2(so.customer_delivery_date) ?? "—"}`);
  const soIsDone = SO_DONE.has(snorm(so.so_status));
  if (soIsDone) notice(`  NOTE: status ${so.so_status} is in SO_DONE — the WHOLE order is out of MRP demand.`);

  const warehouses = await sql`SELECT id, code, name, company_id FROM scm.warehouses`;
  const stateMaps = await sql`SELECT state, warehouse_id, company_id FROM scm.state_warehouse_mappings`;
  const whById = new Map(warehouses.map((w) => [w.id, w]));
  const whLabel = (id) => (id ? (whById.get(id)?.code ?? whById.get(id)?.name ?? id) : "UNRESOLVED");
  const whScoped = warehouses.filter((w) => w.company_id == null || w.company_id === companyId);
  const mapScoped = stateMaps.filter((m) => m.company_id == null || m.company_id === companyId);

  const lines = await sql`
    SELECT id, line_no, item_code, item_group, description, variants, qty,
           warehouse_id, line_delivery_date, stock_status::text AS stock_status, cancelled
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ${so.doc_no} AND company_id = ${companyId}
     ORDER BY line_no NULLS FIRST, id`;
  notice(`lines on this SO: ${lines.length}`);
  if (lines.length === 0) { notice("no lines — nothing to explain."); return; }

  const codes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];
  const prods = codes.length === 0 ? [] : await sql`
    SELECT code, name, category::text AS category, company_id FROM scm.mfg_products
     WHERE code IN ${sql(codes)}`;
  const prodByCode = new Map();
  for (const p of prods) if (!prodByCode.has(p.code) || p.company_id === companyId) prodByCode.set(p.code, p);

  /* Delivered net of returns — mrp.ts §2 via soDeliverableRemaining. DRAFT and
     CANCELLED DOs never count as delivered. */
  const soItemIds = lines.map((l) => l.id);
  const delivered = soItemIds.length === 0 ? [] : await sql`
    SELECT di.so_item_id, SUM(di.qty)::numeric AS delivered
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IN ${sql(soItemIds)}
       AND UPPER(COALESCE(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY di.so_item_id`;
  const returned = soItemIds.length === 0 ? [] : await sql`
    SELECT di.so_item_id, SUM(ri.qty_returned)::numeric AS returned
      FROM scm.delivery_return_items ri
      JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id
      JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
     WHERE di.so_item_id IN ${sql(soItemIds)}
       AND UPPER(COALESCE(r.status::text,'')) <> 'CANCELLED'
     GROUP BY di.so_item_id`;
  const delMap = new Map(delivered.map((r) => [r.so_item_id, num(r.delivered)]));
  const retMap = new Map(returned.map((r) => [r.so_item_id, num(r.returned)]));
  const effQtyOf = (r) =>
    Math.max(0, num(r.qty) - Math.max(0, (delMap.get(r.id) ?? 0) - (retMap.get(r.id) ?? 0)));

  const buckets = new Map();   // bucketKey -> { whId, code, vkey, tab }

  for (const l of lines) {
    const prod = prodByCode.get(l.item_code);
    const cat = prod?.category ?? catFromGroup(l.item_group);
    const vkey = computeVariantKey(l.item_group, l.variants);
    const whId = l.warehouse_id ?? resolveSoWarehouseId(so, whScoped, mapScoped);
    const key = composite(whId, l.item_code, vkey);
    const eff = effQtyOf(l);
    const dated = Boolean(d2(l.line_delivery_date) ?? d2(so.customer_delivery_date));

    notice("");
    notice(`LINE ${l.line_no ?? "?"}  ${l.item_code ?? "(no code)"}  — ${l.description ?? ""}`);
    notice(`  group=${l.item_group ?? "—"}  qty=${num(l.qty)}  delivered=${delMap.get(l.id) ?? 0}`
      + `  returned=${retMap.get(l.id) ?? 0}  effective=${eff}  stock_status=${l.stock_status ?? "—"}`);
    notice(`  catalog: ${prod ? `${prod.code} category=${prod.category ?? "NULL"}` : "NOT IN mfg_products (falls back to item_group)"}`
      + `  -> MRP tab ${cat ?? "NONE"}`);
    notice(`  warehouse ${whLabel(whId)} (${l.warehouse_id ? "from the line" : "resolved from the SO header"})`);
    notice(`  variant key '${vkey}'   bucket ${key}`);
    notice(`  delivery date ${d2(l.line_delivery_date) ?? d2(so.customer_delivery_date) ?? "NONE"}`
      + `${dated ? "" : "  (UNDATED — hidden unless 'include undated' is on)"}`);

    const why = [];
    if (l.cancelled) why.push("the line is CANCELLED");
    if (soIsDone) why.push(`the SO status ${so.so_status} is in SO_DONE`);
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code, category: cat })) {
      why.push("it is a SERVICE line (services never create purchase demand)");
    }
    if (num(l.qty) <= 0) why.push("qty is 0");
    if (eff <= 0) why.push("nothing left to fulfil (fully delivered)");
    if (cat == null) why.push("no category — neither mfg_products nor item_group names one, so no tab claims it");
    if (why.length > 0) { notice(`  VERDICT: NOT in MRP demand — ${why.join("; ")}.`); continue; }
    if (cat === "SOFA") notice("  NOTE: sofa runs the SET path (mrp.ts §8) — it appears on the Sofa tab, grouped by SO.");

    notice(`  VERDICT: IS MRP demand${dated ? "" : " (allocated, but hidden on the page while undated is off)"}`
      + ` — shows on the ${cat} tab.`);
    if (!buckets.has(key)) buckets.set(key, { whId, code: l.item_code, vkey, tab: cat });
  }

  /* Per-bucket allocation. mrp.ts allocates each (warehouse, code, variant)
     bucket INDEPENDENTLY, so replaying one bucket is exact — the demand below
     is every active line in that bucket across the whole company, not just
     this SO's. */
  for (const [key, b] of buckets) {
    notice("");
    notice(`######## BUCKET ${key}  (${b.tab})`);

    const rows = await sql`
      SELECT i.id, i.doc_no, i.item_code, i.item_group, i.variants, i.qty,
             i.warehouse_id, i.line_delivery_date,
             s.status::text AS so_status, s.customer_delivery_date,
             s.customer_state, s.sales_location, s.debtor_name
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${companyId} AND i.cancelled = FALSE AND i.item_code = ${b.code}`;
    const dRows = [];
    for (const r of rows) {
      if (SO_DONE.has(snorm(r.so_status)) || num(r.qty) <= 0) continue;
      if (computeVariantKey(r.item_group, r.variants) !== b.vkey) continue;
      const whId = r.warehouse_id ?? resolveSoWarehouseId(r, whScoped, mapScoped);
      if ((whId ?? null) !== (b.whId ?? null)) continue;
      dRows.push({ ...r, whId });
    }
    const ids = dRows.map((r) => r.id);
    const del = ids.length === 0 ? [] : await sql`
      SELECT di.so_item_id, SUM(di.qty)::numeric AS delivered
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE di.so_item_id IN ${sql(ids)}
         AND UPPER(COALESCE(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
       GROUP BY di.so_item_id`;
    const ret = ids.length === 0 ? [] : await sql`
      SELECT di.so_item_id, SUM(ri.qty_returned)::numeric AS returned
        FROM scm.delivery_return_items ri
        JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id
        JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
       WHERE di.so_item_id IN ${sql(ids)}
         AND UPPER(COALESCE(r.status::text,'')) <> 'CANCELLED'
       GROUP BY di.so_item_id`;
    const dm = new Map(del.map((r) => [r.so_item_id, num(r.delivered)]));
    const rm = new Map(ret.map((r) => [r.so_item_id, num(r.returned)]));
    const eff = (r) => Math.max(0, num(r.qty) - Math.max(0, (dm.get(r.id) ?? 0) - (rm.get(r.id) ?? 0)));

    const active = dRows.filter((r) => eff(r) > 0);
    active.sort((a, x) => {
      const byDate = byDateAsc(d2(a.line_delivery_date) ?? d2(a.customer_delivery_date) ?? null,
                               d2(x.line_delivery_date) ?? d2(x.customer_delivery_date) ?? null);
      return byDate !== 0 ? byDate : String(a.doc_no).localeCompare(String(x.doc_no));
    });

    const bal = await sql`
      SELECT COALESCE(SUM(qty),0)::numeric AS qty FROM scm.inventory_balances
       WHERE company_id = ${companyId} AND item_code = ${b.code}
         AND COALESCE(variant_key,'') = ${b.vkey}
         AND ${b.whId === null ? sql`warehouse_id IS NULL` : sql`warehouse_id = ${b.whId}`}`;
    let stockLeft = num(bal[0]?.qty);

    const poRows = await sql`
      SELECT pi.qty, pi.received_qty, pi.item_group, pi.variants, pi.delivery_date,
             pi.supplier_delivery_date_2, pi.supplier_delivery_date_3, pi.supplier_delivery_date_4,
             pi.warehouse_id, po.po_number, po.status::text AS po_status, po.expected_at,
             po.supplier_delivery_date_2 AS h2, po.supplier_delivery_date_3 AS h3,
             po.supplier_delivery_date_4 AS h4, po.purchase_location_id
        FROM scm.purchase_order_items pi
        JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
       WHERE pi.company_id = ${companyId} AND pi.item_code = ${b.code}`;
    const own = [], legacy = [];
    for (const r of poRows) {
      if (PO_DEAD.has(snorm(r.po_status))) continue;
      const left = num(r.qty) - num(r.received_qty);
      if (left <= 0) continue;
      const poWh = r.warehouse_id ?? r.purchase_location_id ?? null;
      if ((poWh ?? null) !== (b.whId ?? null)) continue;
      const vk = computeVariantKey(r.item_group, r.variants);
      const eta = effectiveDelivery(d2(r.delivery_date), d2(r.supplier_delivery_date_2), d2(r.supplier_delivery_date_3), d2(r.supplier_delivery_date_4))
        ?? effectiveDelivery(d2(r.expected_at), d2(r.h2), d2(r.h3), d2(r.h4)) ?? null;
      const entry = { poNumber: r.po_number, eta, qtyLeft: left };
      if (vk === b.vkey) own.push(entry); else if (vk === "") legacy.push(entry);
    }
    /* Legacy '' pool is a FALLBACK, never additive (mrp.ts §4 R4). */
    const useLegacy = b.vkey !== "" && own.length === 0;
    const queue = [...own, ...(useLegacy ? legacy : [])].sort((a, x) => byDateAsc(a.eta, x.eta));

    notice(`  on-hand ${stockLeft}   open PO ${queue.reduce((a, p) => a + p.qtyLeft, 0)}`
      + `${useLegacy ? " (from the legacy empty-variant pool)" : ""}`
      + `   demand lines ${active.length}`);
    for (const p of queue) notice(`    PO ${p.po_number} eta ${p.eta ?? "—"} left ${p.qtyLeft}`);
    if (queue.length === 0 && legacy.length > 0) {
      notice(`    (${legacy.length} empty-variant PO line(s) exist but this bucket has its own supply, so they are not folded in)`);
    }

    for (const r of active) {
      let need = eff(r);
      const fromStock = Math.min(stockLeft, need);
      stockLeft -= fromStock; need -= fromStock;
      let po = null;
      while (need > 0 && queue.length > 0) {
        const front = queue[0];
        const take = Math.min(front.qtyLeft, need);
        if (po == null) po = front.poNumber;
        front.qtyLeft -= take; need -= take;
        if (front.qtyLeft <= 0) queue.shift();
      }
      const src = need > 0 ? `SHORT ${need}` : po != null ? `covered by PO ${po}` : "covered by STOCK";
      const mine = r.doc_no === so.doc_no ? "  <<< THIS SO" : "";
      notice(`    ${r.doc_no}  ${d2(r.line_delivery_date) ?? d2(r.customer_delivery_date) ?? "undated"}`
        + `  qty ${eff(r)}  -> ${src}${mine}`);
    }
  }

  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

try {
  await main();
} catch (e) {
  console.error(`check-mrp-so-line failed: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
