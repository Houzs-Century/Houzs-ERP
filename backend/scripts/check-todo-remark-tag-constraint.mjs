#!/usr/bin/env node
// check-todo-remark-tag-constraint.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Before a migration widens scm.acc_todo_remarks.tag (task Edit/Delete, owner 2026-11-09):
// the CHECK constraints on that table by their real names and definitions, which tags rows
// carry today, and the newest applied migrations.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  const cons = await tx`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'scm.acc_todo_remarks'::regclass AND contype = 'c' ORDER BY conname`;
  for (const c of cons) out(`check ${c.conname}: ${c.def}`);
  const tags = await tx`SELECT coalesce(tag, '(none)') AS tag, count(*)::int AS n FROM scm.acc_todo_remarks GROUP BY 1 ORDER BY 1`;
  out(`tags: ${tags.map((t) => `${t.tag} ${t.n}`).join(', ') || 'no remarks'}`);
  const tasks = await tx`SELECT kind, is_off, count(*)::int AS n FROM scm.acc_todo_tasks GROUP BY 1, 2 ORDER BY 1, 2`;
  out(`tasks: ${tasks.map((t) => `${t.kind}${t.is_off ? ' off' : ''} ${t.n}`).join(', ')}`);
  const last = await tx`SELECT filename FROM _pg_migrations ORDER BY filename DESC LIMIT 3`;
  out(`newest applied: ${last.map((r) => r.filename).join(', ')}`);
});
await sql.end();
