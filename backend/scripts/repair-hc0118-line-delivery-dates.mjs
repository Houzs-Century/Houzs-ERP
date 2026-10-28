// Put Sales Order line delivery dates back in step with the header (HC-0118).
//
// Syu, 2026-10-17: HC-SO-012526 (ZNT6493) had its Delivery Date moved to 30/10
// but every line still said 15/09. The HC Delivery sheet's write-back
// (POST /api/delivery-sheet/updates) moved the header alone; the SO editor's
// header save moves the lines with it. From this release the sheet moves them
// too (updateFromSheetSql). This catches up the orders the old write-back left
// behind, including the sheet's daily Overdue push to today+3.
//
// WHAT THIS DOES: on live undelivered orders, a line that is not hand-set, not
// blank, not cancelled and not on a live delivery order / invoice, whose date
// differs from the header's Delivery Date, takes the header date. One SO
// history row per order. The header, the flags, PO lines, delivery orders and
// AutoCount are untouched.
//
// WHAT IT LEAVES ALONE AND NAMES: an order whose drifted lines hold more than
// one date. That is not the header-moved-alone shape (it can be a book order
// imported with mixed line dates), so it is listed for a person to look at.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: HC0118-LINE-DELIVERY-DATES
//   COMPANY_ID     default 1 (2 = 2990, whose sheet rows write back the same way)
//   DOCS           optional, comma-separated order numbers to limit the run to
//
// RE-RUN: idempotent. A repaired line mirrors the header and is not read again.
import postgres from 'postgres';
import { planDrift, readDrift, writeOrder } from './lib/hc0118-line-delivery-date-sql.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'HC0118-LINE-DELIVERY-DATES';
const CO = Number(process.env.COMPANY_ID ?? 1);
const DOCS = (process.env.DOCS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}${DOCS.length ? ` docs=${DOCS.join(',')}` : ' (every live order)'}`);

  const rows = await sql.begin('read only', (tx) => readDrift(tx, CO, DOCS.length ? DOCS : null));
  const { planned, mixed } = planDrift(rows);
  const lineCount = planned.reduce((n, o) => n + o.lines.length, 0);

  log('');
  log(`PLAN: ${planned.length} order(s), ${lineCount} line(s) move to the header Delivery Date.`);
  for (const o of planned) {
    log(`  ${o.docNo} [${o.status}] ${o.from} -> ${o.to}: ${o.lines.map((l) => l.itemCode).join(', ')}`);
  }
  if (mixed.length) {
    log('');
    log(`LEFT ALONE: ${mixed.length} order(s) whose drifted lines hold more than one date.`);
    for (const o of mixed) {
      log(`  ${o.docNo} [${o.status}] header ${o.to}: ${o.lines.map((l) => `${l.itemCode}=${l.from}`).join(', ')}`);
    }
  }

  if (!APPLY || planned.length === 0) {
    log('');
    log(planned.length ? `PLAN ONLY — set MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.` : 'Nothing to change.');
    await sql.end();
    return;
  }

  let ordersWritten = 0;
  let linesWritten = 0;
  for (const order of planned) {
    const n = await sql.begin((tx) => writeOrder(tx, {
      companyId: CO, order,
      note: `HC-0118: ${order.lines.length} line delivery date(s) ${order.from} -> ${order.to}, the order's Delivery Date. `
        + 'The HC Delivery sheet had moved the header without its lines.',
    }));
    if (n > 0) { ordersWritten += 1; linesWritten += n; }
    if (n !== order.lines.length) log(`  ${order.docNo}: ${n} of ${order.lines.length} line(s) written (the rest moved since the read).`);
  }
  await sql.end();
  log('');
  log(`WRITTEN: ${ordersWritten} order(s), ${linesWritten} line(s).`);

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = planDrift(await check.begin('read only', (tx) => readDrift(tx, CO, planned.map((o) => o.docNo))));
  await check.end();
  log(`VERIFY (fresh connection): ${after.planned.length} of the planned order(s) still drifted.`);
  if (after.planned.length) {
    for (const o of after.planned) log(`  still drifted: ${o.docNo}`);
    process.exit(1);
  }
  log('OK — every planned line mirrors its header Delivery Date.');
}

await main();
