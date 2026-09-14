#!/usr/bin/env node
/* READ-ONLY. Every place the LIVE database fixes the list of product categories.
 *
 * Adding the SOFA_ACCESSORY category (tasks/PLAN-sofa-accessories-category.md)
 * means extending every enum and CHECK that names the existing categories. The
 * migration files are not a complete answer: `lib/lead-time.ts` says
 * scm.mrp_category_lead_times carries a category CHECK, and no migration in this
 * repo creates one - the same shape as the hand-ported unique index CLAUDE.md
 * records. So the catalogue is asked directly.
 *
 * Prints: every CHECK constraint whose definition mentions bedframe (any case),
 * every enum type holding a BEDFRAME-like label with all its labels, and the
 * current base lead-time rows per category.
 *
 * IT WRITES NOTHING. SELECT only, no DDL, no transaction.
 * RE-RUN: read-only and stateless.
 */
import postgres from 'postgres';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });
try {
  line('=== CHECK constraints naming a category ===');
  const checks = await sql`
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%bedframe%'
     ORDER BY 1, 2`;
  if (!checks.length) line('   (none)');
  for (const c of checks) line(`   ${c.tbl}  ${c.conname}  ${c.def}`);

  line('=== enum types holding a category label ===');
  const enums = await sql`
    SELECT n.nspname || '.' || t.typname AS typ,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
     GROUP BY 1
    HAVING bool_or(lower(e.enumlabel) = 'bedframe')`;
  if (!enums.length) line('   (none)');
  for (const e of enums) line(`   ${e.typ}: ${e.labels.join(', ')}`);

  line('=== columns typed with those enums ===');
  const cols = await sql`
    SELECT c.table_schema || '.' || c.table_name AS tbl, c.column_name, c.udt_name
      FROM information_schema.columns c
     WHERE c.udt_name IN (
       SELECT t.typname FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        GROUP BY t.typname HAVING bool_or(lower(e.enumlabel) = 'bedframe'))
     ORDER BY 1, 2`;
  for (const c of cols) line(`   ${c.tbl}.${c.column_name}  (${c.udt_name})`);

  line('=== base lead-time rows ===');
  const rows = await sql`
    SELECT company_id, warehouse_id IS NULL AS global_default, category, lead_days
      FROM scm.mrp_category_lead_times ORDER BY company_id, category`;
  for (const r of rows) line(`   company ${r.company_id}  ${r.global_default ? 'global' : 'warehouse'}  ${r.category}  ${r.lead_days}`);
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
