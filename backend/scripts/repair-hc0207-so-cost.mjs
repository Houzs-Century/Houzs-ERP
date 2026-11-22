// Put the right cost on SO lines stamped with the swapped OTHOREST prices (HC-0207).
//
// Sim, 2026-11-03: DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT was set up the
// wrong way round, (S) RM 550 / (SS) RM 465. The right costs are (S) RM 465 /
// (SS) RM 550. An SO line keeps the cost it was saved with, so correcting the
// supplier price does not reach them, and restamp-so-cost-from-product.mjs only
// fills 0-cost lines.
//
// WHAT THIS DOES, on live lines of orders that are not cancelled, only where the
// line still holds the swapped cost:
//   line    unit_cost_sen, line_cost_sen, line_margin_sen
//   header  mattress_sofa_cost_sen, total_cost_sen, total_margin_sen and
//           margin_pct_basis move by the difference
//   history one SO history row per order
// The cost change reaches the Venture Portal through the items trigger, as any
// corrected cost does. Selling prices, delivery orders, invoices, POs and
// AutoCount are untouched. Delivery order lines are printed, not written: their
// cost comes from stock movements.
//
// APPLY IS REFUSED until the product cost of both codes is right, that is, until
// the two 400-D001 prices are corrected. Plan runs either way.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: HC0207-SO-COST
//   COMPANY_ID     default 1
//
// RE-RUN: idempotent. A line on the right cost is not planned again.
//
// REVERSAL: swap from/to in COST_FIX and take the product check out. The SO
// history rows name every line moved.
import postgres from 'postgres';
import {
  planCosts, productsNotFixed, readDeliveryLines, readLines, readProductCosts, writeOrder,
} from './lib/hc0207-so-cost-sql.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'HC0207-SO-COST';
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}`);

  const { rows, products, deliveries } = await sql.begin('read only', async (tx) => {
    const lines = await readLines(tx, CO);
    return {
      rows: lines,
      products: await readProductCosts(tx, CO),
      deliveries: await readDeliveryLines(tx, lines.map((l) => l.item_id)),
    };
  });
  const { orders, done, other } = planCosts(rows);
  const notFixed = productsNotFixed(products);
  const lineTotal = orders.reduce((n, o) => n + o.lines.length, 0);
  const deltaTotal = orders.reduce((n, o) => n + o.deltaSen, 0);

  log('');
  log(`PLANNED: ${orders.length} order(s), ${lineTotal} line(s), total cost moves by ${rm(deltaTotal)}.`);
  for (const o of orders) {
    log(`  ${o.docNo} [${o.status}] order cost ${rm(o.deltaSen)}`);
    for (const l of o.lines) log(`    ${l.itemCode} x${l.qty}: ${rm(l.from)} -> ${rm(l.to)}`);
  }
  log(`ALREADY RIGHT: ${done.length} line(s).`);
  if (other.length) {
    log(`LEFT ALONE: ${other.length} line(s) on a cost that is neither price.`);
    for (const r of other) log(`  ${r.doc_no} ${r.item_code}: ${rm(r.unit_cost_sen)}`);
  }
  if (deliveries.length) {
    log(`NOT WRITTEN: ${deliveries.length} delivery order line(s), cost from stock movements.`);
    for (const d of deliveries) log(`  ${d.do_number} [${d.status}] ${rm(d.unit_cost_sen)}`);
  }
  log('');
  if (notFixed.length) {
    log('PRODUCT COST NOT CORRECTED YET, apply will refuse:');
    for (const m of notFixed) log(`  ${m}`);
  } else {
    log('PRODUCT COST: both codes are right.');
  }

  if (!APPLY || orders.length === 0) {
    log('');
    log(orders.length ? `PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.` : 'Nothing to change.');
    await sql.end();
    return;
  }
  if (notFixed.length) {
    await sql.end();
    console.error('Refused: correct the two 400-D001 prices first.');
    process.exit(1);
  }

  let ordersWritten = 0;
  let linesWritten = 0;
  for (const order of orders) {
    const n = await sql.begin((tx) => writeOrder(tx, {
      companyId: CO, order,
      note: `HC-0207: ${order.lines.length} line cost(s) corrected. (S) and (SS) costs were set the wrong way round when the order was saved.`,
    }));
    if (n > 0) { ordersWritten += 1; linesWritten += n; }
    if (n !== order.lines.length) log(`  ${order.docNo}: ${n} of ${order.lines.length} line(s) written (the rest moved since the read).`);
  }
  await sql.end();
  log('');
  log(`WRITTEN: ${ordersWritten} order(s), ${linesWritten} line(s).`);

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const left = planCosts(await readLines(check, CO)).orders;
  await check.end();
  log(`VERIFY (fresh connection): ${left.length} order(s) still hold a swapped cost.`);
  if (left.length) {
    for (const o of left) log(`  still swapped: ${o.docNo}`);
    process.exit(1);
  }
  log('OK — no live line holds a swapped cost.');
}

await main();
