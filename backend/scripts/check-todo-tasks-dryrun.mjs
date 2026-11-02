#!/usr/bin/env node
// check-todo-tasks-dryrun.mjs — READ ONLY (everything rolled back). Runs migration
// 20261102T2100_acc_todo_tasks.sql on production inside one transaction, reads back
// the tables and the seeded routines, then builds Finance's To do for one company
// through the app's own code (readFinanceTodoFacts → buildFinanceTodo) with a sample
// task added the way POST /accounting/todo/tasks adds one — and rolls it all back.
// Env: DATABASE_URL, COMPANY_ID, TODAY (YYYY-MM-DD, the day the page is built for),
//      VIEWER_ID (public.users id to stand in as the viewer).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { readFinanceTodoFacts } from '../src/scm/routes/accounting-todo.ts';
import { buildFinanceTodo } from '../src/acc/finance-todo.ts';

const CO = Number(process.env.COMPANY_ID);
const TODAY = String(process.env.TODAY ?? '').trim();
const VIEWER = Number(process.env.VIEWER_ID ?? 1);
if (!Number.isInteger(CO) || !/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) { console.error('Refused: COMPANY_ID and TODAY are required.'); process.exit(2); }

const MIGRATION = new URL('../src/db/migrations-pg/20261102T2100_acc_todo_tasks.sql', import.meta.url);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    out('migration ran inside the transaction');
    const cols = await tx`SELECT table_name, count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name LIKE 'acc_todo_%' GROUP BY table_name ORDER BY table_name`;
    for (const c of cols) out(`table scm.${c.table_name}: ${c.n} columns`);
    const routines = await tx`SELECT company_id, routine_key, title, group_key, due_date, month_day, by_day, action, action_to
      FROM scm.acc_todo_tasks WHERE kind = 'routine' ORDER BY company_id, due_date, routine_key`;
    for (const r of routines) out(`routine co${r.company_id} ${r.routine_key.padEnd(10)} due ${r.due_date} (day ${r.month_day}${r.by_day ? ', by' : ''}) ${r.action}${r.action_to ? ` → ${r.action_to}` : ''} · ${r.title}`);
    /* Run twice — the seed must not add a second set. */
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM scm.acc_todo_tasks WHERE kind = 'routine'`;
    out(`after running it again: ${n} routines (unchanged = ${n === routines.length})`);

    const [t] = await tx`INSERT INTO scm.acc_todo_tasks (company_id, kind, title, group_key, assignee_id, assignee_name, created_by_id, created_by_name, due_date, link)
      VALUES (${CO}, 'task', 'Call Kian Furniture about the October statement', 'pay', ${VIEWER}, 'Viewer', ${VIEWER}, 'Viewer', ${TODAY},
              ${tx.json({ type: 'Page', no: 'AP invoices', name: 'Finance › Money out', to: '/scm/ap-invoices' })})
      RETURNING id`;
    await tx`INSERT INTO scm.acc_todo_remarks (task_id, company_id, author_id, author_name, body) VALUES (${t.id}, ${CO}, ${VIEWER}, 'Viewer', 'Their statement says RM 19,630.00')`;
    out(`sample task ${t.id} added for viewer ${VIEWER}, due ${TODAY}`);

    const sb = pgrestShim(tx, 'scm');
    const facts = await readFinanceTodoFacts(sb, CO, TODAY, true);
    const page = buildFinanceTodo(facts, { id: VIEWER, name: 'Viewer', finance: true, checker: true, approver: true, checkerNames: [], approverNames: [] });
    out(`problems: ${page.problems.length ? page.problems.join(' | ') : 'none'}`);
    for (const j of page.mine.filter((x) => x.task)) {
      out(`[${j.group}] ${j.rule} | ${j.title} | ${j.detail} | due ${j.task.due} | remarks ${j.task.remarkCount} | ${j.action.label}${j.action.to ? ` → ${j.action.to}` : ''}`);
    }
    out(`mine ${page.mine.length} (tasks/routines ${page.mine.filter((x) => x.task).length}) · others ${page.others.length} · done ${page.done.length}`);
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.stack ?? e?.message ?? e}`); process.exitCode = 1; }
  else out('rolled back — nothing kept');
} finally { await sql.end(); }
