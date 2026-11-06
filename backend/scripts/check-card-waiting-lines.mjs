#!/usr/bin/env node
// check-card-waiting-lines.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// A merchant report takes no bank credit until every line of it is confirmed or set
// aside (acc/bank.ts loadPayableBatches). Which lines are waiting, and what does the
// real matcher say about each one today: one suggested payment to confirm, several to
// choose from, or no sale found? Mirrors acc/settlement-rematch.ts up to its decision
// and stops there. Also: the AEON swipes on days with no report, against the credits no
// report claims; and whether any reversal on the card account counts by itself.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadAcquirer, loadPaymentCandidates, loadSettledKeys, notThisOf } from '../src/acc/settlement.ts';
import { matchStatement } from '../src/acc/settlement-match.ts';
import { countsInTheBooks } from '../src/acc/reversal-pairs.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const C = 1;
/* The reports whose waiting lines hold back a September credit that would then match. */
const HOLDING = new Set([172, 213, 173, 148, 174, 150, 200, 175, 186, 176, 170, 160, 238, 247, 249, 255, 258, 228, 226, 222, 221, 220, 218, 217]);

await sql.begin('READ ONLY', async (tx) => {
  const sb = pgrestShim(tx, 'scm');
  const settled = await loadSettledKeys(sb, C);
  if (!settled.ok) throw new Error(`settled: ${settled.reason}`);
  const tally = new Map();
  const add = (k, sen) => { const x = tally.get(k) ?? { n: 0, sen: 0 }; x.n += 1; x.sen += sen; tally.set(k, x); };

  for (const code of ['AEON', 'MBB', 'PBB']) {
    const acq = await loadAcquirer(sb, C, code);
    if (!acq.ok) throw new Error(`acquirer ${code}: ${acq.reason}`);
    const cfg = { code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days };
    out(`== ${code}: unique reference ${cfg.has_unique_ref}, date tolerance ${cfg.date_tolerance_days} days`);
    const open = await tx`
      SELECT r.id, r.batch_id, r.line_no, r.txn_date, r.ref, r.gross_sen, r.fee_sen, r.net_sen, r.bucket, r.match_reason, r.notes, r.not_this, b.period_from, b.period_to, b.file_name
        FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
       WHERE r.company_id = ${C} AND r.acquirer_code = ${code} AND r.confirmed_at IS NULL AND r.bucket <> 'IGNORED'
       ORDER BY b.period_from, b.id, r.line_no`;
    if (open.length === 0) continue;
    const span = open.flatMap((r) => [day(r.txn_date), day(r.period_from), day(r.period_to)]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const cands = await loadPaymentCandidates(sb, C, acq.acquirer, span[0], span.at(-1), open.map((r) => r.ref).filter((r) => typeof r === 'string' && r.trim() !== ''));
    if (!cands.ok) throw new Error(`candidates ${code}: ${cands.reason}`);
    const taken = new Set(settled.keys);
    const batches = [...new Set(open.map((r) => Number(r.batch_id)))];
    for (const id of batches) {
      const rowsOf = open.filter((r) => Number(r.batch_id) === id);
      const byLine = new Map(rowsOf.map((r) => [Number(r.line_no), r]));
      const decided = matchStatement(cfg, rowsOf.map((r) => ({
        lineNo: Number(r.line_no), txnDate: day(r.txn_date), ref: r.ref, grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen),
      })), cands.payments, taken);
      for (const d of decided) {
        const r = byLine.get(d.row.lineNo);
        const turned = new Set(notThisOf(r.not_this));
        const says = d.bucket === 'MATCHED' ? 'matched by its code'
          : d.suggested.length > 0 ? 'one suggestion'
            : d.candidates.length > 0 ? 'several to choose'
              : 'no sale found';
        for (const p of d.bucket === 'MATCHED' ? d.matched : []) taken.add(`${p.source}:${p.id}`);
        const group = HOLDING.has(id) ? 'holds a Sep credit' : 'other report';
        add(`${group} | ${says}`, Number(r.gross_sen));
        add(`${code} ${group} | ${says}`, Number(r.gross_sen));
        const offered = (d.bucket === 'MATCHED' ? d.matched : d.suggested.length > 0 ? d.suggested : d.candidates).slice(0, 3);
        out(`#${id} ${day(r.txn_date)} line ${r.line_no} ${rm(r.gross_sen)} ref ${r.ref ?? '-'} stored ${r.bucket} | ${says}${turned.size ? ` (not_this ${turned.size})` : ''} | ${offered.map((p) => `${p.docNo} ${rm(p.amountSen)} ${day(p.paidOn)} code ${p.approvalCode ?? '-'}`).join('; ') || '-'} | ${String(d.clue ?? '').slice(0, 130)}`);
      }
    }
  }
  out('-- tally: lines | gross RM');
  for (const k of [...tally.keys()].sort()) out(`${k} | ${tally.get(k).n} | ${rm(tally.get(k).sen)}`);

  /* The AEON swipes on the days no AEON report covers, against the credits no report claims. */
  const aeon = await tx;
  const claimed = await tx`SELECT payment_id::text AS id FROM scm.acc_settlement_matches WHERE company_id = ${C}`;
  const byDay = new Map();
  for (const p of aeon) { const k = day(p.paid_at); byDay.set(k, (byDay.get(k) ?? 0) + Number(p.amount_sen)); }
  out(`-- AEON payments by day in September (all, claimed or not): ${[...byDay.entries()].map(([d, s]) => `${d.slice(8)} ${rm(s)}`).join(', ')}`);
  const covered = await tx`SELECT DISTINCT r.txn_date, b.file_name FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id WHERE r.company_id = ${C} AND r.acquirer_code = 'AEON' AND r.txn_date BETWEEN '2026-09-01' AND '2026-09-30' ORDER BY 1, 2`;
  out(`-- AEON report files by swipe day: ${covered.map((c) => `${day(c.txn_date).slice(8)}:${String(c.file_name).replace(/^\d+_0*/, '').replace(/\.csv$/i, '')}`).join(' ')}`);
  out(`-- claimed payment links in all: ${claimed.length}`);

  /* Does a reversal on the card account ever count by itself? */
  const gl = await tx`
    SELECT je_no, entry_date, source_type, source_doc_no, debit_sen, credit_sen, posted, reversed, reversed_by_je
      FROM scm.v_gl_entries WHERE company_id = ${C} AND account_code = '326-0000' AND source_type IN ('SOPAY', 'SOPAY_REVERSAL')`;
  const counted = gl.filter(countsInTheBooks);
  const sum = (xs) => xs.reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);
  const lone = counted.filter((l) => l.source_type === 'SOPAY_REVERSAL');
  out(`-- 326-0000 SOPAY + reversals: all ${gl.length} lines net ${rm(sum(gl))}; counted ${counted.length} net ${rm(sum(counted))}; reversals that count by themselves ${lone.length} net ${rm(sum(lone))}`);
  for (const l of lone.slice(0, 12)) out(`   ${l.je_no} ${day(l.entry_date)} ${l.source_type} ${l.source_doc_no} ${rm(Number(l.debit_sen) - Number(l.credit_sen))} reversed ${l.reversed} by ${l.reversed_by_je ?? '-'}`);
  const gaps = sb.__gaps ?? [];
  out(`shim gaps: ${JSON.stringify(gaps).slice(0, 300)}`);
});
await sql.end();
