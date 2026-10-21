#!/usr/bin/env node
// check-acquirers-view.mjs — READ-ONLY. Before migration 20261021T1400 replaces
// scm.acc_acquirers in place (CREATE OR REPLACE VIEW — existing columns must
// keep name, type and position): the view's columns as production has them,
// the config table's columns, and the grants on the view. Writes nothing.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const cols = await sql`SELECT ordinal_position, column_name, data_type FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_acquirers' ORDER BY ordinal_position`;
  console.log('scm.acc_acquirers columns:'); for (const c of cols) console.log(`  ${c.ordinal_position}. ${c.column_name} ${c.data_type}`);
  const cfg = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_acquirer_config' ORDER BY ordinal_position`;
  console.log(`scm.acc_acquirer_config columns: ${cfg.map((c) => c.column_name).join(', ')}`);
  const def = await sql`SELECT pg_get_viewdef('scm.acc_acquirers'::regclass, true) AS d`;
  console.log(`view definition:\n${def[0].d}`);
  const grants = await sql`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'scm' AND table_name = 'acc_acquirers' ORDER BY grantee`;
  console.log(`grants: ${grants.map((g) => `${g.grantee}:${g.privilege_type}`).join(', ')}`);
  const names = await sql`SELECT code, display_name FROM scm.acc_acquirer_config ORDER BY code`;
  console.log(`merchants: ${names.map((n) => `${n.code}="${n.display_name}"`).join(', ')}`);
  const applied = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'schema_migrations'`;
  console.log(`schema_migrations tables: ${applied[0].n}`);
} finally { await sql.end(); }
