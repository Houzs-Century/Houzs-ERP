/* The selection and the per-line arithmetic behind
   repair-amendment-zeroed-prices.mjs, kept here so a test can pin them.

   THE DAMAGE. An approved SO amendment that swapped a line's SKU (change_type
   SPEC) to one with no catalogue sell price carried new_unit_price_sen 0 —
   seeded by the editor, not typed by anyone — and applySoAmendment persisted
   it, because an approved amendment's price is trusted over the catalogue
   (so-revision.ts, amendTrust). The line went from its real price to RM 0, and
   so did every total, DO line and invoice line built from it.

   THE SELECTION says, in SQL, exactly "a line that is RM 0 today BECAUSE of
   such an amendment": the amendment is applied (SO_APPROVED or later, with an
   approval timestamp), the change is a SPEC, the snapshot taken before the
   apply shows a positive price, the request carried no price, and the line
   still reads 0 now. A line re-priced since, or zeroed by anything else, does
   not match. Company scope sits on every table that has it. */

export const APPLIED_AMENDMENT_STATUSES = ['SO_APPROVED', 'PO_APPROVED', 'SENT'];

/* The snapshot is written by snapshotSo in camelCase; the snake_case fallback
   is the spelling so-revision.ts itself tolerates when it reads the old price. */
export const OLD_UNIT_SQL = "COALESCE(l.old_snapshot->>'unitPriceSen', l.old_snapshot->>'unit_price_sen')::bigint";
export const OLD_CODE_SQL = "COALESCE(l.old_snapshot->>'itemCode', l.old_snapshot->>'item_code')";

/** $1 = company id, $2 = text[] of doc_nos (empty array = every order),
 *  $3 = resume: also pick a line that already reads the snapshot price, so a
 *  run that stopped between the line write and the header roll-up can finish
 *  the header, the audit and the downstream documents. Every other predicate
 *  stays: the amendment evidence is still required. */
export function candidateSql() {
  const statuses = APPLIED_AMENDMENT_STATUSES.map((s) => `'${s}'`).join(', ');
  return `
    SELECT so.doc_no, so.status AS so_status, so.version AS so_version, so.local_total_sen AS so_total_sen,
           a.id::text AS amendment_id, a.amendment_no, a.status AS amendment_status, a.so_approved_at,
           l.id::text AS amendment_line_id, l.new_item_code, l.new_unit_price_sen,
           ${OLD_UNIT_SQL} AS old_unit_price_sen, ${OLD_CODE_SQL} AS old_item_code,
           i.id::text AS line_id, i.item_code, i.qty, i.unit_price_sen, i.discount_sen, i.total_sen,
           i.total_inc_sen, i.balance_sen, i.line_cost_sen, i.line_margin_sen, i.cancelled
      FROM scm.so_amendments a
      JOIN scm.so_amendment_lines l ON l.amendment_id = a.id
      JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no
      JOIN scm.mfg_sales_order_items i ON i.id = l.sales_order_item_id
     WHERE so.company_id = $1 AND i.company_id = $1 AND a.company_id = $1
       AND a.status IN (${statuses}) AND a.so_approved_at IS NOT NULL
       AND l.change_type = 'SPEC'
       AND ${OLD_UNIT_SQL} > 0
       AND COALESCE(l.new_unit_price_sen, 0) = 0
       AND (i.unit_price_sen = 0 OR ($3::boolean AND i.unit_price_sen = ${OLD_UNIT_SQL}))
       AND (cardinality($2::text[]) = 0 OR so.doc_no = ANY($2::text[]))
     ORDER BY so.doc_no, i.item_code, i.id`;
}

/** $1 = company id, $2 = uuid[] of SO line ids. Live = not cancelled. */
export function downstreamSql() {
  return `
    SELECT 'DO' AS kind, di.so_item_id::text AS so_line_id, d.id::text AS doc_id, d.do_number AS doc_no,
           d.status::text AS status, di.id::text AS item_id, di.qty, di.unit_price_sen, di.discount_sen,
           0::bigint AS tax_sen, di.line_total_sen, di.line_cost_sen, d.local_total_sen AS doc_total_sen,
           NULL::bigint AS paid_sen, d.so_doc_no, NULL::text AS invoice_number
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.company_id = $1 AND d.company_id = $1
       AND di.so_item_id = ANY($2::uuid[])
       AND d.status::text <> 'CANCELLED'
    UNION ALL
    SELECT 'SI', COALESCE(si.so_item_id, di.so_item_id)::text, s.id::text, s.invoice_number,
           s.status::text, si.id::text, si.qty, si.unit_price_sen, si.discount_sen,
           COALESCE(si.tax_sen, 0), si.line_total_sen, si.line_cost_sen, s.total_sen,
           s.paid_sen, s.so_doc_no, s.invoice_number
      FROM scm.sales_invoice_items si
      JOIN scm.sales_invoices s ON s.id = si.sales_invoice_id
      LEFT JOIN scm.delivery_order_items di ON di.id = si.do_item_id
     WHERE si.company_id = $1 AND s.company_id = $1
       AND (si.so_item_id = ANY($2::uuid[]) OR di.so_item_id = ANY($2::uuid[]))
       AND s.status::text <> 'CANCELLED'
     ORDER BY 4, 1`;
}

/** DOC_NOS is comma or whitespace separated; the runner reserves ';'. */
export function parseDocNos(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/* The SO line money exactly as applySoAmendment writes it for a SPEC
   (so-revision.ts): the discount is clamped to the line's gross, the total is
   gross minus discount, and total_inc_sen / balance_sen are the same figure.
   Cost does not move — the repair restores a sell price, nothing else. */
export function soLineMoney({ qty, unitSen, discountSen, lineCostSen }) {
  const q = Math.max(1, Number(qty ?? 1));
  const unit = Number(unitSen);
  const discount = Math.min(Math.max(Math.round(Number(discountSen ?? 0)), 0), q * unit);
  const total = (q * unit) - discount;
  return {
    unit_price_sen: unit,
    discount_sen: discount,
    total_sen: total,
    total_inc_sen: total,
    balance_sen: total,
    line_margin_sen: total - Number(lineCostSen ?? 0),
  };
}

/* The DO line money as PATCH /:id/items/:itemId writes it
   (delivery-orders-mfg.ts): clamped at zero, no tax. */
export function doLineMoney({ qty, unitSen, discountSen, lineCostSen }) {
  const total = Math.max(0, (Number(qty) * Number(unitSen)) - Number(discountSen ?? 0));
  return { unit_price_sen: Number(unitSen), line_total_sen: total, line_margin_sen: total - Number(lineCostSen ?? 0) };
}

/* The SI line money as buildItemRow writes it (si-from-do.ts): tax inside
   the clamp. */
export function siLineMoney({ qty, unitSen, discountSen, taxSen, lineCostSen }) {
  const total = Math.max(0, (Number(qty) * Number(unitSen)) - Number(discountSen ?? 0) + Number(taxSen ?? 0));
  return { unit_price_sen: Number(unitSen), line_total_sen: total, line_margin_sen: total - Number(lineCostSen ?? 0) };
}

/** Every column of `expected` the re-read row disagrees on, as "col: got vs want". */
export function shapeMismatches(row, expected) {
  if (!row) return ['row missing'];
  const out = [];
  for (const [col, want] of Object.entries(expected)) {
    if (Number(row[col]) !== Number(want)) out.push(`${col}: ${row[col]} vs ${want}`);
  }
  return out;
}
