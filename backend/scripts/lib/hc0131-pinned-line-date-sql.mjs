// The SQL half of repair-hc0131-pinned-line-dates.mjs, importable so
// tests-pg/hc0131PinnedLineDateRepair.pg.test.ts can run it on a real postgres
// with the status columns as the enums they are in production (HC-0106).
//
// The phone's new-order screen sent every line's date with no override flag,
// so the create handler pinned every line (line_delivery_date_overridden =
// true) even though each date was only the header's. A pinned line beats the
// header in MRP (effective-delivery.ts), so a header-only move (the HC
// Delivery sheet before #4712, the delivery board's amended date) never
// reached MRP. That signature is an order whose every live line is pinned:
// the desktop never pins a line nobody touched.
//
// Frozen-line rules are scm.apply_so_header_cas's and updateFromSheetSql's.

/** Live, unfrozen, dated lines of live orders that have at least one pinned
 *  such line, a header date, no order-wide freeze, and no SO history row in
 *  which a person changed a line date or its pin. `docs` narrows the read. */
export async function readPinned(db, companyId, docs = null) {
  return db`
    WITH live_line AS (
      SELECT so.doc_no, so.status::text AS status, so.customer_delivery_date::text AS header_date,
             i.id::text AS item_id, i.item_code, i.line_delivery_date::text AS line_date,
             i.line_delivery_date_overridden IS TRUE AS pinned
        FROM scm.mfg_sales_orders so
        JOIN scm.mfg_sales_order_items i ON i.doc_no = so.doc_no
       WHERE so.company_id = ${companyId}
         AND (${docs}::text[] IS NULL OR so.doc_no = ANY(${docs}::text[]))
         AND so.status::text NOT IN ('DRAFT', 'CANCELLED', 'DELIVERED', 'INVOICED', 'CLOSED')
         AND so.customer_delivery_date IS NOT NULL
         AND i.line_delivery_date IS NOT NULL
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
         AND NOT EXISTS (
           SELECT 1 FROM scm.mfg_so_audit_log a
            WHERE a.so_doc_no = so.doc_no AND a.company_id = so.company_id
              AND jsonb_typeof(a.field_changes) = 'array'
              AND (a.field_changes @> '[{"field":"lineDeliveryDate"}]'::jsonb
                   OR a.field_changes @> '[{"field":"lineDeliveryDateOverridden"}]'::jsonb))
    )
    SELECT l.* FROM live_line l
     WHERE EXISTS (SELECT 1 FROM live_line p WHERE p.doc_no = l.doc_no AND p.pinned)
     ORDER BY l.doc_no, l.item_code, l.item_id`;
}

/** Group by order. Only an order whose every line is pinned is the phone's
 *  shape; of those, one date that is not the header's is the header moved
 *  alone (`drifted`: lines take the header date and unpin), every line on the
 *  header date only needs the pin dropped (`mirrors`), anything else is named
 *  and left alone (`mixed`). Orders with an unpinned line are not counted. */
export function planPinned(rows) {
  const byDoc = new Map();
  for (const r of rows) {
    const o = byDoc.get(r.doc_no) ?? { docNo: r.doc_no, status: r.status, to: r.header_date, lines: [] };
    o.lines.push({ id: r.item_id, itemCode: r.item_code, from: r.line_date, pinned: r.pinned });
    byDoc.set(r.doc_no, o);
  }
  const drifted = [];
  const mirrors = [];
  const mixed = [];
  for (const o of byDoc.values()) {
    if (!o.lines.every((l) => l.pinned)) continue;
    const lines = o.lines.map(({ id, itemCode, from }) => ({ id, itemCode, from }));
    const froms = [...new Set(lines.map((l) => l.from))];
    if (froms.length === 1 && froms[0] === o.to) mirrors.push({ ...o, from: o.to, lines });
    else if (froms.length === 1) drifted.push({ ...o, from: froms[0], lines });
    else mixed.push({ ...o, from: froms, lines });
  }
  return { drifted, mirrors, mixed };
}

/** One order's lines to the header date with the pin dropped, each guarded on
 *  the date it is moving from, on still being pinned and on the header still
 *  being the planned date, plus one SO history row. Returns lines updated. */
export async function writeOrder(tx, { companyId, order, note }) {
  const ids = order.lines.map((l) => l.id);
  const rows = await tx`
    UPDATE scm.mfg_sales_order_items i
       SET line_delivery_date = so.customer_delivery_date,
           line_delivery_date_overridden = false
      FROM scm.mfg_sales_orders so
     WHERE so.doc_no = i.doc_no AND so.company_id = ${companyId}
       AND i.doc_no = ${order.docNo}
       AND i.id = ANY(${ids}::uuid[])
       AND i.line_delivery_date = ${order.from}::date
       AND i.line_delivery_date_overridden IS TRUE
       AND so.customer_delivery_date = ${order.to}::date
     RETURNING i.id`;
  if (rows.length === 0) return 0;
  const changes = order.from === order.to
    ? [{ field: 'lineDeliveryDateOverridden', from: true, to: false, lines: rows.length }]
    : [{ field: 'line_delivery_date', from: order.from, to: order.to, lines: rows.length },
       { field: 'lineDeliveryDateOverridden', from: true, to: false, lines: rows.length }];
  await tx`
    INSERT INTO scm.mfg_so_audit_log
      (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
    VALUES
      (${order.docNo}, ${companyId}, 'UPDATE_LINE', 'System (HC-0131 repair)',
       ${tx.json(changes)}, ${order.status}, 'script', ${note})`;
  return rows.length;
}
