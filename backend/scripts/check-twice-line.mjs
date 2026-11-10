#!/usr/bin/env node
// check-twice-line.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 (2990 HLB November): one transfer shows twice, line 29 and line 39 of
// the same day and amount — 为什么会出现两次啊？ Same file, or two files carrying one day?
// And does the month (the shipped GET /bank/months handler) offer to leave the repeat out?
// Prints ids, line numbers, dates and yes/no only — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_ID (default 2), ACCOUNT (default 310-0020), MONTH (default 2026-11),
//      LINE_ID (default 1064 — one of the two lines).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const ACCOUNT = String(process.env.ACCOUNT || '310-0020');
const MONTH = String(process.env.MONTH || '2026-11');
const LINE = Number(process.env.LINE_ID || 1064);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const yn = (b) => (b ? 'yes' : 'no');
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const t16 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 16);

try {
  await sql.begin('read only', async (tx) => {
    const [base] = await tx`SELECT l.id, l.statement_id, l.booked_on::text AS d, l.amount_sen, l.description, coalesce(l.reference, '') AS ref, s.account_code
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id WHERE l.company_id = ${CO} AND l.id = ${LINE}`;
    if (!base) { row('NO_LINE', LINE); return; }
    row('BASE', `line ${base.id}`, `st${base.statement_id}`, base.d, `account ${base.account_code}`);

    /* Every line of that account, that day and that amount. */
    const twins = await tx`SELECT l.id, l.statement_id, l.line_no, l.state, l.kind, l.posted_je_no IS NOT NULL AS has_entry,
        l.description = ${base.description} AS same_text, coalesce(l.reference, '') = ${base.ref} AS same_ref
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
      WHERE l.company_id = ${CO} AND s.account_code = ${base.account_code} AND l.booked_on = ${base.d} AND l.amount_sen = ${base.amount_sen}
      ORDER BY l.statement_id, l.line_no`;
    for (const t of twins) row('SAME_DAY_AMOUNT', `line ${t.id}`, `st${t.statement_id} #${t.line_no}`, t.state, `kind ${t.kind}`, `same text ${yn(t.same_text)}`, `same ref ${yn(t.same_ref)}`, `has entry ${yn(t.has_entry)}`);
    row('IN_ONE_FILE', yn(new Set(twins.map((t) => Number(t.statement_id))).size === 1), `lines ${twins.length}`);

    /* The files they came from: what each covers, when it came, and how much of it another file of the account also holds. */
    for (const sid of [...new Set(twins.map((t) => Number(t.statement_id)))]) {
      const [s] = await tx`SELECT id, period_from, period_to, created_at, status FROM scm.acc_bank_statements WHERE id = ${sid}`;
      const [c] = await tx`SELECT count(*)::int AS n,
          count(*) FILTER (WHERE state = 'IGNORED')::int AS ignored,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.acc_bank_statement_lines o JOIN scm.acc_bank_statements os ON os.id = o.statement_id
             WHERE os.account_code = ${base.account_code} AND o.company_id = ${CO} AND o.statement_id <> l.statement_id
               AND o.booked_on = l.booked_on AND o.amount_sen = l.amount_sen AND o.description = l.description))::int AS twin_elsewhere,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.acc_bank_statement_lines o
             WHERE o.statement_id = l.statement_id AND o.id <> l.id
               AND o.booked_on = l.booked_on AND o.amount_sen = l.amount_sen AND o.description = l.description))::int AS twin_same_file,
          min(booked_on)::text AS first_day, max(booked_on)::text AS last_day
        FROM scm.acc_bank_statement_lines l WHERE l.statement_id = ${sid}`;
      row('FILE', `st${s.id}`, `period ${d10(s.period_from)}..${d10(s.period_to)}`, `lines dated ${c.first_day}..${c.last_day}`, `uploaded ${t16(s.created_at)}`, `status ${s.status}`,
        `lines ${c.n}`, `left out ${c.ignored}`, `with a twin in another file ${c.twin_elsewhere}`, `with a twin in this same file ${c.twin_same_file}`);
    }

    /* The month as the screen reads it: does it offer to leave repeats out, and which files. */
    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
      c.set('houzsUser', { name: 'read-only check', permissions_set: ['scm.payment_voucher.post'] });
      await next();
    });
    app.get('/bank/months/:accountCode/:month', bankMonthDetail);
    const res = await app.request(`/bank/months/${encodeURIComponent(ACCOUNT)}/${MONTH}`);
    const body = await res.json();
    if (res.status !== 200) { row('MONTH_REFUSED', res.status); return; }
    row('MONTH_REPEATS', `count ${body.repeats?.count ?? 0}`, `files ${(body.repeats?.statementIds ?? []).map((i) => `st${i}`).join(',') || '—'}`);
    const shown = body.lines.filter((l) => twins.some((t) => Number(t.id) === Number(l.id)));
    for (const l of shown) row('ON_SCREEN', `line ${l.id}`, `st${l.statement_id} #${l.line_no}`, l.state, `kind ${l.kind}`, `candidates ${(l.entryCandidates ?? []).length}`);
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
