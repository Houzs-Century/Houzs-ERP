#!/usr/bin/env node
/* probe-hc0097-phones — READ-ONLY. Lists the doubled-prefix phones that
 * repair-double-prefixed-phones.mjs leaves alone (not a plausible MY number,
 * or a duplicate customer), with the row's doc no / name / dates, so a human
 * can decide each one. Every statement is a SELECT; no MODE, no APPLY.
 */
import postgres from 'postgres';
import { collapseDoubledMalaysianPrefix } from './lib/phone-normalise.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.log('DATABASE_URL is not set'); process.exit(2); }
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const TARGETS = [
  ['customers', 'phone'],
  ['mfg_sales_orders', 'phone'],
  ['mfg_sales_orders', 'emergency_contact_phone'],
  ['delivery_orders', 'phone'],
  ['delivery_orders', 'emergency_contact_phone'],
];
const KEEP = ['id', 'doc_no', 'name', 'customer_name', 'debtor_name', 'company_id', 'status', 'created_at', 'updated_at'];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
try {
  for (const [table, column] of TARGETS) {
    const rows = await sql`
      SELECT to_jsonb(t) AS row FROM ${sql(`scm.${table}`)} t
       WHERE regexp_replace(coalesce(${sql(column)}, ''), '\\D', '', 'g') ~ '^60(60|0)'`;
    note(`scm.${table}.${column}: ${rows.length} doubled-looking`);
    for (const { row } of rows) {
      const digits = String(row[column]).replace(/\D/g, '');
      const fixed = collapseDoubledMalaysianPrefix(digits);
      const meta = KEEP.filter((k) => row[k] != null).map((k) => `${k}=${row[k]}`).join(' | ');
      note(`  ${row[column]}  ${fixed === digits ? 'LEFT ALONE' : '-> +' + fixed}  | ${meta}`);
    }
  }
  const dup = await sql`
    SELECT to_jsonb(c) AS row FROM scm.customers c
     WHERE c.name = (SELECT name FROM scm.customers WHERE id = '6c2c0e1c-cb6f-4409-a5d4-390494ff4d10')`;
  note(`customers sharing the name of 6c2c0e1c (the duplicate skip): ${dup.length}`);
  for (const { row } of dup) note(`  ${KEEP.filter((k) => row[k] != null).map((k) => `${k}=${row[k]}`).join(' | ')} | phone=${row.phone}`);
} finally {
  await sql.end();
}
