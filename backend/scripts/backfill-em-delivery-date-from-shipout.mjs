#!/usr/bin/env node
/* Backfill the Delivery Planning "Delivery Date" (amended_delivery_date) for
   East-Malaysia orders that have already shipped out but never had a delivery
   date set on the board (owner 2026-11-20).

   THE SHAPE. An EM (Sabah / Sarawak) order ships from KL on a Delivery Order;
   its DO date is the "shipout date". For 73 such orders the board's Delivery
   Date column (mfg_sales_orders.amended_delivery_date) is still blank, so the
   board cannot group or plan them by date. The owner wants that column filled
   with the order's shipout date. The customer's ORIGINAL request date
   (customer_delivery_date) is never touched — the board treats amended_delivery_date
   as the firm/confirmed date and derives delivery_state live from it, so setting
   this one column is all that is needed.

   SOURCE. The shipout date comes from the ERP itself — MAX(do_date) over the
   order's non-DRAFT/CANCELLED Delivery Orders — not from any sheet, so the
   result does not depend on a sheet's date formatting.

   SCOPE. company_id = 1 (HOUZS), East sales_location (SBH / SRW WAREHOUSE — the
   only two East spellings in prod), live order (not DRAFT/CANCELLED), has a
   shipout DO date, and amended_delivery_date IS NULL (never overwrite an
   existing date). ONLY_DONE_SHIPOUT=1 narrows further to the orders whose board
   status (delivery_message_status) is exactly "Done Shipout".

   MODE=plan (default) lists every order it would touch and the date it would
   write, and writes NOTHING. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN",
   writes one order at a time (each guarded by amended_delivery_date IS NULL so a
   concurrent edit is never clobbered), then re-reads on a FRESH connection and
   fails if any in-scope order is still blank.

   RE-RUN: inert. Keyed on amended_delivery_date IS NULL — once an order is
   filled it is no longer a candidate.

   REVERSAL: the apply run prints the exact doc_nos it set; every one was NULL
   before, so the reversal is
     UPDATE scm.mfg_sales_orders SET amended_delivery_date = NULL
      WHERE company_id = 1 AND doc_no IN (<those doc_nos>); */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === '1' || (process.env.MODE || 'plan') === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_DONE_SHIPOUT = /^(1|true|yes)$/i.test(process.env.ONLY_DONE_SHIPOUT || '');
const COMPANY_ID = 1;
// The only East (Sabah / Sarawak) sales_location spellings company 1 uses.
const EAST = ['SBH WAREHOUSE', 'SRW WAREHOUSE'];

function fail(msg, code = 1) { console.error(`ERROR: ${msg}`); process.exit(code); }

async function candidates(sql) {
  return sql`
    SELECT so.doc_no, so.debtor_name, so.delivery_message_status AS board_status,
           (SELECT MAX(d.do_date) FROM scm.delivery_orders d
             WHERE d.so_doc_no = so.doc_no
               AND upper(COALESCE(d.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')) AS shipout_date
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${COMPANY_ID}
       AND so.status::text NOT IN ('DRAFT', 'CANCELLED')
       AND upper(btrim(COALESCE(so.sales_location, ''))) = ANY(${EAST})
       AND so.amended_delivery_date IS NULL
       ${ONLY_DONE_SHIPOUT ? sql`AND so.delivery_message_status = 'Done Shipout'` : sql``}
     ORDER BY so.doc_no`;
}

async function main() {
  if (!DSN) fail('DATABASE_URL is not set', 2);
  console.log(`Backfill EM Delivery Date from shipout — MODE=${APPLY ? 'apply' : 'plan'}${ONLY_DONE_SHIPOUT ? ' ONLY_DONE_SHIPOUT=1' : ''}`);

  const sql = postgres(DSN, { max: 1, prepare: false });
  try {
    const rows = await candidates(sql);
    const toWrite = rows.filter((r) => r.shipout_date != null);
    const noShipout = rows.length - toWrite.length;

    console.log(`\nCandidates (amended_delivery_date blank, East, live): ${rows.length}`);
    if (noShipout) console.log(`  ${noShipout} have no shipout DO yet — skipped (nothing to write).`);
    console.log(`  ${toWrite.length} will get amended_delivery_date = their shipout date:\n`);
    for (const r of toWrite) {
      const d = String(r.shipout_date).slice(0, 10);
      console.log(`  ${r.doc_no}  ${d}  [${r.board_status || '(blank status)'}]  ${r.debtor_name || ''}`);
    }

    if (!APPLY) {
      console.log(`\nplan only — nothing written. Re-run with MODE=apply and CONFIRM to write ${toWrite.length} row(s).`);
      return;
    }
    if (process.env.CONFIRM !== CONFIRM_PHRASE) {
      fail(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
    }
    if (toWrite.length === 0) {
      console.log('\nNothing to write. Done.');
      return;
    }

    let written = 0;
    for (const r of toWrite) {
      const res = await sql`
        UPDATE scm.mfg_sales_orders
           SET amended_delivery_date = ${String(r.shipout_date).slice(0, 10)}::date
         WHERE doc_no = ${r.doc_no}
           AND company_id = ${COMPANY_ID}
           AND amended_delivery_date IS NULL`;
      written += res.count;
    }
    console.log(`\nWrote ${written} row(s).`);
    console.log('REVERSAL doc_nos: ' + toWrite.map((r) => r.doc_no).join(','));

    // Shape re-read on a FRESH connection: no in-scope order may still be blank.
    const check = postgres(DSN, { max: 1, prepare: false });
    try {
      const left = await candidates(check);
      const stillBlank = left.filter((r) => r.shipout_date != null);
      if (stillBlank.length) {
        fail(`${stillBlank.length} in-scope order(s) still blank after apply: ${stillBlank.map((r) => r.doc_no).join(', ')}`, 3);
      }
      console.log('Re-read OK — no in-scope order left blank.');
    } finally {
      await check.end();
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => fail(e instanceof Error ? e.stack || e.message : String(e), 1));
