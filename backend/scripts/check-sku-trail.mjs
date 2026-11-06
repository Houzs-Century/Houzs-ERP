// Read-only: where a catalogue code went. Every SKU matching LIKE (any status, any
// company) and the merges recorded in the last days. SELECT only; exit 0 for every
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
const merges = await sql`
  SELECT action, summary, actor_email, created_at FROM audit_events
   WHERE action IN ('scm.sku.merge', 'scm.model.merge') AND created_at::timestamptz > now() - make_interval(days => ${days})
   ORDER BY created_at DESC LIMIT 30`;
console.log(`Merges in the last ${days} days: ${merges.length}`);
for (const m of merges) console.log(`${new Date(m.created_at).toISOString()} | ${m.summary}`);
await sql.end();
