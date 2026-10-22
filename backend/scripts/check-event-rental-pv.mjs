#!/usr/bin/env node
// check-event-rental-pv.mjs — READ-ONLY. #2259 JOHOR [AKEMI] INHOME @ SUTERA
// MALL shows Rental 16,000 入账 with no posted leg tagged to it: the payment
// voucher lines tagged to it (any status), and any supplier credit note (SCN)
// for the same supplier / payee, with whether its legs carry the event.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const pid = 2259;
  const lines = await sql`
    SELECT pv.pv_number, pv.voucher_date::text AS d, pv.status, pv.checked_at IS NOT NULL AS checked, pv.approved_at IS NOT NULL AS approved,
           pv.payee_name, pv.supplier_id, l.debit_account_code, l.amount_sen, left(coalesce(l.description, ''), 60) AS descr
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE l.project_id = ${pid}
     ORDER BY pv.voucher_date, pv.pv_number`;
  for (const r of lines) console.log(`ROW|pv ${r.pv_number} ${r.d} ${r.status} checked=${r.checked} approved=${r.approved} payee=${r.payee_name} ${r.debit_account_code} ${(Number(r.amount_sen) / 100).toFixed(2)} | ${r.descr}`);
  if (lines.length === 0) console.log('ROW|no voucher line tagged to the event');
  const suppliers = [...new Set(lines.map((r) => r.supplier_id).filter(Boolean))];
  const payees = [...new Set(lines.map((r) => String(r.payee_name ?? '').trim()).filter(Boolean))];
  const notes = await sql`
    SELECT n.note_number, n.status, n.note_date::text AS d, n.total_sen, n.je_no, n.party_name,
           left(coalesce(n.reason, '') || ' ' || coalesce(n.notes, ''), 80) AS why,
           (SELECT string_agg(cl.account_code || ' ' || (cl.amount_sen / 100.0)::text || ' ' || coalesce(cl.description, ''), '; ') FROM scm.acc_credit_note_lines cl WHERE cl.note_id = n.id) AS nl
      FROM scm.acc_credit_notes n
     WHERE n.kind = 'SCN' AND n.company_id = 1
       AND (n.supplier_id = ANY(${suppliers.length ? suppliers : ['00000000-0000-0000-0000-000000000000']}::uuid[])
            OR n.party_name = ANY(${payees.length ? payees : ['-']})
            OR coalesce(n.notes, '') ILIKE '%SUTERA%' OR coalesce(n.reason, '') ILIKE '%SUTERA%')
     ORDER BY n.note_date`;
  for (const n of notes) console.log(`ROW|scn ${n.note_number} ${n.status} ${n.d} ${n.party_name} ${(Number(n.total_sen) / 100).toFixed(2)} je=${n.je_no ?? '-'} | ${n.why} | ${n.nl ?? '-'}`);
  if (notes.length === 0) console.log('ROW|no supplier credit note for this supplier or naming SUTERA');
} finally { await sql.end(); }
