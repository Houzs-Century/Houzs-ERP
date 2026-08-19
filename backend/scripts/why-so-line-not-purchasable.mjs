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
// SECTIONS D AND E ARE NOT ABOUT THE PICKER, and they work for any document
// type. D prints the outbox rows and, for a conversion, the VALUES of the three
// fields the transfer is decided by — DtlKeys, FromDocType, and the FromDocNo
// dispatchOne resolves at drain from the parent. E then traces every one of
// those keys back through the ERP's own links to the source DOCUMENT it sits
// on. Added 2026-08-16 for HC-DO-2608-001/002, which AutoCount refused with
// `Invalid transfer item.` while D printed only the payload's key NAMES — so
// the one fact that could settle it, WHICH keys were sent and whose lines they
// are, was never on screen through six failed attempts.
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
 * The four conversions, and how a TARGET line names the SOURCE line it took.
 *
 * The same facts `DOWNSTREAM` holds in `scm/lib/autocount-outbox.ts`, restated
 * as data here rather than imported: this probe runs under plain node against
 * the production DSN and must not drag the Worker tree in. If a spec changes
 * there it must change here, which is why every field is named the same.
 *
 * `sourceParentFk` is the column on the SOURCE LINE that names its document —
 * `doc_no` is a text number on the line itself for sales orders, a uuid FK for
 * the other three. It is the field that answers "how many different source
 * documents does this conversion draw from", which is the question the payload
 * alone cannot answer.
 */
const CONVERSION = {
  so_to_do: {
    itemTable: 'delivery_order_items', itemFk: 'delivery_order_id',
    sourceFk: 'so_item_id', sourceItemTable: 'mfg_sales_order_items',
    sourceParentFk: 'doc_no', parentTable: 'mfg_sales_orders', parentKeyCol: 'doc_no',
  },
  po_to_gr: {
    itemTable: 'grn_items', itemFk: 'grn_id',
    sourceFk: 'purchase_order_item_id', sourceItemTable: 'purchase_order_items',
    sourceParentFk: 'purchase_order_id', parentTable: 'purchase_orders', parentKeyCol: 'id',
  },
  do_to_iv: {
    itemTable: 'sales_invoice_items', itemFk: 'sales_invoice_id',
    sourceFk: 'do_item_id', sourceItemTable: 'delivery_order_items',
    sourceParentFk: 'delivery_order_id', parentTable: 'delivery_orders', parentKeyCol: 'id',
  },
  gr_to_pi: {
    itemTable: 'purchase_invoice_items', itemFk: 'purchase_invoice_id',
    sourceFk: 'grn_item_id', sourceItemTable: 'grn_items',
    sourceParentFk: 'grn_id', parentTable: 'grns', parentKeyCol: 'id',
  },
};

/** Which of a table's columns actually exist, so an optional one can be read
 *  without guessing. `updated_at` is on some of these line tables and not
 *  others, and the answer decides whether section E can date the keys. */
async function columnsOf(table) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = ${table}`;
  return new Set(rows.map((r) => r.column_name));
}

/**
 * The outbox rows for a document, newest first, with what each one CARRIED.
 *
 * Its own function because it is the only section that works for a document
 * that is not a sales order, and the first one that needed that was a delivery
 * order the service refused.
 *
 * Returns the conversion rows it saw, so section E can replay their sources.
 */
async function dumpOutbox() {
  console.log('');
  notice('D — the outbox rows for this document, newest first, with what each carried');
  const rows = await sql`
    SELECT id, op, doc_id, status::text AS status, attempts, created_at, sent_at, last_error, payload
    FROM scm.autocount_outbox
    WHERE doc_no = ${DOC_NO} AND company_id = ${COMPANY_ID}
    ORDER BY created_at DESC LIMIT 8`;
  notice(`  ${rows.length} row(s)`);
  for (const r of rows) {
    notice(`  --- ${r.op} ${r.status} attempts=${r.attempts} created=${r.created_at?.toISOString?.() ?? r.created_at} sent=${r.sent_at?.toISOString?.() ?? '(never)'}`);
    /* The WHOLE error. It was clipped at 220 characters, which is shorter than
       an AutoCount exception message plus the frame that raised it — and on a
       refusal the tail is the part that names the constraint. */
    if (r.last_error) notice(`      error: ${String(r.last_error).slice(0, 2000)}`);
    const body = r.payload?.body ?? null;
    if (!body) { notice('      body: (none)'); continue; }
    /* The HEADER is where PDate / BALANCE / PAYEMENT live on an edit; a create
       carries them at the top level. Print whichever shape this row has. */
    const h = body.Header ?? body;
    const udf = h.UDF ?? null;
    notice(`      UDF: ${udf ? JSON.stringify(udf) : '(no UDF key — nothing sent, the book keeps its own)'}`);
    const keys = Object.keys(h).filter((k) => k !== 'UDF' && k !== 'Details' && k !== 'Lines');
    notice(`      header keys: ${keys.join(', ') || '(none)'}`);

    /* THE VALUES, not only the names, for the three fields a CONVERSION is
       decided by. Printing the key names told us `DtlKeys` was present and left
       the only question that mattered — WHICH keys — unanswered, so
       HC-DO-2608-001 sat on `Invalid transfer item.` through all six attempts
       with the payload sitting unread in the queue. `FromDocNo` is absent from
       the stored body by design: dispatchOne resolves it at DRAIN time from
       payload.fromDoc, so what the service receives is printed here too. */
    if (CONVERSION[r.op]) {
      const dtl = h.DtlKeys ?? null;
      notice(`      DtlKeys (stored, ${Array.isArray(dtl) ? dtl.length : 0}): ${
        Array.isArray(dtl) ? JSON.stringify(dtl) : '(absent — AutoCount would transfer EVERY outstanding line on the parent)'}`);
      notice(`      FromDocType: ${h.FromDocType ?? '(absent — the C# takes it from the route, not the payload)'}`);
      notice(`      FromDocNo (stored): ${h.FromDocNo ?? '(absent — resolved at drain from payload.fromDoc)'}`);
      const fd = r.payload?.fromDoc ?? null;
      if (!fd) {
        notice('      fromDoc: (none — nothing to resolve, the service gets no FromDocNo at all)');
      } else {
        notice(`      fromDoc: ${fd.table}.${fd.keyCol} = ${fd.key}`);
        if (CONVERSION[r.op].parentTable === fd.table) {
          const [p] = await sql`
            SELECT linked_ac_docno FROM scm.${sql(fd.table)} WHERE ${sql(fd.keyCol)} = ${fd.key}`;
          notice(`      FromDocNo (what drain SENDS): ${p?.linked_ac_docno ?? '(NULL — the row would go to waiting, not failed)'}`);
        }
      }
      notice(`      doc_id: ${r.doc_id ?? '(NULL — readConvertSourceKeys returns {} and sends no DtlKeys)'}`);
    }

    const lines = body.Lines ?? body.Details ?? [];
    for (const l of lines.slice(0, 4)) {
      notice(`      line: ${JSON.stringify(l).slice(0, 200)}`);
    }
  }
  return rows.filter((r) => CONVERSION[r.op]);
}

/**
 * E — WHERE EVERY KEY IN THAT PAYLOAD CAME FROM.
 *
 * A conversion payload is a flat list of numbers, and a flat list cannot show
 * the one property AutoCount enforces: `AddPartialTransferDetail` takes line
 * keys that must all sit on the SAME source document, and answers a mixed array
 * with `Invalid transfer item.` So this walks the ERP's own links — target line
 * -> source line -> the document that source line belongs to — and prints the
 * DISTINCT source documents beside the single `FromDocNo` the drain resolves.
 * Two documents in that list against one FromDocNo is the shape of the defect.
 *
 * It also names the two silent drops readConvertSourceKeys can make: a target
 * line with no source line at all, and a source line with no DtlKey.
 */
async function dumpConversionSources(row) {
  const spec = CONVERSION[row.op];
  if (!spec) return;
  console.log('');
  notice(`E — ${row.op}: where each DtlKey in that payload came from (doc_id ${row.doc_id ?? '(NULL)'})`);
  if (!row.doc_id) { notice('  no doc_id — the enqueue could not read any source line; nothing to trace'); return; }

  const targets = await sql`
    SELECT id, ${sql(spec.sourceFk)} AS source_id
    FROM scm.${sql(spec.itemTable)} WHERE ${sql(spec.itemFk)} = ${row.doc_id}`;
  notice(`  ${targets.length} line(s) on this document`);
  const orphans = targets.filter((t) => !t.source_id);
  notice(`  lines with no ${spec.sourceFk}: ${orphans.length}${orphans.length ? ` — ${orphans.map((o) => o.id).join(', ')}` : ''}`);

  const sourceIds = [...new Set(targets.map((t) => t.source_id).filter(Boolean))];
  if (!sourceIds.length) { notice('  no source lines at all — a parentless document; no DtlKeys are sent'); return; }

  const cols = await columnsOf(spec.sourceItemTable);
  const hasUpdated = cols.has('updated_at');
  /* IN (a list of scalars), not = ANY(array): the id columns here are uuid, and
     a JS string array is serialised with an array OID the server will not
     coerce to uuid[]. A scalar parameter is sent untyped and infers correctly —
     which is why every other statement in this file is written that way. */
  const src = hasUpdated
    ? await sql`
        SELECT id, ${sql(spec.sourceParentFk)} AS parent, linked_ac_dtlkey, updated_at
        FROM scm.${sql(spec.sourceItemTable)} WHERE id IN ${sql(sourceIds)}`
    : await sql`
        SELECT id, ${sql(spec.sourceParentFk)} AS parent, linked_ac_dtlkey, NULL AS updated_at
        FROM scm.${sql(spec.sourceItemTable)} WHERE id IN ${sql(sourceIds)}`;

  const byParent = new Map();
  for (const s of src) {
    const p = String(s.parent ?? '(null)');
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(s);
  }
  notice(`  DISTINCT SOURCE DOCUMENTS: ${byParent.size}`);
  for (const [parent, group] of byParent) {
    let acNo = '(not resolved)';
    if (spec.parentTable) {
      const [p] = await sql`
        SELECT linked_ac_docno FROM scm.${sql(spec.parentTable)} WHERE ${sql(spec.parentKeyCol)} = ${parent}`;
      acNo = p?.linked_ac_docno ?? '(NULL)';
    }
    notice(`    source ${parent} -> AutoCount ${acNo}: ${group.length} line(s), `
      + `keys ${JSON.stringify(group.map((g) => (g.linked_ac_dtlkey == null ? null : Number(g.linked_ac_dtlkey))))}`);
    if (hasUpdated) {
      for (const g of group) {
        notice(`      line ${g.id}: key=${g.linked_ac_dtlkey ?? '(NULL)'} updated_at=${g.updated_at?.toISOString?.() ?? g.updated_at ?? '(null)'}`);
      }
    }
  }
  const missing = src.filter((s) => s.linked_ac_dtlkey == null);
  notice(`  source lines with NO DtlKey: ${missing.length}${missing.length ? ` — ${missing.map((m) => m.id).join(', ')}` : ''}`);
  notice(`  found ${src.length} source line(s) for ${sourceIds.length} distinct ${spec.sourceFk} value(s)`
    + `${src.length === sourceIds.length ? '' : ' — MISMATCH, some source line no longer exists'}`);

  /* The comparison the whole section exists for. AddPartialTransferDetail was
     given ONE array; the book resolves each key back to its own document. */
  notice(`  VERDICT INPUT: ${byParent.size} source document(s) named by the keys, against ONE FromDocNo resolved at drain.`);
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
    const conversions = await dumpOutbox();
    for (const r of conversions) await dumpConversionSources(r);
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
      WHERE item_code = ${l.item_code} AND company_id = ${COMPANY_ID}`;
    const openPo = await sql`
      SELECT COALESCE(SUM(poi.qty - COALESCE(poi.received_qty, 0)), 0) AS qty
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
      WHERE poi.item_code = ${l.item_code}
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
  const conversions = await dumpOutbox();
  for (const r of conversions) await dumpConversionSources(r);

  console.log('');
  notice('READ THE RESULT LIKE THIS:');
  notice('  a line DROPPED in (A) -> the demand query never saw it; fix the named gate');
  notice('  kept in (A), and (B) shows stock or open PO >= qty -> shortage 0, correctly hidden');
  notice('  kept in (A), and (B) is all zeros -> the loss is the bucket key or the allocation; that is a bug');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
