#!/usr/bin/env node
// check-pv-waiting.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 「这么多？」 on the Payment listing. Every voucher it shows by default
// (Prepared or Checked, not approved, dated up to today MYT), per company:
//   · how old, who prepared and checked it, how long it has waited;
//   · when anyone last approved a voucher, and who;
//   · whether a bank statement line of the same amount, from the account the voucher
//     pays from, already shows the money gone (on or after 14 days before its date),
//     and whether that line is already booked to some other entry;
//   · how far each pay-from account's uploaded statements reach.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (s, n = 48) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const day = (iso) => String(iso ?? '').slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(day(b)) - Date.parse(day(a))) / 86_400_000);

await sql.begin('READ ONLY', async (tx) => {
  const [{ today }] = await tx`SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS today`;
  out(`today (MYT) ${today}`);
  const vs = await tx`
    SELECT v.company_id, v.id::text AS id, v.pv_number, v.payee_name, v.voucher_date::text AS voucher_date,
           v.total_sen, v.currency, v.exchange_rate, v.bank_charge_sen, v.credit_account_code, v.notes,
           v.created_by, v.submitted_at::text AS submitted_at, v.submitted_by, v.checked_at::text AS checked_at, v.checked_by
      FROM scm.payment_vouchers v
     WHERE v.status = 'DRAFT' AND v.submitted_at IS NOT NULL AND v.approved_at IS NULL AND v.voucher_date <= ${today}::date
     ORDER BY v.company_id, v.voucher_date, v.pv_number`;
  const ids = vs.map((v) => v.id);
  const rq = ids.length ? await tx`SELECT pv_id::text AS pv_id, request_no, purpose FROM scm.acc_payment_requests WHERE pv_id::text IN ${tx(ids)} ORDER BY request_no` : [];
  const ln = ids.length ? await tx`SELECT pv_id::text AS pv_id, line_no, description FROM scm.payment_voucher_lines WHERE pv_id::text IN ${tx(ids)} ORDER BY pv_id, line_no` : [];
  const group = (rows) => { const m = new Map(); for (const r of rows) m.set(r.pv_id, [...(m.get(r.pv_id) ?? []), r]); return m; };
  const reqOf = group(rq); const linesOf = group(ln);
  const purposeOf = (v) => {
    const asked = reqOf.get(v.id) ?? [];
    if (asked.length) return asked.map((q) => [q.request_no, q.purpose].filter(Boolean).join(' ')).join('; ');
    return [...new Set((linesOf.get(v.id) ?? []).map((l) => String(l.description ?? '').trim()).filter(Boolean))].join('; ');
  };
  const myr = (v) => Math.round(Number(v.total_sen) * (String(v.currency ?? 'MYR').toUpperCase() === 'MYR' ? 1 : Number(v.exchange_rate) || 1));

  /* Approvals: the last one per company, and who approved in the last 60 days. */
  const last = await tx`
    SELECT DISTINCT ON (company_id) company_id, approved_at::text AS at, approved_by, pv_number
      FROM scm.payment_vouchers WHERE approved_at IS NOT NULL ORDER BY company_id, approved_at DESC`;
  const who = await tx`
    SELECT company_id, coalesce(approved_by, '?') AS approved_by, count(*)::int AS n, max(approved_at)::text AS last_at
      FROM scm.payment_vouchers WHERE approved_at >= now() - interval '60 days' GROUP BY 1, 2 ORDER BY 1, 3 DESC`;

  /* The bank: every debit line from the earliest voucher date less 14 days. */
  const minDate = vs.length ? vs.map((v) => v.voucher_date).sort()[0] : today;
  const lines = vs.length ? await tx`
    SELECT l.id::text AS id, l.company_id, s.account_code, l.booked_on::text AS booked_on, l.amount_sen, l.state, l.kind,
           l.description, l.reference, l.posted_je_no,
           (SELECT string_agg(m.je_no, ', ') FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS matched
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.amount_sen < 0 AND l.kind <> 'DUPLICATE' AND l.booked_on >= (${minDate}::date - 14)` : [];
  const reach = await tx`
    SELECT s.company_id, s.account_code, max(l.booked_on)::text AS last_line, count(*)::int AS n
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     GROUP BY 1, 2 ORDER BY 1, 2`;

  for (const co of [...new Set(vs.map((v) => v.company_id))]) {
    const mine = vs.filter((v) => v.company_id === co);
    const l = last.find((r) => r.company_id === co);
    out('');
    out(`=== company ${co}: ${mine.length} vouchers waiting, RM ${rm(mine.reduce((s, v) => s + myr(v), 0))} | Prepared ${mine.filter((v) => !v.checked_at).length}, Checked ${mine.filter((v) => v.checked_at).length}`);
    const byMonth = new Map();
    for (const v of mine) byMonth.set(v.voucher_date.slice(0, 7), (byMonth.get(v.voucher_date.slice(0, 7)) ?? 0) + 1);
    out(`  by voucher month: ${[...byMonth].map(([m, n]) => `${m} ${n}`).join(', ')}`);
    out(`  last approval: ${l ? `${day(l.at)} ${l.approved_by ?? '?'} (${l.pv_number})` : 'never'}`);
    out(`  approved in the last 60 days: ${who.filter((r) => r.company_id === co).map((r) => `${r.approved_by} ${r.n} (last ${day(r.last_at)})`).join('; ') || 'none'}`);
    const accounts = [...new Set(mine.map((v) => v.credit_account_code))];
    out(`  statements reach: ${accounts.map((a) => { const r = reach.find((x) => x.company_id === co && x.account_code === a); return `${a} ${r ? `to ${r.last_line}` : 'no statement'}`; }).join(' | ')}`);
    let open = 0; let booked = 0; let none = 0;
    for (const v of mine) {
      const amounts = new Set([myr(v), myr(v) + Number(v.bank_charge_sen ?? 0)]);
      const from = new Date(Date.parse(v.voucher_date) - 14 * 86_400_000).toISOString().slice(0, 10);
      const hits = lines.filter((b) => b.company_id === co && b.account_code === v.credit_account_code && amounts.has(-Number(b.amount_sen)) && b.booked_on >= from);
      const elsewhere = hits.length ? [] : lines.filter((b) => b.company_id === co && amounts.has(-Number(b.amount_sen)) && b.booked_on >= from);
      const fmt = (b) => `${b.account_code} ${b.booked_on} ${b.state}${b.matched ? ` booked to ${b.matched}` : b.posted_je_no ? ` posted ${b.posted_je_no}` : ''} "${short(b.description, 40)}"`;
      let bank;
      if (hits.length) {
        const free = hits.filter((b) => b.state === 'OPEN' && !b.matched);
        if (free.length) open += 1; else booked += 1;
        bank = `PAID? ${hits.map(fmt).join(' || ')}`;
      } else {
        none += 1;
        bank = elsewhere.length ? `no line in ${v.credit_account_code}; same amount in ${elsewhere.map(fmt).join(' || ')}` : 'no bank line of this amount';
      }
      const stage = v.checked_at ? `Checked ${day(v.checked_at)} by ${v.checked_by ?? '?'}` : `Prepared ${day(v.submitted_at)} by ${v.submitted_by ?? '?'}`;
      const waited = daysBetween(v.checked_at ?? v.submitted_at, today);
      out(`  ${v.pv_number} | ${v.voucher_date} | ${short(v.payee_name, 30)} | RM ${rm(myr(v))} | ${stage} | waited ${waited}d | from ${v.credit_account_code} | ${bank}`);
      out(`      Description: ${short(v.notes, 60) || '—'} || Purpose: ${short(purposeOf(v), 60) || '—'}`);
    }
    out(`  bank: ${open} with an OPEN line of the same amount (money looks gone, not booked), ${booked} whose same-amount line is already booked to another entry, ${none} with no line`);
  }
});
await sql.end();
