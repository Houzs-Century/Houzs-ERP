#!/usr/bin/env node
// check-card-not-in-bank.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Why is "Card - not yet in the bank" on the Cash Flow so large? Walks every card
// swipe (a SOPAY / SIPAY journal line on a card clearing account) down the chain
// acc/card-in-bank.ts reads: the payment, the settlement line that claims it, that
// line's statement, the statement's bank credits. Says where each ringgit stops.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { countsInTheBooks } from '../src/acc/reversal-pairs.ts';
import { inBankShares, paymentKey } from '../src/acc/card-in-bank.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => `${(Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const add = (map, key, field, sen) => { const r = map.get(key) ?? {}; r[field] = (r[field] ?? 0) + sen; map.set(key, r); };

await sql.begin('READ ONLY', async (tx) => {
  const companies = await tx`SELECT id, code FROM public.companies ORDER BY id`;
  for (const co of companies) {
    const c = Number(co.id);
    out(`==== company ${c} (${co.code}) as at ${TODAY}`);
    const acquirers = await tx`SELECT code, display_name, transit_account_code, bank_account_code, is_active FROM scm.acc_acquirers WHERE company_id = ${c} ORDER BY code`;
    const [role] = await tx`SELECT account_code FROM scm.acc_account_roles WHERE company_id = ${c} AND role = 'TRANSIT_EDC'`;
    const edc = role?.account_code ?? '326-0000';
    const codes = [...new Set([edc, ...acquirers.map((a) => a.transit_account_code)].filter(Boolean))];
    out(`clearing accounts: ${codes.join(', ')}`);
    for (const a of acquirers) out(`  acquirer ${a.code} (${a.display_name}) transit ${a.transit_account_code} bank ${a.bank_account_code ?? '-'} ${a.is_active ? '' : 'inactive'}`);

    const lines = (await tx`
      SELECT je_no, entry_date, source_type, source_doc_no, account_code, debit_sen, credit_sen, posted, reversed, reversed_by_je
        FROM scm.v_gl_entries
       WHERE company_id = ${c} AND account_code IN ${tx(codes)} AND source_type IN ('SOPAY', 'SIPAY')`).filter(countsInTheBooks);
    const [matches, rows, batches, receipts] = await Promise.all([
      tx`SELECT payment_source, payment_id, settlement_row_id FROM scm.acc_settlement_matches WHERE company_id = ${c}`,
      tx`SELECT id, batch_id, acquirer_code, txn_date, gross_sen, net_sen, bucket, confirmed_at FROM scm.acc_settlement_rows WHERE company_id = ${c}`,
      tx`SELECT id, acquirer_code, file_name, period_from, period_to, row_count, gross_sen, net_sen, stated_net_sen, status, created_at FROM scm.acc_settlement_batches WHERE company_id = ${c}`,
      tx`SELECT batch_id, received_on, amount_sen, charge_sen, je_no, bank_line_id FROM scm.acc_settlement_receipts WHERE company_id = ${c}`,
    ]);
    const facts = {
      matches: matches.map((m) => ({ ...m, settlement_row_id: Number(m.settlement_row_id) })),
      rows: rows.map((r) => ({ id: Number(r.id), batch_id: Number(r.batch_id) })),
      batches: batches.map((b) => ({ id: Number(b.id), stated_net_sen: b.stated_net_sen == null ? null : Number(b.stated_net_sen), net_sen: b.net_sen == null ? null : Number(b.net_sen) })),
      receipts: receipts.map((r) => ({ batch_id: Number(r.batch_id), received_on: r.received_on, amount_sen: Number(r.amount_sen), charge_sen: r.charge_sen == null ? null : Number(r.charge_sen), je_no: r.je_no })),
    };
    const shareNow = inBankShares(facts, TODAY);
    const shareAt = new Map();
    const atMonthEnd = (m) => { if (!shareAt.has(m)) shareAt.set(m, inBankShares(facts, monthEnd(m))); return shareAt.get(m); };

    const pays = await tx`SELECT id::text AS id, merchant_provider, method FROM scm.mfg_sales_order_payments WHERE company_id = ${c}`;
    const payById = new Map(pays.map((p) => [String(p.id), p]));
    const acqOfAccount = new Map();
    for (const a of acquirers) acqOfAccount.set(a.transit_account_code, [...(acqOfAccount.get(a.transit_account_code) ?? []), a.code]);
    const matchKeys = new Map(matches.map((m) => [paymentKey(m.payment_source, String(m.payment_id)), Number(m.settlement_row_id)]));
    const rowById = new Map(rows.map((r) => [Number(r.id), r]));
    /* Which acquirer + day a report covers: its period, or a line on that day. */
    const covered = new Set();
    for (const r of rows) covered.add(`${r.acquirer_code}|${String(r.txn_date).slice(0, 10)}`);
    const coversDay = (acq, day) => covered.has(`${acq}|${day}`) || batches.some((b) => b.acquirer_code === acq && b.period_from && b.period_to && String(b.period_from).slice(0, 10) <= day && day <= String(b.period_to).slice(0, 10));
    const receivedOf = new Map();
    for (const r of receipts) if (r.je_no) receivedOf.set(Number(r.batch_id), (receivedOf.get(Number(r.batch_id)) ?? 0) + Number(r.amount_sen));

    const byMonth = new Map();
    const byMonthAcq = new Map();
    const noReportDays = new Map();
    let negative = 0;
    for (const l of lines) {
      const sen = Number(l.debit_sen) - Number(l.credit_sen);
      if (sen === 0) continue;
      if (sen < 0) negative += sen;
      const day = String(l.entry_date).slice(0, 10);
      const month = day.slice(0, 7);
      const key = paymentKey(String(l.source_type), String(l.source_doc_no));
      const now = Math.round(sen * (shareNow.get(key) ?? 0));
      const atEnd = Math.round(sen * (atMonthEnd(month).get(key) ?? 0));
      const rowId = matchKeys.get(key);
      const row = rowId ? rowById.get(rowId) : undefined;
      const pay = payById.get(String(l.source_doc_no));
      const candidates = acqOfAccount.get(l.account_code) ?? [];
      const provider = String(pay?.merchant_provider ?? '').trim();
      const acq = row?.acquirer_code ?? (candidates.includes(provider) ? provider : candidates.find((x) => x.toUpperCase() === provider.toUpperCase()) ?? (candidates.length === 1 ? candidates[0] : provider || '(unknown)'));
      const rest = sen - now;
      const stage = rest === 0 ? null
        : row ? (row.confirmed_at ? 'statementNoCredit' : 'linkedNotConfirmed')
          : coversDay(acq, day) ? 'reportNotClaimed' : 'noReport';
      const k2 = `${month} ${acq}`;
      for (const [map, kk] of [[byMonth, month], [byMonthAcq, k2]]) {
        add(map, kk, 'swipes', sen);
        add(map, kk, 'inBankNow', now);
        add(map, kk, 'inBankAtMonthEnd', atEnd);
        if (stage) add(map, kk, stage, rest);
      }
      if (stage === 'noReport') add(noReportDays, `${acq} ${month}`, 'sen', rest);
    }
    out('-- by swipe month: swipes | in bank at month end (what By month shows) | in bank today | not in bank today, of which: statement confirmed but no bank credit booked | linked, not confirmed | report covers the day, payment not claimed | no report for the day');
    for (const k of [...byMonth.keys()].sort()) {
      const r = byMonth.get(k);
      out(`${k} | ${rm(r.swipes)} | ${rm(r.inBankAtMonthEnd)} | ${rm(r.inBankNow)} | ${rm(r.swipes - r.inBankNow)} = ${rm(r.statementNoCredit)} + ${rm(r.linkedNotConfirmed)} + ${rm(r.reportNotClaimed)} + ${rm(r.noReport)}`);
    }
    out('-- by swipe month and acquirer (same columns)');
    for (const k of [...byMonthAcq.keys()].sort()) {
      const r = byMonthAcq.get(k);
      out(`${k} | ${rm(r.swipes)} | ${rm(r.inBankAtMonthEnd)} | ${rm(r.inBankNow)} | ${rm(r.swipes - r.inBankNow)} = ${rm(r.statementNoCredit)} + ${rm(r.linkedNotConfirmed)} + ${rm(r.reportNotClaimed)} + ${rm(r.noReport)}`);
    }
    out(`negative swipe lines (money back): ${rm(negative)}`);

    out('-- merchant reports uploaded, by acquirer and month of the period: reports | net RM | bank credits booked RM | lines by bucket');
    const rep = new Map();
    for (const b of batches) {
      const k = `${b.acquirer_code} ${String(b.period_from ?? b.created_at).slice(0, 7)}`;
      const net = Number(b.stated_net_sen ?? b.net_sen ?? 0);
      add(rep, k, 'n', 1);
      add(rep, k, 'net', net);
      add(rep, k, 'got', receivedOf.get(Number(b.id)) ?? 0);
    }
    const buckets = new Map();
    for (const r of rows) {
      const b = batches.find((x) => Number(x.id) === Number(r.batch_id));
      const k = `${r.acquirer_code} ${String(b?.period_from ?? b?.created_at ?? '').slice(0, 7)}`;
      const state = r.confirmed_at ? 'CONFIRMED' : r.bucket;
      const m = buckets.get(k) ?? {};
      m[state] = (m[state] ?? 0) + 1;
      buckets.set(k, m);
    }
    for (const k of [...rep.keys()].sort()) {
      const r = rep.get(k);
      out(`${k} | ${r.n} | ${rm(r.net)} | ${rm(r.got)} | ${JSON.stringify(buckets.get(k) ?? {})}`);
    }

    out('-- bank statements, by account and month: lines | money in RM | card payout credits still OPEN (count, RM) | booked payout credits (count, RM)');
    const bank = await tx`
      SELECT s.account_code, to_char(l.booked_on, 'YYYY-MM') AS month, l.kind, l.state, count(*)::int AS n, sum(l.amount_sen)::bigint AS sen
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE l.company_id = ${c}
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`;
    const bm = new Map();
    for (const r of bank) {
      const k = `${r.account_code} ${r.month}`;
      add(bm, k, 'lines', r.n);
      if (Number(r.sen) > 0) add(bm, k, 'in', Number(r.sen));
      if (String(r.kind).startsWith('PAYOUT')) {
        add(bm, k, r.state === 'OPEN' ? 'openN' : 'doneN', r.n);
        add(bm, k, r.state === 'OPEN' ? 'open' : 'done', Number(r.sen));
      }
    }
    for (const k of [...bm.keys()].sort()) {
      const r = bm.get(k);
      out(`${k} | ${r.lines ?? 0} | ${rm(r.in)} | ${r.openN ?? 0}, ${rm(r.open)} | ${r.doneN ?? 0}, ${rm(r.done)}`);
    }
    const months = await tx`SELECT account_code, to_char(period_from, 'YYYY-MM') AS month, count(*)::int AS n, min(period_from)::text AS f, max(period_to)::text AS t FROM scm.acc_bank_statements WHERE company_id = ${c} GROUP BY 1, 2 ORDER BY 1, 2`;
    out(`statements filed: ${months.map((m) => `${m.account_code} ${m.month}×${m.n}`).join(', ')}`);
  }
});
await sql.end();
