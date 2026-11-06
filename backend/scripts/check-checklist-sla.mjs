// Read-only: the days each project checklist task is due, per template, and how many
// live events carry each due offset. SELECT only; exit 0 for every real answer.
// Env: DATABASE_URL (required).
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const rows = await sql`
  SELECT t.company_id, t.id, t.name, t.active, i.seq, i.title, i.role_label, i.due_offset_days
    FROM project_checklist_template_items i JOIN project_checklist_templates t ON t.id = i.template_id
   WHERE t.active = 1 ORDER BY t.company_id, t.id, i.due_offset_days NULLS LAST, i.seq`;
let last = '';
for (const r of rows) {
  const key = `${r.company_id}|${r.id}`;
  if (key !== last) { console.log(`TEMPLATE co ${r.company_id} #${r.id} ${r.name}`); last = key; }
  console.log(`  ${r.due_offset_days ?? '-'} | ${r.title} | ${r.role_label ?? '-'}`);
}
const applied = await sql`
  SELECT c.title, (c.due_date::date - p.start_date::date) AS offset_days, count(*)::int AS n
    FROM project_checklist_items c JOIN projects p ON p.id = c.project_id
   WHERE p.archived_at IS NULL AND c.due_date IS NOT NULL AND substr(p.start_date, 1, 10) >= to_char(now(), 'YYYY-MM-DD')
   GROUP BY 1, 2 ORDER BY 1, 2`;
console.log('APPLIED on upcoming events (title | days from start | events)');
for (const a of applied) console.log(`  ${a.title} | ${a.offset_days} | ${a.n}`);
await sql.end();
