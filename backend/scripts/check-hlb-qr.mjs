#!/usr/bin/env node
// check-hlb-qr.mjs — READ-ONLY. Hong Leong's DuitNow QR merchant (00005992284,
// every line referenced 0000PP) on Merchant Recon: how its lines landed, what
// they were matched or posted to, how the matching sales were keyed on the
// Sales Orders, and what the bank statement shows for that merchant number.
// Owner 2026-11-09: 「这个hlbb merchant 的0000PP 是qr direct 去bank 的，不算卡机的」.
//
// Writes nothing: every read runs inside ONE `READ ONLY` transaction, and the
// script refuses MODE=apply. Env: DATABASE_URL, COMPANY_ID (default 2 = 2990).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('check-hlb-qr.mjs is read-only: run it with mode=plan.'); process.exit(1); }

const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const CO = Number(process.env.COMPANY_ID || 2);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v == null ? '—' : String(v).slice(0, 16));
const mid = (fileName) => (/^(\d{8,})/.exec(String(fileName ?? '')) ?? [])[1] ?? '?';
const j = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);

try {
  await sql.begin('read only', async (tx) => {
    head('HLB merchant setup (scm.acc_acquirers, every company)');
    for (const a of await tx`SELECT * FROM scm.acc_acquirers WHERE code = 'HLB' ORDER BY company_id`) {
      row('ACQ', j(a));
    }
    head('Account roles (BANK_DEFAULT / TRANSIT_EDC / CASH)');
    for (const r of await tx`SELECT * FROM scm.acc_account_roles WHERE role IN ('BANK_DEFAULT', 'TRANSIT_EDC', 'CASH') ORDER BY 1`) {
      row('ROLE', j(r));
    }

    head(`HLB reports, company ${CO}`);
    const batches = await tx`
      SELECT id, file_name, period_from, period_to, row_count, gross_sen, fee_sen, net_sen, status, uploaded_by, created_at
        FROM scm.acc_settlement_batches WHERE company_id = ${CO} AND acquirer_code = 'HLB' ORDER BY id`;
    for (const b of batches) {
      row('BATCH', b.id, mid(b.file_name), b.file_name, `${b.period_from}..${b.period_to}`, `rows ${b.row_count}`,
        `gross ${rm(b.gross_sen)}`, `fee ${rm(b.fee_sen)}`, `net ${rm(b.net_sen)}`, b.status, b.uploaded_by ?? '—', day(b.created_at));
    }

    head('By merchant number: lines, 0000PP lines, lines with a fee');
    for (const s of await tx`
      SELECT substring(b.file_name from '^[0-9]+') AS mid, b.company_id, b.acquirer_code,
             count(*) AS lines,
             count(*) FILTER (WHERE upper(trim(r.ref)) = '0000PP') AS pp,
             count(*) FILTER (WHERE r.fee_sen <> 0) AS with_fee,
             sum(r.gross_sen) AS gross
        FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
       WHERE b.acquirer_code = 'HLB' OR upper(trim(r.ref)) = '0000PP'
       GROUP BY 1, 2, 3 ORDER BY 2, 1`) {
      row('MID', s.company_id, s.acquirer_code, s.mid, `lines ${s.lines}`, `0000PP ${s.pp}`, `with fee ${s.with_fee}`, `gross ${rm(s.gross)}`);
    }

    head(`Every HLB line, company ${CO}`);
    const rows = await tx`
      SELECT r.*, b.file_name
        FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
       WHERE b.company_id = ${CO} AND b.acquirer_code = 'HLB'
       ORDER BY r.txn_date, r.batch_id, r.line_no`;
    const ids = rows.map((r) => r.id);
    const matches = ids.length === 0 ? [] : await tx`SELECT * FROM scm.acc_settlement_matches WHERE settlement_row_id IN ${tx(ids)} ORDER BY id`;
    const payIds = [...new Set(matches.map((m) => String(m.payment_id)))];
    const pays = payIds.length === 0 ? [] : await tx`
      SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.created_at, p.method, p.merchant_provider, p.online_type,
             p.approval_code, p.account_sheet, p.amount_sen, o.debtor_name, o.status AS so_status
        FROM scm.mfg_sales_order_payments p
        LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
       WHERE p.id::text IN ${tx(payIds)}`;
    const payById = new Map(pays.map((p) => [p.id, p]));
    const matchesOf = new Map();
    for (const m of matches) matchesOf.set(String(m.settlement_row_id), [...(matchesOf.get(String(m.settlement_row_id)) ?? []), m]);
    for (const r of rows) {
      const ms = matchesOf.get(String(r.id)) ?? [];
      const linked = ms.map((m) => {
        const p = payById.get(String(m.payment_id));
        return p
          ? `${m.payment_source} ${p.so_doc_no} ${p.debtor_name ?? '—'} paid ${day(p.paid_at)} keyed ${day(p.created_at)} RM ${rm(p.amount_sen)} method ${p.method} prov ${p.merchant_provider ?? '—'} online ${p.online_type ?? '—'} code ${p.approval_code ?? '—'} sheet ${p.account_sheet ?? '—'} SO ${p.so_status ?? '—'}`
          : `${m.payment_source} ${m.doc_no ?? m.payment_id} RM ${rm(m.amount_sen)} (payment row not read)`;
      }).join(' + ') || '—';
      row('LINE', r.id, `batch ${r.batch_id}`, mid(r.file_name), `line ${r.line_no}`, r.txn_date, r.ref ?? '—',
        `gross ${rm(r.gross_sen)}`, `fee ${rm(r.fee_sen)}`, `net ${rm(r.net_sen)}`, r.bucket, r.match_reason ?? '—',
        r.confirmed_at ? `confirmed ${day(r.confirmed_at)} by ${r.confirmed_by ?? '—'} JE ${r.posted_je_no ?? '—'}` : 'not confirmed',
        `grp ${r.matched_with_row_id ?? '—'}`, `not_this ${j(r.not_this ?? null)}`, `links: ${linked}`, `notes: ${String(r.notes ?? '').slice(0, 160)}`);
    }

    head(`QR-looking Sales Order payments, company ${CO}, since 2026-08-01 (code contains QR, or online type DuitNow) — by month and how keyed`);
    for (const s of await tx`
      SELECT to_char(p.paid_at, 'YYYY-MM') AS month, p.method, coalesce(p.merchant_provider, '—') AS prov,
             coalesce(p.online_type, '—') AS online, coalesce(p.account_sheet, '—') AS sheet,
             (p.approval_code ~* 'QR') AS qr_code, count(*) AS n, sum(p.amount_sen) AS amt
        FROM scm.mfg_sales_order_payments p
       WHERE p.company_id = ${CO} AND p.paid_at >= '2026-08-01'
         AND (p.approval_code ~* 'QR' OR p.online_type ILIKE '%duit%')
       GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4`) {
      row('QRPAY', s.month, s.method, s.prov, s.online, s.sheet, `qr-code ${s.qr_code}`, `n ${s.n}`, `RM ${rm(s.amt)}`);
    }

    head(`Payment methods in use, company ${CO}, since 2026-09-01 (method / provider / online type / sheet)`);
    for (const s of await tx`
      SELECT p.method, coalesce(p.merchant_provider, '—') AS prov, coalesce(p.online_type, '—') AS online,
             coalesce(p.account_sheet, '—') AS sheet, count(*) AS n, sum(p.amount_sen) AS amt
        FROM scm.mfg_sales_order_payments p
       WHERE p.company_id = ${CO} AND p.paid_at >= '2026-09-01'
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`) {
      row('METHOD', s.method, s.prov, s.online, s.sheet, `n ${s.n}`, `RM ${rm(s.amt)}`);
    }

    head(`For each 0000PP line: every SO payment of the SAME amount within 10 days (any method), company ${CO}`);
    const pp = rows.filter((r) => String(r.ref ?? '').trim().toUpperCase() === '0000PP');
    for (const r of pp) {
      const near = await tx`
        SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.created_at, p.method, p.merchant_provider, p.online_type,
               p.approval_code, p.account_sheet, p.amount_sen, o.debtor_name, o.status AS so_status,
               (SELECT string_agg(m.settlement_row_id::text, ',') FROM scm.acc_settlement_matches m WHERE m.payment_id = p.id::text) AS on_rows
          FROM scm.mfg_sales_order_payments p
          LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
         WHERE p.company_id = ${CO} AND p.amount_sen = ${r.gross_sen}
           AND p.paid_at BETWEEN (${r.txn_date}::date - 10) AND (${r.txn_date}::date + 11)
         ORDER BY p.paid_at`;
      row('PPLINE', r.id, mid(r.file_name), r.txn_date, `RM ${rm(r.gross_sen)}`, r.bucket, `${near.length} same-amount payment(s)`);
      for (const p of near) {
        row('  NEAR', r.id, p.so_doc_no, p.debtor_name ?? '—', `paid ${day(p.paid_at)}`, `keyed ${day(p.created_at)}`, `RM ${rm(p.amount_sen)}`,
          `method ${p.method}`, `prov ${p.merchant_provider ?? '—'}`, `online ${p.online_type ?? '—'}`, `code ${p.approval_code ?? '—'}`,
          `sheet ${p.account_sheet ?? '—'}`, `SO ${p.so_status ?? '—'}`, `on settlement row ${p.on_rows ?? '—'}`);
      }
    }

    head('2990-SO-2611-042 (the RM 3,240 guess): the order and every payment on it');
    for (const o of await tx`SELECT doc_no, company_id, debtor_name, status, created_at, salesperson_id FROM scm.mfg_sales_orders WHERE doc_no = '2990-SO-2611-042'`) {
      row('SO', j(o));
    }
    for (const p of await tx`
      SELECT p.id::text AS id, p.paid_at, p.created_at, p.method, p.merchant_provider, p.online_type, p.approval_code,
             p.account_sheet, p.amount_sen, p.note, p.collected_by,
             (SELECT string_agg(m.settlement_row_id::text, ',') FROM scm.acc_settlement_matches m WHERE m.payment_id = p.id::text) AS on_rows
        FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = '2990-SO-2611-042' ORDER BY p.paid_at`) {
      row('SOPAY', j(p));
    }

    head(`Bank statement lines naming merchant 00005992284, company ${CO}`);
    const bank = await tx`
      SELECT l.id, l.statement_id, l.line_no, l.booked_on, l.description, l.reference, l.amount_sen, l.charge_sen, l.kind,
             l.acquirer_code, l.trading_date, l.merchant_no, l.matched_batch_id, l.state, l.posted_je_no, l.note
        FROM scm.acc_bank_statement_lines l
       WHERE l.company_id = ${CO} AND (l.reference ILIKE '%5992284%' OR l.description ILIKE '%5992284%' OR l.merchant_no LIKE '%5992284%')
       ORDER BY l.booked_on, l.id`;
    for (const l of bank) {
      row('BANK', l.id, `st ${l.statement_id}`, `line ${l.line_no}`, l.booked_on, `RM ${rm(l.amount_sen)}`, `charge ${rm(l.charge_sen)}`,
        l.kind, l.acquirer_code ?? '—', `trading ${l.trading_date ?? '—'}`, `mid ${l.merchant_no ?? '—'}`, `batch ${l.matched_batch_id ?? '—'}`,
        l.state, `JE ${l.posted_je_no ?? '—'}`, `${l.description} / ${l.reference ?? ''}`, `note: ${String(l.note ?? '').slice(0, 120)}`);
    }
    head('Same, for the HLB card merchants (00005992235 straight card / 00005992276 instalment), last 40 days');
    for (const s of await tx`
      SELECT l.merchant_no, l.kind, l.state, count(*) AS n, sum(l.amount_sen) AS amt
        FROM scm.acc_bank_statement_lines l
       WHERE l.company_id = ${CO} AND l.acquirer_code = 'HLB' AND l.booked_on >= (current_date - 40)
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`) {
      row('BANKSUM', s.merchant_no ?? '—', s.kind, s.state, `n ${s.n}`, `RM ${rm(s.amt)}`);
    }

    head(`Merchant report lines confirmed since 2026-11-07, company ${CO} (the "Posted N lines")`);
    for (const r of await tx`
      SELECT r.id, b.acquirer_code, b.file_name, r.line_no, r.txn_date, r.ref, r.gross_sen, r.fee_sen, r.confirmed_at, r.confirmed_by, r.posted_je_no,
             (SELECT string_agg(m.doc_no || ' ' || (m.amount_sen / 100.0)::text, ' + ') FROM scm.acc_settlement_matches m WHERE m.settlement_row_id = r.id) AS docs
        FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
       WHERE r.company_id = ${CO} AND r.confirmed_at >= '2026-11-07'
       ORDER BY r.confirmed_at, r.id`) {
      row('CONF', r.id, r.acquirer_code, r.file_name, `line ${r.line_no}`, r.txn_date, r.ref ?? '—', `RM ${rm(r.gross_sen)}`, `fee ${rm(r.fee_sen)}`,
        day(r.confirmed_at), r.confirmed_by ?? '—', `JE ${r.posted_je_no ?? '—'}`, r.docs ?? '—');
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
