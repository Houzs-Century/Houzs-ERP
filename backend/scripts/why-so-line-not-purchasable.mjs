#!/usr/bin/env node
// READ-ONLY. Why a sales-order line does not appear in the PO-from-SO picker.
//
// THE OWNER'S QUESTION, 2026-08-16: `HC-SO-2608-003` is CONFIRMED, its bedframe
// line shows STOCK: PENDING and no incoming PO, and yet the line is in neither
// the MRP shortage list nor "Pick Sales Orders for this PO". Those two read the
// SAME computation (`GET /outstanding-so-items` calls `computeMrp`), so the line
// is being lost at one of exactly two places:
//
//   A. BEFORE the shortage step — the demand query drops it (cancelled, a
//      terminal SO status, qty 0, no item_code), or the resolved warehouse /
//      variant key puts it in a bucket nobody is looking at.
//   B. AT the shortage step — the pooled allocation covers it from stock or an
//      open PO, so shortage is 0 and it correctly drops off.
//
// Those two have different fixes and this script tells them apart. It DOES NOT
// replicate the allocation — audit-mrp-pairing.mjs already does that and warns
// in its own header that a replica can drift. This one only prints the INPUTS,
// which is the half a replica cannot get wrong.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
//
// RE-RUN: idempotent and side-effect free. Run it as often as you like.
//
//   DOC_NO=HC-SO-2608-003 node backend/scripts/why-so-line-not-purchasable.mjs
//
// ENUM TRAP (inherited from the other audits here): status columns are ENUMS,
// so COALESCE(col,'') coerces '' INTO the enum and throws. Always ::text first.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }
/* Default is the order the owner asked about; any doc number may be passed. */
const DOC_NO = process.env.DOC_NO || 'HC-SO-2608-003';
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);


/**
 * The outbox rows for a document, newest first, with what each one CARRIED.
 *
 * Its own function because it is the only section that works for a document
 * that is not a sales order, and the first one that needed that was a delivery
 * order the service refused.
 */
async function dumpOutbox() {
  console.log('');
  notice('D — the outbox rows for this document, newest first, with what each carried');
  const rows = await sql`
    SELECT id, op, status::text AS status, attempts, created_at, sent_at, last_error, payload
    FROM scm.autocount_outbox
    WHERE doc_no = ${DOC_NO} AND company_id = ${COMPANY_ID}
    ORDER BY created_at DESC LIMIT 8`;
  notice(`  ${rows.length} row(s)`);
  for (const r of rows) {
    notice(`  --- ${r.op} ${r.status} attempts=${r.attempts} created=${r.created_at?.toISOString?.() ?? r.created_at} sent=${r.sent_at?.toISOString?.() ?? '(never)'}`);
    if (r.last_error) notice(`      error: ${String(r.last_error).slice(0, 220)}`);
    const body = r.payload?.body ?? null;
    if (!body) { notice('      body: (none)'); continue; }
    /* The HEADER is where PDate / BALANCE / PAYEMENT live on an edit; a create
       carries them at the top level. Print whichever shape this row has. */
    const h = body.Header ?? body;
    const udf = h.UDF ?? null;
    notice(`      UDF: ${udf ? JSON.stringify(udf) : '(no UDF key — nothing sent, the book keeps its own)'}`);
    const keys = Object.keys(h).filter((k) => k !== 'UDF' && k !== 'Details' && k !== 'Lines');
    notice(`      header keys: ${keys.join(', ') || '(none)'}`);
    const lines = body.Lines ?? body.Details ?? [];
    for (const l of lines.slice(0, 4)) {
      notice(`      line: ${JSON.stringify(l).slice(0, 200)}`);
    }
  }

}

async function main() {
  notice(`doc ${DOC_NO}, company ${COMPANY_ID} — READ ONLY`);

  const [header] = await sql`
    SELECT doc_no, status::text AS status, sales_location, customer_state,
           customer_delivery_date, processing_date, company_id, linked_ac_docno
    FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO} AND company_id = ${COMPANY_ID}`;
  /* NOT AN EARLY RETURN ANY MORE. Section D reads the OUTBOX, which is keyed by
     doc_no for every document type, and the one document that most needed it —
     HC-DO-2608-001, refused by AutoCount with `Invalid transfer item.` — is a
     DELIVERY ORDER, so the sales-order header read above finds nothing and the
     probe used to stop right before the only section that could help. */
  if (!header) {
    notice(`not a sales order in company ${COMPANY_ID} — skipping A/B/C, going straight to the outbox`);
    await dumpOutbox();
    return;
  }
  notice(`header: status=${header.status} salesLocation=${header.sales_location ?? '(null)'} `
    + `state=${header.customer_state ?? '(null)'} deliveryDate=${header.customer_delivery_date ?? '(null)'} `
    + `processingDate=${header.processing_date ?? '(null)'} linkedAc=${header.linked_ac_docno ?? '(none)'}`);

  const lines = await sql`
    SELECT id, line_no, item_code, item_group, description, description2,
           qty, cancelled, warehouse_id, line_delivery_date, variants
    FROM scm.mfg_sales_order_items
    WHERE doc_no = ${DOC_NO} ORDER BY line_no`;
  notice(`${lines.length} line(s)`);

  console.log('');
  console.log(`${pad('LINE', 5)} ${pad('ITEM', 22)} ${pad('GROUP', 10)} ${pad('QTY', 5)} `
    + `${pad('CANC', 5)} ${pad('WAREHOUSE_ID', 38)} ${pad('LINE_DELIV', 12)}`);
  for (const l of lines) {
    console.log(`${pad(l.line_no, 5)} ${pad(l.item_code, 22)} ${pad(l.item_group, 10)} ${pad(l.qty, 5)} `
      + `${pad(l.cancelled, 5)} ${pad(l.warehouse_id ?? '(NULL)', 38)} ${pad(l.line_delivery_date ?? '(NULL)', 12)}`);
    console.log(`      desc2=${l.description2 ?? '(null)'}`);
    console.log(`      variants=${l.variants == null ? '(null)' : JSON.stringify(l.variants)}`);
  }

  /* THE FOUR GATES THE DEMAND QUERY APPLIES, checked one at a time so the
     answer names the gate rather than saying "not there". Ported from
     mrp.ts's demand select: cancelled = false, so.status NOT IN terminal,
     item_code present, qty > 0. */
  console.log('');
  notice('A — would the DEMAND query keep each line?');
  const TERMINAL = ['CANCELLED', 'CLOSED', 'DELIVERED', 'INVOICED'];
  for (const l of lines) {
    const reasons = [];
    if (l.cancelled) reasons.push('line cancelled');
    if (TERMINAL.includes(header.status)) reasons.push(`SO status ${header.status} is terminal`);
    if (!l.item_code) reasons.push('no item_code');
    if (Number(l.qty) <= 0) reasons.push('qty <= 0');
    notice(`  line ${l.line_no} ${l.item_code}: ${reasons.length ? `DROPPED — ${reasons.join('; ')}` : 'kept'}`);
  }

  /* B — what the allocation would be drawing on. Stock and open PO supply for
     the same product, printed WITHOUT judging: if both are zero and the line is
     still absent from the picker, the loss is in (A) or in the bucket key, not
     in coverage. */
  console.log('');
  notice('B — what supply exists for these products');
  for (const l of lines) {
    if (!l.item_code) continue;
    const stock = await sql`
      SELECT COALESCE(SUM(qty), 0) AS qty
      FROM scm.inventory_balances
      WHERE product_code = ${l.item_code} AND company_id = ${COMPANY_ID}`;
    const openPo = await sql`
      SELECT COALESCE(SUM(poi.qty - COALESCE(poi.received_qty, 0)), 0) AS qty
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
      WHERE poi.material_code = ${l.item_code}
        AND po.company_id = ${COMPANY_ID}
        AND po.status::text NOT IN ('DRAFT', 'CANCELLED', 'CLOSED')`;
    const picked = await sql`
      SELECT COALESCE(SUM(qty), 0) AS qty
      FROM scm.purchase_order_items WHERE so_item_id = ${l.id}`;
    notice(`  ${l.item_code}: stock=${stock[0].qty} openPoSupply=${openPo[0].qty} alreadyPickedForThisLine=${picked[0].qty}`);
  }

  /* The one fact that decides whether the line can be TRANSFERRED to a PO in
     AutoCount rather than merely purchased — see po-transfer-shape.ts. Printed
     here because the owner asks both questions about the same line. */
  console.log('');
  notice('C — AutoCount line identity (decides SO-to-PO transfer, not the picker)');
  const keys = await sql`
    SELECT line_no, item_code, linked_ac_dtlkey
    FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC_NO} ORDER BY line_no`;
  for (const k of keys) {
    notice(`  line ${k.line_no} ${k.item_code}: linked_ac_dtlkey=${k.linked_ac_dtlkey ?? '(NULL — cannot be transferred)'}`);
  }

  /* D — WHAT WE ACTUALLY SENT. The queue saying `sent` only means AutoCount
     accepted the call; it says nothing about what was IN it. Three fields on
     HC-SO-2608-002 disagree with the ERP after an edit that the queue reports as
     sent, and the payload is the only place that separates "we sent the wrong
     thing" from "we sent the right thing and the service dropped it". */
  await dumpOutbox();

  console.log('');
  notice('READ THE RESULT LIKE THIS:');
  notice('  a line DROPPED in (A) -> the demand query never saw it; fix the named gate');
  notice('  kept in (A), and (B) shows stock or open PO >= qty -> shortage 0, correctly hidden');
  notice('  kept in (A), and (B) is all zeros -> the loss is the bucket key or the allocation; that is a bug');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
