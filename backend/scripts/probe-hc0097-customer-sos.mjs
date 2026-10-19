#!/usr/bin/env node
/* probe-hc0097-customer-sos — READ-ONLY. For the customer records the phone
 * repair left alone, print the customer master phone beside every Sales Order
 * that points at that customer (by customer_id or by name), so the reporter's
 * "the number has 10 digits" can be matched to the screen she read. SELECT only.
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.log('DATABASE_URL is not set'); process.exit(2); }
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const IDS = [
  'fccd9573-d2fd-4960-ad87-d0c20d6722ad',
  '55fa74ea-8703-4aea-881a-dc45baad12d2',
  'b2f79893-81c8-4e9e-a471-38fc39d0f333',
  '6c2c0e1c-cb6f-4409-a5d4-390494ff4d10',
  '9f38f4de-e1c5-4e7f-acc0-fd384e0c85af',
];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
try {
  for (const id of IDS) {
    const [c] = await sql`SELECT to_jsonb(c) AS row FROM scm.customers c WHERE c.id = ${id}`;
    if (!c) { note(`customer ${id}: not found`); continue; }
    const r = c.row;
    note(`CUSTOMER ${r.name} | id=${id} | code=${r.code ?? r.customer_code ?? '-'} | phone=${r.phone} | phone2=${r.phone2 ?? r.mobile ?? '-'} | created_at=${r.created_at} | updated_at=${r.updated_at}`);
    const sos = await sql`
      SELECT doc_no, debtor_name, phone, emergency_contact_phone, status::text AS status, created_at,
             (customer_id::text = ${id}) AS by_id
        FROM scm.mfg_sales_orders
       WHERE customer_id::text = ${id} OR lower(trim(debtor_name)) = lower(trim(${r.name}))
       ORDER BY created_at`;
    if (!sos.length) note('  no Sales Order');
    for (const s of sos) note(`  ${s.doc_no} | ${s.status} | phone=${s.phone} | emergency=${s.emergency_contact_phone} | ${s.by_id ? 'linked' : 'name match'} | created_at=${s.created_at.toISOString()}`);
  }
} finally {
  await sql.end();
}
