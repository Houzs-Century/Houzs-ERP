// Unpin the line delivery dates the phone pinned by mistake (HC-0131).
//
// Sim, 2026-10-20: HC-SO-2609-081's Delivery Date was moved to 24/10 but MRP
// still planned it for 9/10. The phone's new-order screen sent every line's
// date without an override flag, so all seven lines were saved as hand-set
// (line_delivery_date_overridden = true). A hand-set line date wins over the
// header in MRP, and the HC Delivery sheet (before #4712) moved the header
// alone. HC-0118's repair only moved lines that were NOT hand-set, so it left
// these behind. From this release the phone pins only a date the operator
// moved off the header.
//
// WHAT THIS DOES, on live undelivered orders where EVERY live line is pinned
// (the phone's signature; the desktop never pins a line nobody touched) and no
// SO history row shows a person changing a line date:
//   drifted  every line holds one date that is not the header's
//            -> the lines take the header date and are unpinned
//   mirrors  every line already holds the header date
//            -> the lines are unpinned, so the delivery board's amended date
//               reaches MRP
// One SO history row per order. Lines on a live delivery order / invoice, the
// header, PO lines, delivery orders and AutoCount are untouched.
//
// WHAT IT LEAVES ALONE AND NAMES: an all-pinned order whose lines hold more
// than one date (some may be a real per-line date).
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        required on apply: HC0131-PINNED-LINE-DATES
//   COMPANY_ID     default 1 (2 = 2990, same phone screen)
//   DOCS           optional, comma-separated order numbers to limit the run to
//   SCOPE          drifted | all (default all): drifted leaves the mirrors alone
//
// RE-RUN: idempotent. An unpinned line is not read again.
import postgres from 'postgres';
import { planPinned, readPinned, writeOrder } from './lib/hc0131-pinned-line-date-sql.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'HC0131-PINNED-LINE-DATES';
const CO = Number(process.env.COMPANY_ID ?? 1);
const DOCS = (process.env.DOCS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SCOPE = (process.env.SCOPE ?? 'all').toLowerCase();
if (SCOPE !== 'all' && SCOPE !== 'drifted') { console.error('SCOPE must be drifted or all'); process.exit(2); }
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE}`);
  process.exit(2);
}

const lineCount = (orders) => orders.reduce((n, o) => n + o.lines.length, 0);

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO} scope=${SCOPE}${DOCS.length ? ` docs=${DOCS.join(',')}` : ' (every live order)'}`);

  const rows = await sql.begin('read only', (tx) => readPinned(tx, CO, DOCS.length ? DOCS : null));
  const { drifted, mirrors, mixed } = planPinned(rows);

  log('');
  log(`DRIFTED: ${drifted.length} order(s), ${lineCount(drifted)} line(s) take the header Delivery Date and are unpinned.`);
  for (const o of drifted) log(`  ${o.docNo} [${o.status}] ${o.from} -> ${o.to}: ${o.lines.map((l) => l.itemCode).join(', ')}`);
  log('');
  log(`MIRRORS: ${mirrors.length} order(s), ${lineCount(mirrors)} line(s) already on the header date, unpinned only${SCOPE === 'drifted' ? ' (skipped, SCOPE=drifted)' : ''}.`);
  for (const o of mirrors) log(`  ${o.docNo} [${o.status}] ${o.to}: ${o.lines.length} line(s)`);
  if (mixed.length) {
    log('');
    log(`LEFT ALONE: ${mixed.length} all-pinned order(s) whose lines hold more than one date.`);
    for (const o of mixed) log(`  ${o.docNo} [${o.status}] header ${o.to}: ${o.lines.map((l) => `${l.itemCode}=${l.from}`).join(', ')}`);
  }

  const planned = SCOPE === 'drifted' ? drifted : [...drifted, ...mirrors];
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
      note: order.from === order.to
        ? `HC-0131: ${order.lines.length} line(s) no longer hand-set; they follow the order's Delivery Date. `
          + 'The phone saved them as hand-set when the order was created.'
        : `HC-0131: ${order.lines.length} line delivery date(s) ${order.from} -> ${order.to}, the order's Delivery Date, and no longer hand-set. `
          + 'The phone saved them as hand-set when the order was created, so the moved Delivery Date never reached them.',
    }));
    if (n > 0) { ordersWritten += 1; linesWritten += n; }
    if (n !== order.lines.length) log(`  ${order.docNo}: ${n} of ${order.lines.length} line(s) written (the rest moved since the read).`);
  }
  await sql.end();
  log('');
  log(`WRITTEN: ${ordersWritten} order(s), ${linesWritten} line(s).`);

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const left = await check`
    SELECT i.doc_no FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no AND so.company_id = ${CO}
     WHERE i.id = ANY(${planned.flatMap((o) => o.lines.map((l) => l.id))}::uuid[])
       AND (i.line_delivery_date_overridden IS TRUE OR i.line_delivery_date <> so.customer_delivery_date)`;
  await check.end();
  const leftDocs = [...new Set(left.map((r) => r.doc_no))];
  log(`VERIFY (fresh connection): ${leftDocs.length} of the planned order(s) still have a pinned or off-header line.`);
  if (leftDocs.length) {
    for (const d of leftDocs) log(`  still pinned: ${d}`);
    process.exit(1);
  }
  log('OK — every planned line follows its header Delivery Date.');
}

await main();
