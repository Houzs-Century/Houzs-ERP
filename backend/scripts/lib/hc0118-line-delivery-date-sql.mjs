// The SQL half of repair-hc0118-line-delivery-dates.mjs, importable so
// tests-pg/hc0118LineDeliveryDateRepair.pg.test.ts can run it on a real
// postgres with the status columns as the enums they are in production.
// Every status comparison goes through ::text for that reason (HC-0106).
//
// The frozen-line rules are scm.apply_so_header_cas's (migration
// 20260915T1200) and updateFromSheetSql's: a line a live delivery order or
// invoice names keeps its date, and an order whose live delivery order or
// invoice carries a line naming no SO line keeps every date.

/** Lines that should mirror the header and do not: not hand-set, not blank,
 *  not cancelled, not frozen, on a live undelivered order with a header date.
 *  `docs` (array or null) narrows it to those order numbers. */
export async function readDrift(db, companyId, docs = null) {
  return db`
    SELECT so.doc_no, so.status::text AS status, so.customer_delivery_date::text AS header_date,
           i.id::text AS item_id, i.item_code, i.line_delivery_date::text AS line_date
      FROM scm.mfg_sales_orders so
      JOIN scm.mfg_sales_order_items i ON i.doc_no = so.doc_no
     WHERE so.company_id = ${companyId}
       AND (${docs}::text[] IS NULL OR so.doc_no = ANY(${docs}::text[]))
       AND so.status::text NOT IN ('DRAFT', 'CANCELLED', 'DELIVERED', 'INVOICED', 'CLOSED')
       AND so.customer_delivery_date IS NOT NULL
       AND i.line_delivery_date IS NOT NULL
       AND i.line_delivery_date <> so.customer_delivery_date
       AND i.line_delivery_date_overridden IS NOT TRUE
       AND i.cancelled IS NOT TRUE
       AND NOT EXISTS (
         SELECT 1 FROM scm.delivery_order_items doi
           JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
          WHERE doi.so_item_id = i.id
            AND upper(btrim(COALESCE(d.status::text, ''))) <> 'CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM scm.sales_invoice_items sii
           JOIN scm.sales_invoices s ON s.id = sii.sales_invoice_id
          WHERE sii.so_item_id = i.id
            AND upper(btrim(COALESCE(s.status::text, ''))) <> 'CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM scm.delivery_order_items doi
           JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
          WHERE d.so_doc_no = so.doc_no
            AND upper(btrim(COALESCE(d.status::text, ''))) <> 'CANCELLED'
            AND doi.so_item_id IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM scm.sales_invoice_items sii
           JOIN scm.sales_invoices s ON s.id = sii.sales_invoice_id
          WHERE s.so_doc_no = so.doc_no
            AND upper(btrim(COALESCE(s.status::text, ''))) <> 'CANCELLED'
            AND sii.so_item_id IS NULL AND sii.do_item_id IS NULL)
     ORDER BY so.doc_no, i.item_code, i.id`;
}

/** Group the drift by order. An order whose drifted lines agree on ONE old
 *  date is the header-moved-alone shape and is planned; one whose drifted
 *  lines hold several dates is named and left alone. */
export function planDrift(rows) {
  const byDoc = new Map();
  for (const r of rows) {
    const o = byDoc.get(r.doc_no) ?? { docNo: r.doc_no, status: r.status, to: r.header_date, lines: [] };
    o.lines.push({ id: r.item_id, itemCode: r.item_code, from: r.line_date });
    byDoc.set(r.doc_no, o);
  }
  const planned = [];
  const mixed = [];
  for (const o of byDoc.values()) {
    const froms = [...new Set(o.lines.map((l) => l.from))];
    (froms.length === 1 ? planned : mixed).push({ ...o, from: froms.length === 1 ? froms[0] : froms });
  }
  return { planned, mixed };
}

/** One order's drifted lines to the header date, each guarded on the date it
 *  is moving from and on still mirroring the header, plus one SO history row.
 *  Returns the number of lines updated. */
export async function writeOrder(tx, { companyId, order, note }) {
  const ids = order.lines.map((l) => l.id);
  const rows = await tx`
    UPDATE scm.mfg_sales_order_items i
       SET line_delivery_date = so.customer_delivery_date
      FROM scm.mfg_sales_orders so
     WHERE so.doc_no = i.doc_no AND so.company_id = ${companyId}
       AND i.doc_no = ${order.docNo}
       AND i.id = ANY(${ids}::uuid[])
       AND i.line_delivery_date = ${order.from}::date
       AND i.line_delivery_date_overridden IS NOT TRUE
       AND so.customer_delivery_date = ${order.to}::date
     RETURNING i.id`;
  if (rows.length === 0) return 0;
  await tx`
    INSERT INTO scm.mfg_so_audit_log
      (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
    VALUES
      (${order.docNo}, ${companyId}, 'UPDATE_LINE', 'System (HC-0118 repair)',
       ${tx.json([{ field: 'line_delivery_date', from: order.from, to: order.to, lines: rows.length }])},
       ${order.status}, 'script', ${note})`;
  return rows.length;
}
