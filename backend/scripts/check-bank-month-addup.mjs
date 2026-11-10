#!/usr/bin/env node
// check-bank-month-addup.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10, screenshot of 2990 HLB October: "These numbers do not add up — The difference
// of RM 9,295.12 does not equal what is unmatched on either side … = RM 200.02" 「这个是什么意思」.
// Reads the month exactly as the screen does (GET /bank/months/:account/:month, the shipped
// handler through pgrest-shim) and splits the RM 9,095.10 between the two things that break
// the identity:
//  A. the files: opening printed + every line not left out ≠ closing printed (a missing day,
//     a repeat counted twice, a line read wrong) — per file and for the month;
//  B. the matches: a POSTED line whose amount differs from the entries it claims, or that
//     claims an entry dated outside the month / on no ledger line of this account.
// Env: DATABASE_URL, COMPANY_ID (default 2), ACCOUNT (default 310-0020), MONTH (default 2026-10).
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const ACCOUNT = String(process.env.ACCOUNT || '310-0020');
const MONTH = String(process.env.MONTH || '2026-10');
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const short = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const N = (v) => Number(v ?? 0);

try {
  await sql.begin('read only', async (tx) => {
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
    if (res.status !== 200) { row('REFUSED', res.status, JSON.stringify(body).slice(0, 400)); return; }
    const a = body.assembly; const r = body.reconciliation;

    head(`co${CO} ${ACCOUNT} ${MONTH}: the month as the screen reads it`);
    row('PERIOD', `${a.periodFrom}..${a.periodTo}`, `opening ${rm(a.statementOpeningSen)} from ${a.openingFrom?.fileName ?? '—'} (${a.openingFrom?.on ?? ''})`, `closing ${rm(a.statementClosingSen)} from ${a.closingFrom?.fileName ?? '—'} (${a.closingFrom?.on ?? ''})`, a.complete ? 'complete' : 'NOT complete');
    for (const g of a.gaps ?? []) row('GAP', short(g, 300));
    for (const b of a.breaks ?? []) row('BREAK', b.beforeFile, b.beforeTo, rm(b.beforeClosingSen), '→', b.afterFile, b.afterFrom, rm(b.afterOpeningSen), `gap ${rm(b.gapSen)}`);
    row('RECON', `opening stmt ${rm(r.openingStatementSen)} ledger ${rm(r.openingLedgerSen)} bf ${rm(r.broughtForwardSen)}`,
      `moved stmt ${rm(r.movementsStatementSen)} ledger ${rm(r.movementsLedgerSen)}`,
      `closing stmt ${rm(r.closingStatementSen)} ledger ${rm(r.closingLedgerSen)} diff ${rm(r.differenceSen)}`,
      `bank-not-books ${r.bankNotInBooks.count}/${rm(r.bankNotInBooks.sen)} books-not-bank ${r.booksNotOnBank.count}/${rm(r.booksNotOnBank.sen)}`,
      `carried ${r.carried.count}/${rm(r.carried.sen)} cleared-from-before ${rm(r.clearedFromBeforeSen)}`,
      `consistent ${r.consistent} unexplained ${rm(r.unexplainedSen)} tallies ${r.tallies}`);
    row('REPEATS', `count ${body.repeats?.count ?? 0}`, `statements ${(body.repeats?.statementIds ?? []).join(',') || '—'}`);

    head('A. the files: printed balances against their own lines');
    const lines = body.lines;
    const liveSum = lines.filter((l) => l.state !== 'IGNORED').reduce((s, l) => s + N(l.amount_sen), 0);
    row('MONTH_FILES', `closing − opening ${rm(N(a.statementClosingSen) - N(a.statementOpeningSen))}`, `lines not left out ${rm(liveSum)}`, `files short by ${rm(N(a.statementClosingSen) - N(a.statementOpeningSen) - liveSum)}`);
    for (const s of body.statements) {
      const mine = lines.filter((l) => N(l.statement_id) === N(s.id));
      const live = mine.filter((l) => l.state !== 'IGNORED');
      const allOfFile = await tx`SELECT count(*)::int AS n, coalesce(sum(amount_sen), 0)::bigint AS sen,
          coalesce(sum(amount_sen) FILTER (WHERE state <> 'IGNORED'), 0)::bigint AS live FROM scm.acc_bank_statement_lines WHERE statement_id = ${s.id}`;
      const f = allOfFile[0];
      const opening = s.opening_balance_sen ?? s.openingBalanceSen; const closing = s.closing_balance_sen ?? s.closingBalanceSen;
      row('FILE', `st${s.id}`, short(s.file_name, 50), `${d10(s.period_from)}..${d10(s.period_to)}`, `uploaded ${d10(s.created_at)} ${String(s.created_at ?? '').slice(11, 16)}`, s.spanning ? 'SPANS the month edge' : 'inside',
        `opening ${rm(opening)} closing ${rm(closing)}`,
        `all its lines ${f.n} net ${rm(f.sen)} (not left out ${rm(f.live)})`,
        opening != null && closing != null ? `file short by ${rm(N(closing) - N(opening) - N(f.sen))}` : 'no pair of balances',
        `in ${MONTH}: ${mine.length} lines (${live.length} not left out)`);
    }
    /* The same movement in two files, neither left out. */
    const key = (l) => `${d10(l.booked_on)}|${N(l.amount_sen)}`;
    const byKey = new Map();
    for (const l of lines.filter((x) => x.state !== 'IGNORED')) byKey.set(key(l), [...(byKey.get(key(l)) ?? []), l]);
    for (const [k, ls] of byKey) {
      if (new Set(ls.map((l) => N(l.statement_id))).size < 2) continue;
      row('TWICE', k, ls.map((l) => `st${l.statement_id} #${l.line_no} ${l.state} ${short(l.description, 30)} ${short(l.reference, 30)}`).join(' ‖ '));
    }

    head('B. the matches: POSTED lines against the entries they claim');
    const posted = lines.filter((l) => l.state === 'POSTED');
    const jeOfLine = (l) => [...new Set([...String(l.posted_je_no ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...(l.matches ?? []).map((m) => m.je_no)])];
    const jes = [...new Set(posted.flatMap(jeOfLine))];
    const gl = jes.length === 0 ? [] : await tx`
      SELECT je_no, min(entry_date)::text AS d, sum(debit_sen - credit_sen)::bigint AS net, max(source_type) AS t, max(source_doc_no) AS doc,
             bool_or(coalesce(reversed, false) OR reversed_by_je IS NOT NULL) AS in_pair
        FROM scm.v_gl_entries WHERE company_id = ${CO} AND account_code = ${ACCOUNT} AND je_no IN ${tx(jes)} GROUP BY je_no`;
    const glOf = new Map(gl.map((g) => [g.je_no, g]));
    let off = 0;
    /* An entry claimed by several lines: each line's share is its match row's amount. */
    for (const l of posted) {
      const mine = jeOfLine(l);
      const nets = mine.map((j) => glOf.get(j));
      const missing = mine.filter((j) => !glOf.has(j));
      const outside = nets.filter((g) => g && (g.d < a.periodFrom || g.d > a.periodTo));
      const pairs = nets.filter((g) => g && g.in_pair);
      const total = nets.reduce((s, g) => s + N(g?.net), 0);
      const shared = (l.matches ?? []).length > 0 && (l.matches ?? []).some((m) => N(m.amount_sen) !== total);
      if (total !== N(l.amount_sen) || missing.length || outside.length || pairs.length) {
        off += N(l.amount_sen) - total;
        row('CLAIM', d10(l.booked_on), `st${l.statement_id} #${l.line_no}`, rm(l.amount_sen), short(l.description, 30), short(l.reference, 35),
          `claims ${mine.join('+') || '—'} net ${rm(total)}`, missing.length ? `NOT on ${ACCOUNT}: ${missing.join(',')}` : '',
          outside.length ? `dated outside: ${outside.map((g) => `${g.je_no} ${g.d}`).join(',')}` : '', pairs.length ? `in a reversal pair: ${pairs.map((g) => g.je_no).join(',')}` : '',
          shared ? `match rows ${(l.matches ?? []).map((m) => `${m.je_no}:${rm(m.amount_sen)}`).join(',')}` : '');
      }
    }
    row('CLAIMS_OFF', `lines minus their entries ${rm(off)}`);
    head('C. the month\'s lines, in order (date · file · state · amount · text · what it holds)');
    for (const l of [...lines].sort((x, y) => d10(x.booked_on).localeCompare(d10(y.booked_on)) || N(x.statement_id) - N(y.statement_id) || N(x.line_no) - N(y.line_no))) {
      row('LINE', d10(l.booked_on), `st${l.statement_id} #${l.line_no}`, l.state, rm(l.amount_sen), short(l.description, 32), short(l.reference, 40), jeOfLine(l).join('+') || '—', short(l.note, 50));
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
