#!/usr/bin/env node
// check-card-merchant-to-bank.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06: 「merchant 对的上 cash flow 就算收到了可以吗？还是分多一个 condition？」
// Evidence for that decision, from what has already happened: once a merchant report
// matches, how many days until the bank credit, did the money always arrive, was it the
// amount the report said, and how much sits between "matched" and "in the bank" at a
// month end. Also the three rows the split would print, by month and by Deposit / Balance.
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
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const gapOf = (a, b) => Math.round((Date.parse(`${day(a)}T00:00:00Z`) - Date.parse(`${day(b)}T00:00:00Z`)) / 86_400_000);
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');

await sql.begin('READ ONLY', async (tx) => {
  const companies = await tx`SELECT id, code FROM public.companies ORDER BY id`;
  for (const co of companies) {
    const c = Number(co.id);
    out(`==== company ${c} (${co.code})`);
    const [batches, rows, receipts, charges, matches, acquirers, statements] = await Promise.all([
      tx`SELECT id, acquirer_code, file_name, period_from, period_to, net_sen, stated_net_sen, created_at FROM scm.acc_settlement_batches WHERE company_id = ${c}`,
      tx`SELECT id, batch_id, acquirer_code, txn_date, gross_sen, net_sen, bucket, confirmed_at FROM scm.acc_settlement_rows WHERE company_id = ${c}`,
      tx`SELECT batch_id, received_on, amount_sen, charge_sen, je_no FROM scm.acc_settlement_receipts WHERE company_id = ${c}`,
      tx`SELECT batch_id, charge_sen FROM scm.acc_settlement_payout_batches WHERE company_id = ${c}`,
      tx`SELECT payment_source, payment_id, settlement_row_id FROM scm.acc_settlement_matches WHERE company_id = ${c}`,
      tx`SELECT code, transit_account_code, bank_account_code FROM scm.acc_acquirers WHERE company_id = ${c}`,
      tx`SELECT account_code, period_from, period_to FROM scm.acc_bank_statements WHERE company_id = ${c}`,
    ]);

    /* 1. Days from the report's last day to the bank credit. */
    const batchById = new Map(batches.map((b) => [Number(b.id), b]));
    const booked = receipts.filter((r) => r.je_no);
    const BUCKETS = [[-99, -1, 'before'], [0, 0, '0'], [1, 1, '1'], [2, 2, '2'], [3, 3, '3'], [4, 7, '4-7'], [8, 30, '8-30'], [31, 9999, '31+']];
    const gaps = new Map();
    for (const r of booked) {
      const b = batchById.get(Number(r.batch_id));
      if (!b?.period_to) continue;
      const gap = gapOf(r.received_on, b.period_to);
      const label = BUCKETS.find(([lo, hi]) => gap >= lo && gap <= hi)?.[2] ?? '?';
      for (const k of [String(b.acquirer_code), 'ALL']) {
        const m = gaps.get(k) ?? new Map();
        const x = m.get(label) ?? { n: 0, sen: 0 };
        x.n += 1; x.sen += Number(r.amount_sen);
        m.set(label, x);
        gaps.set(k, m);
      }
    }
    out('-- days from a report\'s last day to its bank credit: acquirer | total | per bucket count (RM share)');
    for (const k of [...gaps.keys()].sort()) {
      const m = gaps.get(k);
      const total = [...m.values()].reduce((s, x) => s + x.sen, 0);
      const n = [...m.values()].reduce((s, x) => s + x.n, 0);
      out(`${k} | ${n}, ${rm(total)} | ${BUCKETS.map(([, , l]) => (m.has(l) ? `${l}d: ${m.get(l).n} (${pct(m.get(l).sen, total)})` : null)).filter(Boolean).join('  ')}`);
    }
    const late = booked.map((r) => ({ r, b: batchById.get(Number(r.batch_id)) })).filter((x) => x.b?.period_to && gapOf(x.r.received_on, x.b.period_to) > 7).sort((a, z) => gapOf(z.r.received_on, z.b.period_to) - gapOf(a.r.received_on, a.b.period_to));
    for (const x of late.slice(0, 12)) out(`   late: ${x.b.acquirer_code} #${x.b.id} ${day(x.b.period_to)} -> ${day(x.r.received_on)} (${gapOf(x.r.received_on, x.b.period_to)}d) ${rm(x.r.amount_sen)} ${x.b.file_name ?? ''}`);

    /* 2. Did the money arrive? Reports old enough that the filed statements must show it. */
    const coverOf = new Map();
    for (const s of statements) { const k = String(s.account_code); const t = day(s.period_to); if (!coverOf.has(k) || coverOf.get(k) < t) coverOf.set(k, t); }
    const fromOf = new Map();
    for (const s of statements) { const k = String(s.account_code); const t = day(s.period_from); if (!fromOf.has(k) || fromOf.get(k) > t) fromOf.set(k, t); }
    out(`statements cover: ${[...coverOf.entries()].map(([k, v]) => `${k} ${fromOf.get(k)}..${v}`).join(', ') || 'none'}`);
    const bankOf = new Map(acquirers.map((a) => [String(a.code), a.bank_account_code]));
    const got = new Map();
    for (const r of booked) got.set(Number(r.batch_id), (got.get(Number(r.batch_id)) ?? 0) + Number(r.amount_sen) + Number(r.charge_sen ?? 0));
    for (const r of charges) if (r.batch_id != null) got.set(Number(r.batch_id), (got.get(Number(r.batch_id)) ?? 0) + Number(r.charge_sen ?? 0));
    const waiting = new Map();
    for (const r of rows) if (!r.confirmed_at && r.bucket !== 'IGNORED') waiting.set(Number(r.batch_id), (waiting.get(Number(r.batch_id)) ?? 0) + 1);
    const states = new Map();
    const unpaidClear = [];
    for (const b of batches) {
      const acq = String(b.acquirer_code);
      const account = bankOf.get(acq);
      const cover = account ? coverOf.get(String(account)) : null;
      const from = account ? fromOf.get(String(account)) : null;
      const to = day(b.period_to);
      if (!cover || !to || to > addDays(cover, -7) || to < addDays(from, -3)) continue;
      const due = Number(b.stated_net_sen ?? b.net_sen ?? 0);
      const have = got.get(Number(b.id)) ?? 0;
      const w = waiting.get(Number(b.id)) ?? 0;
      const state = have === due ? 'paid in full' : have > 0 ? 'partly paid' : w > 0 ? 'unpaid, lines still waiting' : 'unpaid, every line done';
      const k = `${acq} ${state}`;
      const x = states.get(k) ?? { n: 0, due: 0, have: 0 };
      x.n += 1; x.due += due; x.have += have;
      states.set(k, x);
      const all = `ALL ${state}`;
      const y = states.get(all) ?? { n: 0, due: 0, have: 0 };
      y.n += 1; y.due += due; y.have += have;
      states.set(all, y);
      if (state === 'unpaid, every line done' || state === 'partly paid') unpaidClear.push({ b, due, have, state, w });
    }
    out('-- reports ending at least 7 days before the last filed statement: acquirer state | reports | owed RM | received RM');
    for (const k of [...states.keys()].sort()) out(`${k} | ${states.get(k).n} | ${rm(states.get(k).due)} | ${rm(states.get(k).have)}`);
    unpaidClear.sort((a, z) => day(a.b.period_to).localeCompare(day(z.b.period_to)));
    for (const x of unpaidClear.slice(0, 30)) out(`   ${x.state}: ${x.b.acquirer_code} #${x.b.id} ${day(x.b.period_from)}..${day(x.b.period_to)} owed ${rm(x.due)} got ${rm(x.have)} waiting ${x.w} ${x.b.file_name ?? ''}`);

    /* 3. The three rows, as the split would print them. */
    const clearing = [...new Set([...(await tx`SELECT account_code FROM scm.acc_account_roles WHERE company_id = ${c} AND role = 'TRANSIT_EDC'`).map((r) => r.account_code), ...acquirers.map((a) => a.transit_account_code)].filter(Boolean))];
    const lines = (await tx`
      SELECT je_no, entry_date, source_type, source_doc_no, account_code, debit_sen, credit_sen, posted, reversed, reversed_by_je
        FROM scm.v_gl_entries WHERE company_id = ${c} AND account_code IN ${tx(clearing)} AND source_type IN ('SOPAY', 'SIPAY')`).filter(countsInTheBooks);
    const facts = {
      matches: matches.map((m) => ({ ...m, settlement_row_id: Number(m.settlement_row_id) })),
      rows: rows.map((r) => ({ id: Number(r.id), batch_id: Number(r.batch_id) })),
      batches: batches.map((b) => ({ id: Number(b.id), stated_net_sen: b.stated_net_sen == null ? null : Number(b.stated_net_sen), net_sen: b.net_sen == null ? null : Number(b.net_sen) })),
      receipts: receipts.map((r) => ({ batch_id: Number(r.batch_id), received_on: r.received_on, amount_sen: Number(r.amount_sen), charge_sen: r.charge_sen == null ? null : Number(r.charge_sen), je_no: r.je_no })),
    };
    const rowById = new Map(rows.map((r) => [Number(r.id), r]));
    const confirmedKey = new Map();
    const linkedOpen = new Set();
    for (const m of matches) {
      const r = rowById.get(Number(m.settlement_row_id));
      if (!r) continue;
      const k = paymentKey(m.payment_source, String(m.payment_id));
      if (r.confirmed_at) confirmedKey.set(k, r);
      else linkedOpen.add(k);
    }
    const shareNow = inBankShares(facts, '9999-12-31');
    const shareAt = new Map();
    const atEnd = (m) => { if (!shareAt.has(m)) shareAt.set(m, inBankShares(facts, monthEnd(m))); return shareAt.get(m); };
    const table = new Map();
    const put = (k, f, sen) => { const r = table.get(k) ?? {}; r[f] = (r[f] ?? 0) + sen; table.set(k, r); };
    let lineAfterMonth = 0;
    for (const l of lines) {
      const sen = Number(l.debit_sen) - Number(l.credit_sen);
      if (sen === 0) continue;
      const month = day(l.entry_date).slice(0, 7);
      const key = paymentKey(String(l.source_type), String(l.source_doc_no));
      const row = confirmedKey.get(key);
      const end = Math.round(sen * (atEnd(month).get(key) ?? 0));
      const now = Math.round(sen * (shareNow.get(key) ?? 0));
      put(month, 'swipes', sen);
      put(month, 'bankEnd', end);
      put(month, 'bankNow', now);
      if (row) {
        put(month, 'matchedRest', sen - end);
        if (day(row.txn_date) > monthEnd(month)) lineAfterMonth += sen;
      } else {
        put(month, 'notMatched', sen - end);
        if (linkedOpen.has(key)) put(month, 'linkedOpen', sen - end);
      }
    }
    out('-- as the By month columns would read: month | swipes | in the bank at month end | merchant matched, not in the bank at month end | not matched | (share matched-not-in-bank) | in the bank today');
    for (const m of [...table.keys()].sort()) {
      const r = table.get(m);
      out(`${m} | ${rm(r.swipes)} | ${rm(r.bankEnd)} | ${rm(r.matchedRest)} | ${rm(r.notMatched)} | ${pct(r.matchedRest ?? 0, r.swipes)} | ${rm(r.bankNow)}${r.linkedOpen ? ` | linked but line open ${rm(r.linkedOpen)}` : ''}`);
    }
    out(`claimed line dated after its journal's month: ${rm(lineAfterMonth)}`);
    /* A swipe's money by the day it reached the bank, from the line's own swipe day. */
    const swipeGap = new Map();
    for (const m of matches) {
      const r = rowById.get(Number(m.settlement_row_id));
      if (!r?.confirmed_at) continue;
      const rec = booked.filter((x) => Number(x.batch_id) === Number(r.batch_id)).map((x) => day(x.received_on)).sort()[0];
      if (!rec) continue;
      const g = gapOf(rec, r.txn_date);
      const label = g <= 1 ? '<=1' : g === 2 ? '2' : g === 3 ? '3' : g <= 7 ? '4-7' : '8+';
      const x = swipeGap.get(label) ?? { n: 0, sen: 0 };
      x.n += 1; x.sen += Number(r.net_sen ?? 0);
      swipeGap.set(label, x);
    }
    const sg = [...swipeGap.values()].reduce((s, x) => s + x.sen, 0);
    out(`-- swipe day to first bank credit, by claimed payment: ${['<=1', '2', '3', '4-7', '8+'].filter((k) => swipeGap.has(k)).map((k) => `${k}d: ${swipeGap.get(k).n} (${pct(swipeGap.get(k).sen, sg)})`).join('  ')}`);
  }
});
await sql.end();
