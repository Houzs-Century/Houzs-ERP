// The SQL half of repair-hc0113-processing-date.mjs, importable so
// tests-pg/hc0113ProcessingDateRepair.pg.test.ts can run it on a real postgres
// with the status column as the scm.mfg_so_status enum it is in production.
// Every status comparison goes through ::text for that reason (HC-0106).

/** The order, and the MYT day of every DRAFT -> live confirm recorded for it,
 *  from both places the status route writes one. */
export async function readConfirmShape(db, companyId, docNo) {
  const [so] = await db`
    SELECT doc_no, status::text AS status, version,
           processing_date::text AS processing_date,
           customer_delivery_date::text AS customer_delivery_date
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId} AND doc_no = ${docNo}`;
  const changes = await db`
    SELECT (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS day, to_status::text AS to_status
      FROM scm.mfg_so_status_changes
     WHERE company_id = ${companyId} AND doc_no = ${docNo}
       AND from_status::text = 'DRAFT' AND to_status::text <> 'CANCELLED'
     ORDER BY created_at`;
  const audits = await db`
    SELECT (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS day, actor_name_snapshot AS actor
      FROM scm.mfg_so_audit_log
     WHERE company_id = ${companyId} AND so_doc_no = ${docNo}
       AND action::text = 'UPDATE_STATUS'
       AND field_changes @> '[{"field":"status","from":"DRAFT"}]'::jsonb
     ORDER BY created_at`;
  return { so: so ?? null, changes, audits };
}

/** One column on one order, guarded on the value it is moving from, plus the
 *  SO history row. Returns the number of orders updated (0 or 1). */
export async function writeProcessingDate(tx, { companyId, docNo, from, to, status, note }) {
  const rows = await tx`
    UPDATE scm.mfg_sales_orders
       SET processing_date = ${to}, version = version + 1, updated_at = now()
     WHERE company_id = ${companyId} AND doc_no = ${docNo} AND processing_date = ${from}
     RETURNING doc_no`;
  if (rows.length !== 1) return rows.length;
  await tx`
    INSERT INTO scm.mfg_so_audit_log
      (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
    VALUES
      (${docNo}, ${companyId}, 'UPDATE', 'System (HC-0113 repair)',
       ${tx.json([{ field: 'processing_date', from, to }])},
       ${status}, 'script', ${note})`;
  return 1;
}
