// Read-only facts for the customer CN -> sales invoice knock-off (owner
// 2026-11-03: 「要」). Strictly SELECTs inside a READ ONLY transaction; exits 0
// for every real answer. Nothing is written.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
const show = (label, rows) => { console.log(`== ${label}`); for (const r of rows) console.log(`ROW|${JSON.stringify(r)}`); };
try {
  await sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    show('notes by company/kind/status', await tx`
      SELECT company_id, kind, status, count(*)::int AS n,
        count(*) FILTER (WHERE coalesce(party_code,'') = '')::int AS no_code,
        count(*) FILTER (WHERE so_doc_no IS NOT NULL)::int AS with_so,
        count(*) FILTER (WHERE sales_invoice_id IS NOT NULL)::int AS with_si,
        count(*) FILTER (WHERE refund_pv_id IS NOT NULL)::int AS refund,
        count(*) FILTER (WHERE converted_payment_id IS NOT NULL)::int AS moved,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.acc_deposit_invoices d WHERE d.company_id = n.company_id AND d.credit_note_id = n.id))::int AS closes_di,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.acc_deposit_invoices d WHERE d.company_id = n.company_id AND d.di_number = n.source_doc_no))::int AS names_di,
        count(*) FILTER (WHERE opening)::int AS opening,
        sum(total_sen)::bigint AS total_sen
      FROM scm.acc_credit_notes n GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    show('hand customer CNs (no refund, no move, no deposit invoice)', await tx`
      SELECT company_id, note_number, status, party_code, party_name, so_doc_no, sales_invoice_id IS NOT NULL AS has_si,
        source_doc_no, note_date::text AS note_date, total_sen, reason
      FROM scm.acc_credit_notes n
      WHERE kind = 'CN' AND refund_pv_id IS NULL AND converted_payment_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM scm.acc_deposit_invoices d WHERE d.company_id = n.company_id AND (d.credit_note_id = n.id OR d.di_number = n.source_doc_no))
      ORDER BY note_date DESC, note_number DESC LIMIT 40`);
    show('close-out notes whose deposit invoice does not point back', await tx`
      SELECT count(*)::int AS n FROM scm.acc_credit_notes n
      WHERE kind = 'CN' AND sales_invoice_id IS NOT NULL AND refund_pv_id IS NULL AND converted_payment_id IS NULL
        AND EXISTS (SELECT 1 FROM scm.acc_deposit_invoices d WHERE d.company_id = n.company_id AND d.di_number = n.source_doc_no)
        AND NOT EXISTS (SELECT 1 FROM scm.acc_deposit_invoices d WHERE d.company_id = n.company_id AND d.credit_note_id = n.id)`);
    show('allocations by target', await tx`
      SELECT company_id, count(*)::int AS n, count(purchase_invoice_id)::int AS pi, count(ap_invoice_id)::int AS api,
        count(debtor_bill_id)::int AS odb, sum(applied_sen)::bigint AS applied
      FROM scm.acc_credit_note_allocations GROUP BY 1 ORDER BY 1`);
    show('allocation columns', await tx`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = 'acc_credit_note_allocations' ORDER BY ordinal_position`);
    show('allocation constraints', await tx`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'scm.acc_credit_note_allocations'::regclass ORDER BY conname`);
    show('allocation indexes', await tx`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'scm' AND tablename = 'acc_credit_note_allocations' ORDER BY indexname`);
    show('sales_invoices.id type', await tx`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = 'sales_invoices' AND column_name IN ('id', 'debtor_code', 'debtor_name', 'phone', 'paid_sen', 'status')`);
    show('sales invoices by company/status', await tx`
      SELECT company_id, status::text AS status, count(*)::int AS n,
        count(*) FILTER (WHERE coalesce(debtor_code, '') = '')::int AS blank_code,
        count(*) FILTER (WHERE so_doc_no IS NULL)::int AS no_so
      FROM scm.sales_invoices GROUP BY 1, 2 ORDER BY 1, 2`);
    show('debtor codes on live invoices (top 12)', await tx`
      SELECT company_id, debtor_code, count(*)::int AS n, count(DISTINCT lower(btrim(debtor_name)))::int AS names
      FROM scm.sales_invoices WHERE status::text IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID')
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`);
    show('orders with more than one live invoice', await tx`
      SELECT company_id, count(*)::int AS orders, count(*) FILTER (WHERE k > 1)::int AS multi
      FROM (SELECT company_id, so_doc_no, count(*) AS k FROM scm.sales_invoices
            WHERE status::text <> 'CANCELLED' AND so_doc_no IS NOT NULL GROUP BY 1, 2) x GROUP BY 1 ORDER BY 1`);
    show('invoices whose order carries a customer_id', await tx`
      SELECT s.company_id, count(*)::int AS n, count(o.customer_id)::int AS with_customer_id,
        count(*) FILTER (WHERE coalesce(s.debtor_code, '') = '' AND o.customer_id IS NOT NULL)::int AS code_from_customer_id
      FROM scm.sales_invoices s LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = s.so_doc_no AND o.company_id = s.company_id
      WHERE s.status::text <> 'CANCELLED' GROUP BY 1 ORDER BY 1`);
  });
} catch (e) {
  console.error(`query failed: ${e instanceof Error ? e.message : String(e)}`);
  await sql.end();
  process.exit(1);
}
await sql.end();
