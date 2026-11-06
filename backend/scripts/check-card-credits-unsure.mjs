#!/usr/bin/env node
// check-card-credits-unsure.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Houzs's September Maybank statement holds 63 card credits still OPEN. The month
// screen decides each one again on every read (freshDecisions, acc/bank-match.ts).
// Asks the real matcher, through the app's real loaders, what it says today; what it
// would say if every report's waiting lines were done; and which reports cover each
// credit's trading day, so the reason for each credit can be read off.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadPayableBatches, loadRecognitionRules, loadPayoutAdvices } from '../src/acc/bank.ts';
import { matchBankMovements, exactCombination } from '../src/acc/bank-match.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const C = 1;
const day = (v) => String(v ?? '').slice(0, 10);

await sql.begin('READ ONLY', async (tx) => {
  const sb = pgrestShim(tx, 'scm');
  const [rules, payable, payouts] = await Promise.all([loadRecognitionRules(sb), loadPayableBatches(sb, C), loadPayoutAdvices(sb, C)]);
  if (!rules.ok || !payable.ok || !payouts.ok) throw new Error(`load failed: ${JSON.stringify([rules.reason, payable.reason, payouts.reason])}`);
  out(`rules ${rules.rules.length}; payable reports today ${payable.batches.length}; payment advices ${payouts.payouts.length}`);
  for (const r of rules.rules) out(`  rule ${r.acquirerCode} /${r.pattern}/ day=/${r.tradingDatePattern ?? ''}/ merchant=/${r.merchantPattern ?? ''}/`);
  for (const p of payouts.payouts) out(`  advice ${p.acquirerCode} ${p.adviceDate ?? '-'} ${rm(p.netSen)} days ${p.days.length} ${p.fileName ?? ''}`);

  const lines = await tx`
    SELECT l.id, l.line_no, l.booked_on, l.description, l.reference, l.amount_sen, l.charge_sen, l.state, l.kind, l.acquirer_code, s.account_code, s.file_name, s.created_at AS stmt_at
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = ${C} AND l.state = 'OPEN' AND l.amount_sen > 0
     ORDER BY l.booked_on, l.line_no`;
  out(`open money-in lines on Houzs statements: ${lines.length}; statement uploaded ${lines[0]?.stmt_at ?? '-'} (${lines[0]?.file_name ?? '-'})`);

  const movementOf = (l) => ({
    lines: [{ lineNo: Number(l.line_no ?? 0), bookedOn: day(l.booked_on), description: String(l.description ?? ''), reference: l.reference ?? null, amountSen: Number(l.amount_sen ?? 0) + Number(l.charge_sen ?? 0), balanceSen: null }],
    bookedOn: day(l.booked_on),
    description: String(l.description ?? ''),
    reference: l.reference ?? null,
    amountSen: Number(l.amount_sen ?? 0),
    chargeSen: Number(l.charge_sen ?? 0),
  });
  const movements = lines.map(movementOf);
  const today = matchBankMovements({ movements, rules: rules.rules, batches: payable.batches, payouts: payouts.payouts });

  /* Every report of Houzs, reconciled or not. */
  const [batches, rows, receipts, charges] = await Promise.all([
    tx`SELECT id, acquirer_code, file_name, period_from, period_to, net_sen, stated_net_sen, created_at FROM scm.acc_settlement_batches WHERE company_id = ${C}`,
    tx`SELECT batch_id, confirmed_at, bucket, gross_sen FROM scm.acc_settlement_rows WHERE company_id = ${C}`,
    tx`SELECT batch_id, amount_sen, charge_sen, je_no FROM scm.acc_settlement_receipts WHERE company_id = ${C}`,
    tx`SELECT batch_id, charge_sen FROM scm.acc_settlement_payout_batches WHERE company_id = ${C}`,
  ]);
  const waitingOf = new Map();
  const rowsOf = new Map();
  for (const r of rows) {
    const id = Number(r.batch_id);
    rowsOf.set(id, (rowsOf.get(id) ?? 0) + 1);
    if (!r.confirmed_at && r.bucket !== 'IGNORED') waitingOf.set(id, (waitingOf.get(id) ?? 0) + 1);
  }
  const gotOf = new Map();
  for (const r of receipts) gotOf.set(Number(r.batch_id), (gotOf.get(Number(r.batch_id)) ?? 0) + Number(r.amount_sen ?? 0) + Number(r.charge_sen ?? 0));
  for (const r of charges) if (r.batch_id != null) gotOf.set(Number(r.batch_id), (gotOf.get(Number(r.batch_id)) ?? 0) + Number(r.charge_sen ?? 0));
  const all = batches.map((b) => {
    const id = Number(b.id);
    const payableSen = Number(b.stated_net_sen ?? b.net_sen ?? 0);
    return {
      id, acquirerCode: String(b.acquirer_code), fileName: b.file_name ?? undefined,
      periodFrom: day(b.period_from), periodTo: day(b.period_to), payableSen,
      outstandingSen: payableSen - (gotOf.get(id) ?? 0), waiting: waitingOf.get(id) ?? 0, rowCount: rowsOf.get(id) ?? 0,
    };
  });
  const owedAll = all.filter((b) => b.outstandingSen !== 0);

  /* What if every waiting line were done: the same matcher over every report still owed. */
  const ifDone = matchBankMovements({ movements, rules: rules.rules, batches: owedAll, payouts: payouts.payouts });

  /* The same again, but only reports whose days could be in this credit: the matcher's
     combination search only looks at the oldest 12, so stale reports can hide the answer. */
  const windowed = (m, acq) => owedAll.filter((b) => b.acquirerCode === acq && b.periodFrom <= m.bookedOn && b.periodTo >= addDays(m.bookedOn, -21));
  function addDays(d, n) { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

  const tally = (rowsIn, keyOf) => {
    const m = new Map();
    for (const r of rowsIn) {
      const k = keyOf(r);
      const x = m.get(k) ?? { n: 0, sen: 0 };
      x.n += 1; x.sen += r.sen;
      m.set(k, x);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  const report = [];
  out('-- each open credit: date | RM | charge | bank text | stored kind | today: kind (batch/split) | if waiting lines done: kind | window combo | trading day | reports covering that day (id owed waiting)');
  lines.forEach((l, i) => {
    const d = today[i];
    const f = ifDone[i];
    if (!d.acquirerCode && !String(l.kind).startsWith('PAYOUT')) return;
    const sen = Number(l.amount_sen);
    const acq = d.acquirerCode ?? l.acquirer_code;
    const pool = windowed(movements[i], acq);
    const combo = exactCombination(pool, sen);
    const single = pool.filter((b) => b.outstandingSen === sen);
    const cover = d.tradingDate ? all.filter((b) => b.acquirerCode === acq && d.tradingDate >= b.periodFrom && d.tradingDate <= b.periodTo) : [];
    const lone = cover.length === 1 ? cover[0] : null;
    const windowSays = single.length === 1 ? `single#${single[0].id}` : single.length > 1 ? `${single.length} singles` : combo.length > 0 ? `combo ${combo.map((b) => `#${b.id}`).join('+')}` : `none of ${pool.length}`;
    report.push({ acq, sen, today: d.kind, ifDone: f.kind, windowSays: windowSays.split(' ')[0].replace(/#.*/, ''), onDay: !d.tradingDate ? 'bank names no day' : cover.length === 0 ? 'no report for that day' : lone ? (lone.outstandingSen === sen ? 'that report owes the same' : 'that report owes a different amount') : 'several reports cover it', line: l, d });
    out(`${day(l.booked_on)} | ${rm(sen)} | ${rm(l.charge_sen)} | ${String(l.description ?? '').replace(/\s+/g, ' ').slice(0, 60)} | ${l.kind} | ${d.kind}${d.batchId ? ` #${d.batchId}` : ''}${d.split.length ? ` split ${d.split.map((s) => `#${s.batchId} ${rm(s.amountSen)}`).join('+')}` : ''} | ${f.kind}${f.batchId ? ` #${f.batchId}` : ''}${f.split.length ? ` split ${f.split.map((s) => `#${s.batchId}`).join('+')}` : ''} | ${windowSays} | ${d.tradingDate ?? '-'} | ${cover.map((b) => `#${b.id} ${rm(b.outstandingSen)} w${b.waiting}`).join(', ') || '-'}`);
    if (i < 3 || d.kind === 'PAYOUT' || d.kind === 'PAYOUT_SPLIT') out(`     clue: ${String(d.clue ?? '').slice(0, 220)}`);
  });

  out('-- tally by acquirer and what the matcher says TODAY: count | RM');
  for (const [k, x] of tally(report, (r) => `${r.acq} ${r.today}`)) out(`${k} | ${x.n} | ${rm(x.sen)}`);
  out('-- tally by acquirer and what it would say with every report counted (waiting lines done): count | RM');
  for (const [k, x] of tally(report, (r) => `${r.acq} ${r.ifDone}`)) out(`${k} | ${x.n} | ${rm(x.sen)}`);
  out('-- tally by acquirer, among reports of the last 21 days only: single / combo / none: count | RM');
  for (const [k, x] of tally(report, (r) => `${r.acq} ${r.windowSays}`)) out(`${k} | ${x.n} | ${rm(x.sen)}`);
  out('-- tally by acquirer and the day the bank names: count | RM');
  for (const [k, x] of tally(report, (r) => `${r.acq} ${r.onDay}`)) out(`${k} | ${x.n} | ${rm(x.sen)}`);

  out('-- reports by acquirer: all | fully paid | payable today (count, owed RM) | held back by waiting lines (count, owed RM, lines)');
  for (const acq of [...new Set(all.map((b) => b.acquirerCode))].sort()) {
    const mine = all.filter((b) => b.acquirerCode === acq);
    const paid = mine.filter((b) => b.outstandingSen === 0);
    const open = mine.filter((b) => b.outstandingSen !== 0 && b.waiting === 0);
    const held = mine.filter((b) => b.waiting > 0 && b.outstandingSen !== 0);
    const sum = (xs, f) => xs.reduce((s, b) => s + f(b), 0);
    out(`${acq} | ${mine.length} | ${paid.length} | ${open.length}, ${rm(sum(open, (b) => b.outstandingSen))} | ${held.length}, ${rm(sum(held, (b) => b.outstandingSen))}, ${sum(held, (b) => b.waiting)}`);
  }
  const listPeriod = (b) => `#${b.id} ${b.periodFrom}..${b.periodTo} owed ${rm(b.outstandingSen)} of ${rm(b.payableSen)} lines ${b.rowCount} waiting ${b.waiting} ${b.fileName ?? ''}`;
  out('-- the oldest 14 reports still owed per acquirer (the combination search only ever looks at the oldest 12):');
  for (const acq of ['AEON', 'MBB', 'PBB']) {
    const payableMine = payable.batches.filter((b) => b.acquirerCode === acq).sort((a, b) => a.periodFrom.localeCompare(b.periodFrom));
    out(`  ${acq}: payable today ${payableMine.length}; oldest: ${payableMine.slice(0, 14).map((b) => `#${b.id} ${b.periodFrom} ${rm(b.outstandingSen)}`).join(', ')}`);
  }
  out('-- every report with period up to 2026-10-05 still owed:');
  for (const b of owedAll.filter((x) => x.periodFrom <= '2026-10-05').sort((a, z) => a.acquirerCode.localeCompare(z.acquirerCode) || a.periodFrom.localeCompare(z.periodFrom))) out(`${b.acquirerCode} ${listPeriod(b)}`);

  out('-- 326-0000 on the books: month source | debit | credit');
  const gl = await tx`
    SELECT to_char(entry_date, 'YYYY-MM') AS month, source_type, sum(debit_sen)::bigint AS dr, sum(credit_sen)::bigint AS cr, count(*)::int AS n
      FROM scm.v_gl_entries WHERE company_id = ${C} AND account_code = '326-0000' AND posted GROUP BY 1, 2 ORDER BY 1, 2`;
  let balance = 0;
  for (const g of gl) { balance += Number(g.dr) - Number(g.cr); out(`${g.month} ${g.source_type} | ${rm(g.dr)} | ${rm(g.cr)} | ${g.n}`); }
  out(`326-0000 balance: ${rm(balance)}`);
});
await sql.end();
