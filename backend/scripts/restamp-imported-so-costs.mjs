// Stamp costs onto imported SO lines that carry none (owner 2026-08-09:
// "SO 开了可是 costing 没 read 到").
//
// SO line costs are stamped at creation time; the AutoCount cutover imported
// 2,275 orders BEFORE this week's costing landed (and without computing
// costs), so every line carries unit_cost_centi = 0 and the list's category
// cost columns (header aggregates) read 0.
//
// For HOUZS lines with unit_cost_centi = 0 whose product now carries a cost:
//   SOFA      resolve seat grid (variants.seatHeight, tier PRICE_2 default)
//             -> else base_price_sen -> else cost_price_sen
//   BEDFRAME  base_price_sen -> cost_price_sen (PRICE_2 lane)
//   other     base_price_sen -> cost_price_sen
// line_cost = unit x qty. Then, for headers whose total_cost_centi = 0,
// recompute the category aggregates + total + margin (= revenue - cost).
// Never touches a non-zero stamp. DRY-RUN default; APPLY=1 writes.
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const CAT_COL = {
  MATTRESS: "mattress_sofa", SOFA: "mattress_sofa", BEDFRAME: "bedframe",
  ACCESSORY: "accessories", SERVICE: "service",
};

function unitCost(p, variants) {
  const cat = (p.category || "").toUpperCase();
  if (cat === "SOFA" && Array.isArray(p.seat_height_prices)) {
    const h = variants?.seatHeight ?? variants?.seat_height ?? null;
    const grid = p.seat_height_prices;
    const pick = (hh, tt) => grid.find((e) => e.height === hh && (e.tier ?? "PRICE_2") === tt && e.priceSen > 0)?.priceSen;
    const v = (h && (pick(String(h).replace('"', ""), "PRICE_2"))) || null;
    if (v) return v;
  }
  return p.base_price_sen || p.cost_price_sen || 0;
}

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const prods = await sql`SELECT code, category, base_price_sen, cost_price_sen, seat_height_prices
                          FROM scm.mfg_products WHERE company_id = ${cid}`;
  const prodBy = new Map(prods.map((p) => [p.code, p]));

  const sos = await sql`SELECT doc_no, total_revenue_centi, total_cost_centi FROM scm.mfg_sales_orders
                        WHERE company_id = ${cid} AND total_cost_centi = 0`;
  note(`SO headers with zero total cost: ${sos.length}`);
  let stamped = 0, noCost = 0, headers = 0;
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    for (const so of sos) {
      const lines = await tx`SELECT id, item_code, qty, variants, unit_cost_centi FROM scm.mfg_sales_order_items WHERE company_id = ${cid} AND doc_no = ${so.doc_no}`;
      const agg = { mattress_sofa: 0, bedframe: 0, accessories: 0, service: 0, others: 0 };
      let anyStamp = false;
      for (const l of lines) {
        let uc = l.unit_cost_centi || 0;
        if (uc === 0) {
          const p = prodBy.get(l.item_code);
          uc = p ? unitCost(p, l.variants) : 0;
          if (uc > 0) {
            anyStamp = true; stamped++;
            if (APPLY) await tx`UPDATE scm.mfg_sales_order_items
              SET unit_cost_centi = ${uc}, line_cost_centi = ${uc * (l.qty || 1)}
              WHERE id = ${l.id}`;  // items table has created_at only
          } else noCost++;
        }
        const p = prodBy.get(l.item_code);
        const col = CAT_COL[(p?.category || "").toUpperCase()] || "others";
        agg[col] += uc * (l.qty || 1);
      }
      const total = agg.mattress_sofa + agg.bedframe + agg.accessories + agg.service + agg.others;
      if ((anyStamp || total > 0) && so.total_cost_centi === 0 && total > 0) {
        headers++;
        if (APPLY) await tx`UPDATE scm.mfg_sales_orders SET
            mattress_sofa_cost_centi = ${agg.mattress_sofa}, bedframe_cost_centi = ${agg.bedframe},
            accessories_cost_centi = ${agg.accessories}, service_cost_centi = ${agg.service},
            others_cost_centi = ${agg.others}, total_cost_centi = ${total},
            total_margin_centi = ${(so.total_revenue_centi || 0) - total}, updated_at = ${now}
          WHERE doc_no = ${so.doc_no}`;
      }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: lines stamped ${stamped}, product-has-no-cost ${noCost}, headers updated ${headers}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
