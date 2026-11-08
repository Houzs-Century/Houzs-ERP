#!/usr/bin/env node
// check-cashflow-dep-bal.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-08: 「帮我检查 cash flow，这个 deposit 和 balance 提取的数据是对的吗？」
// 1. The Cash Flow's Deposit / Balance rows per month, through the report's own builder.
// 2. Each counted payment's kind worked out again, independently, from the order's payments.
// 3. Every order payment paid in the month: counted that month, counted in another month, or
//    not counted at all, and why.
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { buildReceiptsPayments, rpDbSources } from '../src/scm/routes/accounting-rp.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const TODAY = '2026-11-08';
const MONTHS = [['2026-06-01', '2026-06-30'], ['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', TODAY]];
const PARTS = ['CASH', 'CARD-BANK', 'CARD-MATCHED', 'CARD-UNMATCHED'];

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  for (const co of [2, 1]) {
    const sb = pgrestShim(tx, 'scm');
    /* Everything the independent count needs, for the whole company. */
    const orders = await tx`SELECT doc_no, local_total_sen, status::text AS status FROM scm.mfg_sales_orders WHERE company_id = ${co}`;
    const pays = await tx`
      SELECT id::text AS id, so_doc_no, amount_sen, paid_at, created_at, method, created_by,
             converted_from_so_doc_no, converted_to_so_doc_no, mirror_of_payment_id::text AS mirror_of, refund_pv_id::text AS refund_pv
        FROM scm.mfg_sales_order_payments WHERE company_id = ${co}`;
    const jl = await tx`
      SELECT DISTINCT source_doc_no, source_type, entry_date FROM scm.v_gl_entries
       WHERE company_id = ${co} AND source_type IN ('SOPAY', 'SOPAY_REVERSAL')`;
    const totalOf = new Map(orders.map((o) => [o.doc_no, Number(o.local_total_sen ?? 0)]));
    const statusOf = new Map(orders.map((o) => [o.doc_no, o.status]));
    /* The rule, written again here: paid day, then keyed time, then id; the payment that brings
       the paid total up to the order total, and every one after it, is Balance. */
    const kindOf = new Map();
    const byOrder = new Map();
    for (const p of pays) byOrder.set(p.so_doc_no, [...(byOrder.get(p.so_doc_no) ?? []), p]);
    for (const [doc, list] of byOrder) {
      const total = totalOf.get(doc) ?? 0;
      let paid = 0;
      for (const p of [...list].sort((a, b) => day(a.paid_at).localeCompare(day(b.paid_at)) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id))) {
        paid += Number(p.amount_sen);
        kindOf.set(p.id, total > 0 && paid >= total ? 'BAL' : 'DEP');
      }
    }
    const journalsOf = new Map();
    for (const j of jl) journalsOf.set(j.source_doc_no, [...(journalsOf.get(j.source_doc_no) ?? []), `${j.source_type}@${day(j.entry_date)}`]);
    const payById = new Map(pays.map((p) => [p.id, p]));

    out('');
    out(`=== company ${co}: ${orders.length} orders, ${pays.length} order payments`);
    const countedIn = new Map(); // payment id -> months it was counted in
    const reports = [];
    for (const [from, to] of MONTHS) {
      const r = await buildReceiptsPayments(co, { from, to, byParty: false, wanted: [] }, rpDbSources(sb, co, []));
      if (!r.ok) throw new Error(`report ${from}: ${r.reason}`);
      reports.push([from, to, r.report]);
      for (const e of r.report.entries) {
        if (!/:(DEP|BAL):/.test(e.rowKey) || !e.sourceDocNo) continue;
        countedIn.set(e.sourceDocNo, [...new Set([...(countedIn.get(e.sourceDocNo) ?? []), from.slice(0, 7)])]);
      }
    }
    for (const [from, to, rep] of reports) {
      const rows = rep.receipts.filter((x) => /:(DEP|BAL):|:(REFUND|OTHER)$/.test(x.key));
      const cell = (k) => rows.filter((x) => x.key.endsWith(k)).reduce((s, x) => s + x.totalSen, 0);
      const line = (kind) => PARTS.map((p) => rm(cell(`:${kind}:${p}`))).join(' / ');
      const total = (kind) => rows.filter((x) => x.key.includes(`:${kind}:`)).reduce((s, x) => s + x.totalSen, 0);
      out(`${from.slice(0, 7)}: DEP ${line('DEP')} = ${rm(total('DEP'))} | BAL ${line('BAL')} = ${rm(total('BAL'))} | refund ${rm(cell(':REFUND'))} | other ${rm(cell(':OTHER'))}`);

      /* 2. The kind each counted payment was given, against the rule worked out again. */
      const mine = rep.entries.filter((e) => /:(DEP|BAL):/.test(e.rowKey));
      const wrong = mine.filter((e) => kindOf.get(e.sourceDocNo) !== (e.rowKey.includes(':DEP:') ? 'DEP' : 'BAL'));
      out(`   kind: ${mine.length} amounts counted; given another kind than the rule says: ${wrong.length}, RM ${rm(wrong.reduce((s, e) => s + e.sen, 0))}`);
      for (const e of wrong.slice(0, 5)) {
        const p = payById.get(e.sourceDocNo);
        out(`      ${p?.so_doc_no ?? '?'} pay ${e.sourceDocNo.slice(0, 8)} RM ${rm(e.sen)} report ${e.rowKey.split(':')[1]} rule ${kindOf.get(e.sourceDocNo) ?? 'no such payment'}`);
      }

      /* 3. Every order payment paid in the month. */
      const paidHere = pays.filter((p) => day(p.paid_at) >= from && day(p.paid_at) <= to);
      const live = paidHere.filter((p) => statusOf.get(p.so_doc_no) !== 'CANCELLED');
      const here = live.filter((p) => (countedIn.get(p.id) ?? []).includes(from.slice(0, 7)));
      const elsewhere = live.filter((p) => !(countedIn.get(p.id) ?? []).includes(from.slice(0, 7)) && (countedIn.get(p.id) ?? []).length > 0);
      const nowhere = live.filter((p) => (countedIn.get(p.id) ?? []).length === 0);
      const why = (p) => {
        if (p.mirror_of) return 'mirror of money moved out';
        if (p.converted_from_so_doc_no) return 'converted in from another order';
        if (p.refund_pv) return 'refund';
        if (!journalsOf.get(p.id)) return /autocount|import/i.test(String(p.created_by ?? '')) ? 'AutoCount carry-over, no journal' : 'no journal';
        return `journal ${journalsOf.get(p.id).join(',')}`;
      };
      const reasons = new Map();
      for (const p of nowhere) { const w = why(p).replace(/@\d{4}-\d{2}-\d{2}/g, ''); reasons.set(w, [(reasons.get(w)?.[0] ?? 0) + 1, (reasons.get(w)?.[1] ?? 0) + Number(p.amount_sen)]); }
      out(`   payments paid this month on live orders: ${live.length}, RM ${rm(live.reduce((s, p) => s + Number(p.amount_sen), 0))}; counted this month ${here.length}; counted in another month ${elsewhere.length}, RM ${rm(elsewhere.reduce((s, p) => s + Number(p.amount_sen), 0))}; not counted ${nowhere.length}, RM ${rm(nowhere.reduce((s, p) => s + Number(p.amount_sen), 0))}`);
      for (const [w, [n, s]] of reasons) out(`      not counted: ${w}: ${n}, RM ${rm(s)}`);
      for (const p of elsewhere.slice(0, 4)) out(`      elsewhere: ${p.so_doc_no} paid ${day(p.paid_at)} RM ${rm(p.amount_sen)} counted ${countedIn.get(p.id).join(',')} journals ${(journalsOf.get(p.id) ?? []).join(',')}`);
      for (const p of nowhere.filter((x) => !x.mirror_of && !x.converted_from_so_doc_no).slice(0, 4)) out(`      nowhere: ${p.so_doc_no} paid ${day(p.paid_at)} RM ${rm(p.amount_sen)} ${p.method ?? '-'} by ${String(p.created_by ?? '-').slice(0, 20)} | ${why(p)}`);
    }
    /* What the rule itself does with this company's orders. */
    const fullAtOnce = [...byOrder.values()].filter((list) => list.length === 1 && kindOf.get(list[0].id) === 'BAL').length;
    const zeroTotal = [...byOrder.keys()].filter((d) => (totalOf.get(d) ?? 0) <= 0).length;
    const over = [...byOrder.entries()].filter(([d, list]) => (totalOf.get(d) ?? 0) > 0 && list.reduce((s, p) => s + Number(p.amount_sen), 0) > (totalOf.get(d) ?? 0)).length;
    out(`orders paid in one payment (that payment is Balance): ${fullAtOnce}; orders with no total (all Deposit): ${zeroTotal}; orders paid over their total: ${over}`);
  }
});
await sql.end();
