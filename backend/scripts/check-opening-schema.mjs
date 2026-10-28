#!/usr/bin/env node
// check-opening-schema.mjs — READ ONLY. The live columns (type, null, default) and
// triggers of the tables the Houzs 31/08 opening writes, so the bulk insert names
// what the database has rather than what a migration once said. Writes nothing.
import postgres from 'postgres';
const TABLES = ['suppliers', 'accounts', 'ap_invoices', 'ap_invoice_lines', 'acc_credit_notes', 'acc_credit_note_lines',
  'journal_entries', 'journal_entry_lines', 'entity_audit_log', 'acc_debtors', 'purchase_invoices', 'doc_number_counters'];
async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const cols = await sql`SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '') AS d
      FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ANY(${TABLES}) ORDER BY table_name, ordinal_position`;
    for (const c of cols) console.log(`COL|${c.table_name}|${c.column_name}|${c.data_type}|${c.is_nullable}|${String(c.d).slice(0, 60)}`);
    const trg = await sql`SELECT event_object_table AS t, trigger_name AS n, action_timing AS w, event_manipulation AS e
      FROM information_schema.triggers WHERE trigger_schema = 'scm' AND event_object_table = ANY(${TABLES}) ORDER BY 1, 2`;
    for (const t of trg) console.log(`TRG|${t.t}|${t.n}|${t.w} ${t.e}`);
    const chk = await sql`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE connamespace = 'scm'::regnamespace AND contype IN ('c', 'u') AND conrelid::regclass::text = ANY(${TABLES.map((t) => `scm.${t}`)}) ORDER BY 1, 2`;
    for (const c of chk) console.log(`CON|${c.t}|${c.conname}|${String(c.def).slice(0, 160)}`);
    const idx = await sql`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'scm' AND tablename = ANY(${TABLES}) AND indexdef ILIKE '%UNIQUE%' ORDER BY 1, 2`;
    for (const i of idx) console.log(`IDX|${i.tablename}|${i.indexname}|${String(i.indexdef).slice(0, 200)}`);
    const co = await sql`SELECT id, code, name FROM public.companies ORDER BY id`;
    for (const c of co) console.log(`CO|${c.id}|${c.code}|${c.name}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
