// The SQL half of repair-hc0122-exemption-expiry.mjs, importable so
// tests-pg/hc0122ExemptionExpiryRepair.pg.test.ts can run it on a real postgres
// with the SO status as the scm.mfg_so_status enum it is in production
// (HC-0106: every status comparison goes through ::text).

/* The value each order freezes to: the AutoCount book's own expiry when the
   order is linked and the book has one (the date the bill was processed with),
   else the order's current delivery date. Only a well-formed YYYY-MM-DD from the
   mirror is trusted; its column is text. */
/** Every processed order whose Sales Exemption Expiry Date was never frozen,
 *  with the date it will freeze to and where that date comes from. */
export function readFreezeTargets(db, companyIds) {
  return db`
  SELECT so.company_id, so.doc_no, so.status::text AS status,
         so.customer_delivery_date::text AS customer_delivery_date,
         ac.expiry_date AS ac_expiry,
         CASE WHEN ac.expiry_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ac.expiry_date::date
              ELSE so.customer_delivery_date END::text AS freeze_to,
         CASE WHEN ac.expiry_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'autocount'
              ELSE 'delivery_date' END AS source
    FROM scm.mfg_sales_orders so
    LEFT JOIN public.sales_orders ac
      ON ac.doc_no = NULLIF(btrim(so.linked_ac_docno), '') AND ac.company_id = so.company_id
   WHERE so.company_id IN ${db(companyIds)}
     AND so.sales_exemption_expiry IS NULL
     AND so.status::text NOT IN ('DRAFT', 'CANCELLED')
     AND (so.customer_delivery_date IS NOT NULL OR ac.expiry_date ~ '^\\d{4}-\\d{2}-\\d{2}$')
   ORDER BY so.company_id, so.doc_no`;
}

/** What the column now IS on the given orders, with its stored type, for the
 *  fresh-connection check after apply. */
export function readFrozenValues(db, rows) {
  const keys = rows.map((r) => ({ company_id: Number(r.company_id), doc_no: r.doc_no }));
  return db`
    SELECT so.company_id, so.doc_no, so.sales_exemption_expiry::text AS value,
           pg_typeof(so.sales_exemption_expiry)::text AS type
      FROM scm.mfg_sales_orders so
      JOIN jsonb_to_recordset(${db.json(keys)}) AS k(company_id bigint, doc_no text)
        ON so.company_id = k.company_id AND so.doc_no = k.doc_no`;
}

/** Freeze one batch, guarded on the column still being empty so a value the
 *  app seeded in the meantime is never overwritten, plus one SO history row per
 *  order. Leaves version and updated_at alone: the column is not on the
 *  delivery sheet, and bumping thousands of rows would re-pull them all there
 *  and void every open edit lease. Returns the doc_nos written. */
export async function freezeExemptionExpiry(tx, rows, note) {
  if (rows.length === 0) return [];
  const payload = rows.map((r) => ({ company_id: Number(r.company_id), doc_no: r.doc_no, freeze_to: r.freeze_to, status: r.status, source: r.source }));
  const written = await tx`
    UPDATE scm.mfg_sales_orders so
       SET sales_exemption_expiry = t.freeze_to::date
      FROM jsonb_to_recordset(${tx.json(payload)}) AS t(company_id bigint, doc_no text, freeze_to text, status text, source text)
     WHERE so.company_id = t.company_id AND so.doc_no = t.doc_no
       AND so.sales_exemption_expiry IS NULL
     RETURNING so.company_id, so.doc_no, so.status::text AS status, t.freeze_to, t.source`;
  if (written.length === 0) return [];
  const audit = written.map((w) => ({
    company_id: Number(w.company_id), doc_no: w.doc_no, status: w.status,
    changes: [{ field: 'sales_exemption_expiry', from: null, to: w.freeze_to, source: w.source }],
  }));
  await tx`
    INSERT INTO scm.mfg_so_audit_log
      (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
    SELECT a.doc_no, a.company_id, 'UPDATE', 'System (HC-0122 repair)', a.changes,
           a.status::scm.mfg_so_status, 'script', ${note}
      FROM jsonb_to_recordset(${tx.json(audit)}) AS a(company_id bigint, doc_no text, status text, changes jsonb)`;
  return written.map((w) => w.doc_no);
}
