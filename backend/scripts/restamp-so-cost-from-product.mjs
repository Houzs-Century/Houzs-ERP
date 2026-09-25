/* Restamp SO line cost from the CURRENT product cost, for lines that carry none.

   WHY. SO line costs are SNAPSHOTTED at save time. When a product had no cost
   then, the line stored unit_cost_sen = 0 and the Sales Report shows a kosong
   gap (and a fake 100% margin). Filling the cost in Product Maintenance later
   does NOT move those snapshots. Owner 2026-09-25: once the product cost lands,
   the report's 0-cost lines must fill too. This restamps them from the cost the
   product carries NOW (not as-of the order date — the point is to fill a gap
   that was 0 only because no cost existed then).

   IT CHANGES HISTORICAL MARGIN for the touched orders: from an overstated
   100% (cost 0) down to the real figure (revenue - real cost). That is the
   intended correction.

   WHAT IT TOUCHES. Only lines with unit_cost_sen = 0/NULL whose product now
   carries a cost, and only headers whose total_cost_sen = 0. A non-zero stamp is
   never touched. Per line the cost is:
     SOFA   seat grid PRICE_2 at the ordered height (variants.seatHeight)
            -> base_price_sen -> cost_price_sen
     other  base_price_sen -> cost_price_sen
   line_cost = unit x qty; then the header's category aggregates + total_cost +
   margin (revenue - cost) are recomputed. This mirrors restamp-imported-so-costs
   (the company-1 import stamp) but works for any company and is release-safe.

   MODE=plan (default) reports what it WOULD stamp, per company, incl. the total
   margin reduction, and writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one SO per short transaction
   (deadlock-retried), prints every touched line id + header doc_no for reversal,
   then RE-READS on a fresh connection and asserts no target line still reads 0
   where its product has a cost.

   REVERSAL: the printed lines/headers were all 0 before, so restore with
     UPDATE scm.mfg_sales_order_items SET unit_cost_sen=0, line_cost_sen=0 WHERE id IN (<printed ids>);
     UPDATE scm.mfg_sales_orders SET mattress_sofa_cost_sen=0, bedframe_cost_sen=0,
       accessories_cost_sen=0, service_cost_sen=0, others_cost_sen=0, total_cost_sen=0,
       total_margin_sen=total_revenue_sen WHERE doc_no IN (<printed doc_nos>);

   Env: DATABASE_URL (required); COMPANY (optional, default = every company with
   zero-cost SO lines); LIST_LIMIT (touched doc_nos to print in plan, default 40).

   RE-RUN: idempotent — value-guarded on unit_cost_sen = 0, so a second run
   stamps nothing (every gap the products can fill is already filled). */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 40;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => (Number(sen || 0) / 100).toFixed(2);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const CAT_COL = {
  MATTRESS: 'mattress_sofa', SOFA: 'mattress_sofa', BEDFRAME: 'bedframe',
  ACCESSORY: 'accessories', SERVICE: 'service',
};

/** The product cost for one line, current (not as-of). SOFA reads the seat grid
 *  PRICE_2 cost at the ordered height; everything else the flat cost lane. */
function unitCostSen(p, variants) {
  if (!p) return 0;
  const cat = String(p.category || '').toUpperCase();
  if (cat === 'SOFA' && Array.isArray(p.seat_height_prices)) {
    const h = variants?.seatHeight ?? variants?.seat_height ?? null;
    if (h != null) {
      const hh = String(h).replace(/"/g, '');
      const hit = p.seat_height_prices.find(
        (e) => String(e.height) === hh && (e.tier ?? 'PRICE_2') === 'PRICE_2' && Number(e.priceSen) > 0,
      );
      if (hit) return Number(hit.priceSen);
    }
  }
  return Number(p.base_price_sen) || Number(p.cost_price_sen) || 0;
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const companies = ONLY_COMPANY != null
    ? [ONLY_COMPANY]
    : (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => Number(r.company_id));

  const touchedLineIds = [];
  const touchedDocNos = [];
  let grandStamp = 0, grandNoCost = 0, grandHeaders = 0, grandMarginDrop = 0, grandDeadlocks = 0;

  for (const co of companies) {
    const prods = await sql`SELECT code, category, base_price_sen, cost_price_sen, seat_height_prices
                            FROM scm.mfg_products WHERE company_id = ${co}`;
    const prodBy = new Map(prods.map((p) => [p.code, p]));

    const sos = await sql`SELECT doc_no, total_revenue_sen, total_cost_sen
                          FROM scm.mfg_sales_orders
                          WHERE company_id = ${co} AND coalesce(total_cost_sen,0) = 0
                          ORDER BY doc_no`;

    let stamped = 0, noCost = 0, headers = 0, marginDrop = 0, deadlocks = 0;
    const now = new Date().toISOString();
    const shownDocs = [];

    for (const so of sos) {
      const plan = { lineWrites: [], agg: { mattress_sofa: 0, bedframe: 0, accessories: 0, service: 0, others: 0 }, anyStamp: false };
      const lines = await sql`SELECT id, item_code, qty, variants, unit_cost_sen
                              FROM scm.mfg_sales_order_items
                              WHERE company_id = ${co} AND doc_no = ${so.doc_no}`;
      for (const l of lines) {
        let uc = Number(l.unit_cost_sen) || 0;
        if (uc === 0) {
          const p = prodBy.get(l.item_code);
          uc = unitCostSen(p, l.variants);
          if (uc > 0) { plan.anyStamp = true; stamped++; plan.lineWrites.push({ id: l.id, uc, qty: l.qty || 1 }); }
          else noCost++;
        }
        const p = prodBy.get(l.item_code);
        const col = CAT_COL[String(p?.category || '').toUpperCase()] || 'others';
        plan.agg[col] += uc * (l.qty || 1);
      }
      const total = plan.agg.mattress_sofa + plan.agg.bedframe + plan.agg.accessories + plan.agg.service + plan.agg.others;
      const willHeader = Number(so.total_cost_sen) === 0 && total > 0;
      if (willHeader) { headers++; marginDrop += total; if (shownDocs.length < LIST_LIMIT) shownDocs.push(`${so.doc_no} (cost ${rm(total)})`); }
      if (plan.anyStamp) for (const w of plan.lineWrites) touchedLineIds.push(w.id);
      if (willHeader) touchedDocNos.push(so.doc_no);

      if (APPLY && (plan.anyStamp || willHeader)) {
        const runOne = async (tx) => {
          for (const w of plan.lineWrites) {
            await tx`UPDATE scm.mfg_sales_order_items SET unit_cost_sen = ${w.uc}, line_cost_sen = ${w.uc * w.qty}
                     WHERE id = ${w.id} AND coalesce(unit_cost_sen,0) = 0`;
          }
          if (willHeader) {
            await tx`UPDATE scm.mfg_sales_orders SET
                mattress_sofa_cost_sen = ${plan.agg.mattress_sofa}, bedframe_cost_sen = ${plan.agg.bedframe},
                accessories_cost_sen = ${plan.agg.accessories}, service_cost_sen = ${plan.agg.service},
                others_cost_sen = ${plan.agg.others}, total_cost_sen = ${total},
                total_margin_sen = ${(Number(so.total_revenue_sen) || 0) - total}, updated_at = ${now}
              WHERE doc_no = ${so.doc_no} AND company_id = ${co} AND coalesce(total_cost_sen,0) = 0`;
          }
        };
        let attempts = 0;
        for (;;) {
          try { await sql.begin(runOne); break; }
          catch (e) {
            if (/deadlock detected/i.test(e.message) && ++attempts <= 3) { deadlocks++; await new Promise((r) => setTimeout(r, 250 * attempts)); continue; }
            throw e;
          }
        }
      }
    }

    note(`===== Company ${co} =====`);
    note(`zero-cost headers: ${sos.length}; lines to stamp: ${stamped}; product-has-no-cost: ${noCost}; headers to fill: ${headers}; margin reduction: RM ${rm(marginDrop)}`);
    shownDocs.forEach((d) => note(`  ${d}`));
    if (headers > shownDocs.length) note(`  ... ${headers - shownDocs.length} more.`);
    grandStamp += stamped; grandNoCost += noCost; grandHeaders += headers; grandMarginDrop += marginDrop; grandDeadlocks += deadlocks;
  }

  if (!APPLY) {
    note(`DRY-RUN total: ${grandStamp} line(s) across ${grandHeaders} order(s) would be stamped; total margin reduction RM ${rm(grandMarginDrop)}. ${grandNoCost} line(s) still have no product cost. Nothing written.`);
    await sql.end();
    return;
  }

  note(`APPLIED: ${grandStamp} lines stamped across ${grandHeaders} orders; margin reduced by RM ${rm(grandMarginDrop)}; deadlock-retries ${grandDeadlocks}.`);
  note(`Touched line ids (${touchedLineIds.length}) — REVERSAL source:`);
  touchedLineIds.forEach((id) => note(`  L ${id}`));
  note(`Touched header doc_nos (${touchedDocNos.length}):`);
  touchedDocNos.forEach((d) => note(`  H ${d}`));

  // Fresh-connection invariant: no line still reads 0 where its product has a cost.
  await sql.end();
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let remaining = 0;
  for (const co of companies) {
    const prods = await check`SELECT code, category, base_price_sen, cost_price_sen, seat_height_prices
                              FROM scm.mfg_products WHERE company_id = ${co}`;
    const prodBy = new Map(prods.map((p) => [p.code, p]));
    const zeros = await check`SELECT id, item_code, variants FROM scm.mfg_sales_order_items
                              WHERE company_id = ${co} AND coalesce(unit_cost_sen,0) = 0`;
    for (const z of zeros) if (unitCostSen(prodBy.get(z.item_code), z.variants) > 0) remaining++;
  }
  await check.end();
  if (remaining > 0) { bad(`INVARIANT FAILED: ${remaining} line(s) still read 0 though their product has a cost.`); process.exit(1); }
  note(`Invariant holds on a fresh connection: every fillable line now carries a cost.`);
}

main().catch((e) => { bad(e instanceof Error ? e.message : String(e)); process.exit(1); });
