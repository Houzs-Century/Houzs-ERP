// Read-only: where a catalogue code went. Every SKU matching LIKE (any status, any
// company), every row in any scm table whose code column still names it, audit rows
// that mention it, and the merges of the last days. SELECT only; exit 0 for every
// real answer. Env: DATABASE_URL (required), LIKE (required), DAYS (default 7).
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const LIKE = process.env.LIKE;
if (!DSN || !LIKE) { console.error('need DATABASE_URL and LIKE'); process.exit(2); }
const days = Number(process.env.DAYS ?? 7);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const pattern = `%${LIKE}%`;

const skus = await sql`
  SELECT company_id, code, name, category::text AS category, status::text AS status, model_id::text AS model_id, updated_at
    FROM scm.mfg_products WHERE code ILIKE ${pattern} OR name ILIKE ${pattern} ORDER BY company_id, code LIMIT 40`;
console.log(`SKUs matching: ${skus.length}`);
for (const s of skus) console.log(`co ${s.company_id} | ${s.code} | ${s.name} | ${s.category} | ${s.status} | model ${s.model_id ? 'yes' : 'none'} | ${new Date(s.updated_at).toISOString()}`);

const cols = await sql`
  SELECT table_name, column_name FROM information_schema.columns c
   WHERE table_schema = 'scm' AND data_type IN ('text', 'character varying')
     AND column_name IN ('item_code', 'code', 'new_item_code', 'old_item_code', 'model_code', 'base_model', 'description', 'trigger_item_code', 'redeemed_item_code')
     AND EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = 'scm' AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE')`;
let found = 0;
for (const c of cols) {
  const rows = await sql`SELECT count(*)::int AS n FROM ${sql(`scm.${c.table_name}`)} WHERE ${sql(c.column_name)} ILIKE ${pattern}`;
  if (rows[0].n > 0) { found += 1; console.log(`trace scm.${c.table_name}.${c.column_name}: ${rows[0].n}`); }
}
console.log(`Tables searched: ${cols.length}, holding a trace: ${found}`);

const audit = await sql`
  SELECT action, entity_type, summary, created_at FROM audit_events
   WHERE summary ILIKE ${pattern} OR meta ILIKE ${pattern} ORDER BY created_at DESC LIMIT 20`;
console.log(`Audit rows naming it: ${audit.length}`);
for (const a of audit) console.log(`audit ${new Date(a.created_at).toISOString()} | ${a.action} | ${a.entity_type} | ${String(a.summary).slice(0, 110)}`);

const merges = await sql`
  SELECT action, summary, created_at FROM audit_events
   WHERE action IN ('scm.sku.merge', 'scm.model.merge') AND created_at::timestamptz > now() - make_interval(days => ${days})
   ORDER BY created_at DESC LIMIT 30`;
console.log(`Merges in the last ${days} days: ${merges.length}`);
await sql.end();
