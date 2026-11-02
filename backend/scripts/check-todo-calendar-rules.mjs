#!/usr/bin/env node
// check-todo-calendar-rules.mjs — READ ONLY (everything rolled back). On production,
// inside one transaction: runs the To do migrations not yet applied
// (20261102T2100 tasks if absent, 20261103T0100 custom rules), adds the three
// template rules to the company's settings, and builds (1) the To do through the
// app's own code, printing the custom-rule jobs, and (2) the calendar for MONTH
// (readCalendarPage), printing its days by kind and the next 7 days. Rolls back.
// Env: DATABASE_URL, COMPANY_ID, TODAY (YYYY-MM-DD), MONTH (YYYY-MM), VIEWER_ID.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { readFinanceTodoFacts } from '../src/scm/routes/accounting-todo.ts';
import { readCalendarPage } from '../src/scm/routes/accounting-todo-calendar.ts';
import { buildFinanceTodo } from '../src/acc/finance-todo.ts';

const CO = Number(process.env.COMPANY_ID);
const TODAY = String(process.env.TODAY ?? '').trim();
const MONTH = String(process.env.MONTH ?? TODAY.slice(0, 7)).trim();
const VIEWER = Number(process.env.VIEWER_ID ?? 1);
if (!Number.isInteger(CO) || !/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) { console.error('Refused: COMPANY_ID and TODAY are required.'); process.exit(2); }

const mig = (name) => readFileSync(new URL(`../src/db/migrations-pg/${name}`, import.meta.url), 'utf8');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '' : `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    const [{ t }] = await tx`SELECT to_regclass('scm.acc_todo_tasks')::text AS t`;
    if (!t) { await tx.unsafe(mig('20261102T2100_acc_todo_tasks.sql')); out('ran 20261102T2100 (not applied yet)'); } else out('20261102T2100 already applied');
    await tx.unsafe(mig('20261103T0100_acc_todo_custom_rules.sql'));
    await tx.unsafe(mig('20261103T0100_acc_todo_custom_rules.sql'));
    const cols = await tx`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_todo_settings' ORDER BY ordinal_position`;
    out(`acc_todo_settings: ${cols.map((c) => `${c.column_name}:${c.data_type}`).join(', ')}`);
    const rules = [{ id: 'c-bills', tpl: 'bills', param: 7, group: 'pay' }, { id: 'c-drafts', tpl: 'drafts', param: 3, group: 'other' }, { id: 'c-big', tpl: 'big', param: 10000, group: 'other' }];
    await tx`INSERT INTO scm.acc_todo_settings (company_id, custom_rules) VALUES (${CO}, ${tx.json(rules)})
      ON CONFLICT (company_id) DO UPDATE SET custom_rules = EXCLUDED.custom_rules`;
    const sb = pgrestShim(tx, 'scm');

    const facts = await readFinanceTodoFacts(sb, CO, TODAY, false);
    const page = buildFinanceTodo(facts, { id: VIEWER, name: 'Viewer', finance: true, checker: true, approver: true, checkerNames: [], approverNames: [] });
    out(`todo problems: ${page.problems.length ? page.problems.join(' | ') : 'none'}`);
    for (const r of facts.customRules) out(`rule ${r.rule.tpl}(${r.rule.param}) found ${r.items.length}${r.items.length ? `: ${r.items.slice(0, 4).map((i) => `${i.no} ${i.name} ${rm(i.amountSen)} ${i.day ?? ''}`.trim()).join(' | ')}` : ''}`);
    for (const j of page.mine.filter((x) => x.rule === 'custom')) out(`job [${j.group}] ${j.title} | ${j.detail} | ${rm(j.amountSen)} | since ${j.since ?? '—'} | ${j.action.label} → ${j.action.to}`);

    const t0 = Date.now();
    const cal = await readCalendarPage(sb, CO, TODAY, MONTH, VIEWER);
    out(`calendar ${cal.month} read in ${Date.now() - t0} ms · problems: ${cal.problems.length ? cal.problems.join(' | ') : 'none'} · ${cal.events.length} events`);
    for (const kind of ['late', 'pay', 'in', 'routine', 'task']) {
      const xs = cal.events.filter((e) => e.kind === kind);
      out(`  ${kind}: ${xs.length}${xs.length ? ` — ${xs.slice(0, 5).map((e) => `${e.day} ${e.short}${e.amountSen ? ` ${rm(e.amountSen)}` : ''}${e.done ? ' (done)' : ''}`).join(' | ')}` : ''}`);
    }
    for (const n of cal.next7) out(`  next 7: ${n.label} ${n.count} ${rm(n.amountSen)}`);
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.stack ?? e?.message ?? e}`); process.exitCode = 1; }
  else out('rolled back — nothing kept');
} finally { await sql.end(); }
