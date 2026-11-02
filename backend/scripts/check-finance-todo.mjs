#!/usr/bin/env node
// check-finance-todo.mjs — READ ONLY. Finance's To do for one company as the page
// would build it today (backend scm/routes/accounting-todo.ts readFinanceTodoFacts →
// acc/finance-todo.ts buildFinanceTodo), read through the app's own query code on a
// rolled-back transaction. The viewer is a Finance person who checks and approves.
// Env: DATABASE_URL, COMPANY_ID, TODAY (optional, YYYY-MM-DD; default today in MYT).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { readFinanceTodoFacts } from '../src/scm/routes/accounting-todo.ts';
import { buildFinanceTodo } from '../src/acc/finance-todo.ts';

const CO = Number(process.env.COMPANY_ID);
const TODAY = String(process.env.TODAY ?? '').trim() || new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
if (!Number.isInteger(CO)) { console.error('Refused: COMPANY_ID is required.'); process.exit(2); }

const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '' : `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const t0 = Date.now();
    const facts = await readFinanceTodoFacts(sb, CO, TODAY, true);
    const page = buildFinanceTodo(facts, { finance: true, checker: true, approver: true, checkerNames: [], approverNames: [] });
    out(`company ${CO} · today ${page.today} · read in ${Date.now() - t0} ms`);
    out(`problems: ${page.problems.length ? page.problems.join(' | ') : 'none'}`);
    out(`facts: acquirers ${facts.acquirers.map((a) => `${a.code}(last ${facts.lastReportTo[a.code] ?? '—'}${facts.keyedCardDays[a.code] ? `, keyed ${facts.keyedCardDays[a.code].join(',')}` : ''})`).join(' ')}`);
    out(`facts: banks ${facts.bankAccounts.map((b) => `${b.accountCode}/${b.bankCode}(last ${facts.lastStatementTo[b.accountCode] ?? '—'})`).join(' ')} · locked last month: ${facts.lockedLastMonth.join(',') || 'none'}`);
    out(`facts: card rows ${facts.cardRows.length} · bank lines ${facts.bankLines.length} · requests ${facts.requests.length} · vouchers ${facts.vouchers.length} · transfers ${facts.transfers.length} · overdue ${facts.overdue.length}`);
    out(`--- waiting on you (${page.mine.length})`);
    for (const j of page.mine) out(`[${j.group}] ${j.rule} | ${j.title} | ${j.detail} | ${rm(j.amountSen)} | since ${j.since ?? '—'} | ${j.action.label} → ${j.action.to}`);
    out(`--- waiting on others (${page.others.length})`);
    for (const j of page.others) out(`${j.rule} | ${j.title} | who ${j.who}`);
    out(`--- done today (${page.done.length})`);
    for (const d of page.done) out(`${d.at} ${d.text}${d.je ? ` · ${d.je}` : ''}`);
    out(`--- money: ${page.money ? `bank & cash ${rm(page.money.bankCashSen)} · awaiting ${rm(page.money.awaitingSen)} · can move ${rm(page.money.bankCashSen - page.money.awaitingSen)} · on its way ${rm(page.money.onTheWaySen)}` : 'not read'}`);
    out(`--- ${page.checklist.month} checklist, ${page.checklist.daysLeft} days left`);
    for (const c of page.checklist.items) out(`${c.state.padEnd(4)} ${c.label}: ${c.value}`);
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.stack ?? e?.message ?? e}`); process.exitCode = 1; }
} finally { await sql.end(); }
