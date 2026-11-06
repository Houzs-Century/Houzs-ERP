#!/usr/bin/env node
// check-cancelled-applied.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// The cancelled vouchers' allocations whose applied figure is above zero, and the bills
// a cancelled voucher named whose paid figure is not the live vouchers' applied: does a
// cancel leave a bill looking paid?
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const stale = await tx`
    SELECT pv.company_id, pv.pv_number, pv.approved_at, pv.checked_at, pv.updated_at, a.amount_sen, a.applied_sen, a.pi_id, a.ap_invoice_id,
           COALESCE(i.invoice_number, p.invoice_number) AS bill, COALESCE(i.status::text, p.status::text) AS bill_status,
           COALESCE(i.total_sen, p.total_sen) AS total, COALESCE(i.paid_sen, p.paid_sen) AS paid
      FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id
      LEFT JOIN scm.ap_invoices i ON i.id = a.ap_invoice_id
      LEFT JOIN scm.purchase_invoices p ON p.id = a.pi_id
     WHERE pv.status = 'CANCELLED' AND COALESCE(a.applied_sen, 0) > 0
     ORDER BY pv.pv_number`;
  out(`allocations on cancelled vouchers still showing applied: ${stale.length}`);
  for (const s of stale) {
    const live = s.ap_invoice_id
      ? await tx`SELECT COALESCE(sum(a.applied_sen), 0)::bigint AS s, count(*)::int AS n, string_agg(pv.pv_number || ' ' || pv.status, ', ') AS who FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id WHERE a.ap_invoice_id = ${s.ap_invoice_id} AND pv.status <> 'CANCELLED'`
      : await tx`SELECT COALESCE(sum(a.applied_sen), 0)::bigint AS s, count(*)::int AS n, string_agg(pv.pv_number || ' ' || pv.status, ', ') AS who FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id WHERE a.pi_id = ${s.pi_id} AND pv.status <> 'CANCELLED'`;
    const audit = await tx`SELECT action, actor_name_snapshot, created_at, field_changes, note FROM scm.entity_audit_log WHERE entity_type = 'PAYMENT_VOUCHER' AND entity_doc_no = ${s.pv_number} ORDER BY created_at`;
    out(`co ${s.company_id} ${s.pv_number} approved ${String(s.approved_at ?? '-').slice(0, 10)} applied ${rm(s.applied_sen)} of ${rm(s.amount_sen)} -> ${s.bill} ${s.bill_status} total ${rm(s.total)} paid ${rm(s.paid)} | live vouchers on it: ${live[0].n}, applied ${rm(live[0].s)} (${String(live[0].who ?? '').slice(0, 70)})`);
    for (const a of audit.slice(-3)) out(`      ${String(a.created_at).slice(0, 16)} ${a.action} by ${a.actor_name_snapshot ?? '-'} ${String(a.note ?? '').slice(0, 60)}`);
  }
  for (const no of ['HC-PI-003477', 'HC-PI-006104', 'HC-PI-2609-051']) {
    const [b] = await tx`SELECT * FROM scm.purchase_invoices WHERE invoice_number = ${no}`;
    if (!b) { out(`${no}: not found`); continue; }
    const allocs = await tx`SELECT pv.pv_number, pv.status, a.amount_sen, a.applied_sen FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id WHERE a.pi_id = ${b.id}`;
    out(`${no} ${b.status} date ${String(b.invoice_date).slice(0, 10)} total ${rm(b.total_sen)} paid ${rm(b.paid_sen)} notes ${String(b.notes ?? '').slice(0, 70)} | ${allocs.map((a) => `${a.pv_number} ${a.status} ${rm(a.amount_sen)} applied ${rm(a.applied_sen)}`).join(' ; ')}`);
  }
});
await sql.end();
