// The SQL half of repair-hc0207-so-cost.mjs, importable so
// tests-pg/hc0207SoCostRepair.pg.test.ts can run it on a real postgres with the
// status columns as the enums they are in production (HC-0106).
//
// DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT had its (S) and (SS) costs set the
// wrong way round, and an SO line keeps the cost it was saved with.

const S = 'DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT (S)';
const SS = 'DUNLOPILLO OTHOREST GENERASI 3.0 20CM MATT (SS)';

/** Per code, the swapped cost a line was stamped with and the right one (sen). */
export const COST_FIX = [
  { itemCode: S, from: 55000, to: 46500 },
  { itemCode: SS, from: 46500, to: 55000 },
];
const CODES = COST_FIX.map((f) => f.itemCode);

/** Live lines of these codes on orders that are not cancelled, right or wrong. */
export async function readLines(db, companyId) {
  return db`
    SELECT so.doc_no, so.status::text AS status, i.id::text AS item_id, i.item_code,
           i.qty::numeric AS qty, i.unit_cost_sen::bigint AS unit_cost_sen, i.line_cost_sen::bigint AS line_cost_sen
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no AND so.company_id = i.company_id
     WHERE i.company_id = ${companyId}
       AND i.item_code = ANY(${CODES}::text[])
       AND i.cancelled IS NOT TRUE
       AND so.status::text <> 'CANCELLED'
     ORDER BY so.doc_no, i.item_code, i.id`;
}

/** Current product cost per code. A repair before the price list is corrected
 *  would leave the lines disagreeing with the product. */
export async function readProductCosts(db, companyId) {
  return db`
    SELECT code, base_price_sen::bigint AS base_price_sen
      FROM scm.mfg_products
     WHERE company_id = ${companyId} AND code = ANY(${CODES}::text[])
     ORDER BY code`;
}

/** Codes whose product cost is not yet the right one, as display strings. */
export function productsNotFixed(products) {
  const byCode = new Map(products.map((p) => [p.code, Number(p.base_price_sen)]));
  return COST_FIX
    .filter((f) => byCode.get(f.itemCode) !== f.to)
    .map((f) => `${f.itemCode}: product cost ${byCode.get(f.itemCode) ?? 'missing'}, needs ${f.to}`);
}

/** Lines on a live delivery order. Their cost comes from stock movements, so
 *  they are named and not written. */
export async function readDeliveryLines(db, itemIds) {
  return db`
    SELECT d.do_number, d.status::text AS status, doi.so_item_id::text AS item_id,
           doi.unit_cost_sen::bigint AS unit_cost_sen
      FROM scm.delivery_order_items doi
      JOIN scm.delivery_orders d ON d.id = doi.delivery_order_id
     WHERE doi.so_item_id = ANY(${itemIds}::uuid[])
       AND upper(btrim(COALESCE(d.status::text, ''))) <> 'CANCELLED'
     ORDER BY d.do_number`;
}

/** Group by order. A line on its swapped cost is planned, a line on the right
 *  cost is `done`, any other cost is named and left alone (`other`). */
export function planCosts(rows) {
  const fixByCode = new Map(COST_FIX.map((f) => [f.itemCode, f]));
  const byDoc = new Map();
  const done = [];
  const other = [];
  for (const r of rows) {
    const fix = fixByCode.get(r.item_code);
    const unit = Number(r.unit_cost_sen);
    if (unit === fix.to) { done.push(r); continue; }
    if (unit !== fix.from) { other.push(r); continue; }
    const order = byDoc.get(r.doc_no) ?? { docNo: r.doc_no, status: r.status, deltaSen: 0, lines: [] };
    const deltaSen = Math.round(Number(r.qty) * (fix.to - fix.from));
    order.lines.push({ id: r.item_id, itemCode: r.item_code, qty: Number(r.qty), from: fix.from, to: fix.to, deltaSen });
    order.deltaSen += deltaSen;
    byDoc.set(r.doc_no, order);
  }
  return { orders: [...byDoc.values()], done, other };
}

/** One order's lines to the right cost, each guarded on the cost it is moving
 *  from, the same difference on the header, and one SO history row. The header
 *  moves by the difference, never re-summed, so nothing else on it shifts.
 *  Returns lines updated. */
export async function writeOrder(tx, { companyId, order, note }) {
  let written = 0;
  let deltaSen = 0;
  const changes = [];
  for (const l of order.lines) {
    const rows = await tx`
      UPDATE scm.mfg_sales_order_items
         SET unit_cost_sen = ${l.to},
             line_cost_sen = line_cost_sen + ${l.deltaSen},
             line_margin_sen = line_margin_sen - ${l.deltaSen}
       WHERE id = ${l.id}::uuid AND company_id = ${companyId} AND unit_cost_sen = ${l.from}
       RETURNING id`;
    if (rows.length === 0) continue;
    written += 1;
    deltaSen += l.deltaSen;
    changes.push({ field: 'unit_cost_sen', itemCode: l.itemCode, from: l.from, to: l.to });
  }
  if (written === 0) return 0;
  await tx`
    UPDATE scm.mfg_sales_orders
       SET mattress_sofa_cost_sen = mattress_sofa_cost_sen + ${deltaSen},
           total_cost_sen = total_cost_sen + ${deltaSen},
           total_margin_sen = total_margin_sen - ${deltaSen},
           margin_pct_basis = CASE WHEN total_revenue_sen > 0
             THEN round((total_margin_sen - ${deltaSen})::numeric * 10000 / total_revenue_sen)
             ELSE margin_pct_basis END
     WHERE doc_no = ${order.docNo} AND company_id = ${companyId}`;
  await tx`
    INSERT INTO scm.mfg_so_audit_log
      (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
    VALUES
      (${order.docNo}, ${companyId}, 'UPDATE_LINE', 'System (HC-0207 repair)',
       ${tx.json(changes)}, ${order.status}, 'script', ${note})`;
  return written;
}
