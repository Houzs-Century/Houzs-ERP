// The SO lines reset-so-line-follower-flags.mjs clears: hand-set flag TRUE while
// the line date EQUALS its order's header Delivery Date. Until 2026-10-06 the
// item routes and the amendment cascade set the flag on lines nobody hand-set;
// since apply_so_header_cas keeps every flagged line (20261006T1300), those
// lines would stay behind on a header change. A line on the header date reads
// the same date with the flag true or false (effective-delivery.ts), so
// clearing it changes no visible date and only lets the line follow again.
//
// The header column is read through text so the compare holds whatever its
// type (apply_so_header_cas does the same). Company scope on BOTH tables.

export const FOLLOWER_FLAGGED_FROM = `
  FROM scm.mfg_sales_order_items i
  JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = $1
 WHERE i.company_id = $1
   AND i.line_delivery_date_overridden IS TRUE
   AND i.line_delivery_date IS NOT NULL
   AND i.line_delivery_date = NULLIF(left(h.customer_delivery_date::text, 10), '')::date`;

/** How many lines and orders the reset would touch. */
export async function planFollowerFlags(sql, companyId) {
  const [r] = await sql.unsafe(
    `SELECT count(*)::int AS lines, count(DISTINCT i.doc_no)::int AS orders ${FOLLOWER_FLAGGED_FROM}`,
    [companyId]);
  return { lines: r.lines, orders: r.orders };
}

/** Clear the flag; returns each touched line with the date it still carries. */
export async function resetFollowerFlags(sql, companyId) {
  return sql.unsafe(
    `UPDATE scm.mfg_sales_order_items t
        SET line_delivery_date_overridden = false
       FROM (SELECT i.id ${FOLLOWER_FLAGGED_FROM}) x
      WHERE t.id = x.id AND t.company_id = $1
      RETURNING t.id::text AS id, t.doc_no, t.line_delivery_date::text AS date`,
    [companyId]);
}

/**
 * Re-read the touched lines and say which ones are not in the expected shape:
 * flag false, date unchanged, still equal to the header date. Empty = good.
 */
export async function verifyFollowerFlags(sql, companyId, touched) {
  if (touched.length === 0) return [];
  const rows = await sql.unsafe(
    `SELECT i.id::text AS id, i.line_delivery_date_overridden AS flag,
            i.line_delivery_date::text AS date,
            NULLIF(left(h.customer_delivery_date::text, 10), '') AS header
       FROM scm.mfg_sales_order_items i
       JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = $1
      WHERE i.company_id = $1 AND i.id = ANY($2::uuid[])`,
    [companyId, touched.map((t) => t.id)]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wrong = [];
  for (const t of touched) {
    const r = byId.get(t.id);
    if (!r) { wrong.push(`${t.doc_no} line ${t.id}: not found on re-read`); continue; }
    if (typeof r.flag !== 'boolean' || r.flag !== false) wrong.push(`${t.doc_no} line ${t.id}: flag is ${r.flag}, expected false`);
    if (r.date !== t.date) wrong.push(`${t.doc_no} line ${t.id}: date moved ${t.date} -> ${r.date}`);
    if (r.date !== r.header) wrong.push(`${t.doc_no} line ${t.id}: date ${r.date} no longer equals header ${r.header}`);
  }
  return wrong;
}
