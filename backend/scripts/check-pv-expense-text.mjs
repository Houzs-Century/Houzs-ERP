#!/usr/bin/env node
// check-pv-expense-text.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 「我只想显示单上的费用，不要像之前一样显示bill no. 等等」: for the
// vouchers waiting (Prepared/Checked, not approved) and the latest approved ones, per
// company, what the one Description column would read if it showed only what is paid
// for — the voucher's own lines, or for an AP payment the lines of the AP invoices it
// pays — beside today's Description (notes) and Purpose. Also counts the kinds.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const short = (s, n = 90) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const uniq = (xs) => [...new Set(xs.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
/* The AP payment's own one line ("Settle 2 invoice(s) — X", "prepay 100.00 — X") says nothing about the cost. */
const isSettleLine = (d) => /^(settle \d+ invoice\(s\)|prepay [\d.]+)/i.test(String(d ?? '').trim());

await sql.begin('READ ONLY', async (tx) => {
  const vs = await tx`
    (SELECT v.company_id, v.id::text AS id, v.pv_number, v.payee_name, v.purpose, v.notes, v.bill_ref, v.status,
            v.approved_at IS NULL AS waiting
       FROM scm.payment_vouchers v
      WHERE v.status = 'DRAFT' AND v.submitted_at IS NOT NULL AND v.approved_at IS NULL)
    UNION ALL
    (SELECT * FROM (
       SELECT v.company_id, v.id::text AS id, v.pv_number, v.payee_name, v.purpose, v.notes, v.bill_ref, v.status, false AS waiting,
              row_number() OVER (PARTITION BY v.company_id ORDER BY v.approved_at DESC) AS rn
         FROM scm.payment_vouchers v WHERE v.status = 'POSTED' AND v.approved_at IS NOT NULL) x
      WHERE x.rn <= 25)`;
  const ids = vs.map((v) => v.id);
  const ln = await tx`SELECT pv_id::text AS pv_id, line_no, description FROM scm.payment_voucher_lines WHERE pv_id::text IN ${tx(ids)} ORDER BY pv_id, line_no`;
  const rq = await tx`SELECT pv_id::text AS pv_id, request_no, purpose FROM scm.acc_payment_requests WHERE pv_id::text IN ${tx(ids)} ORDER BY request_no`;
  const al = await tx`SELECT pv_id::text AS pv_id, ap_invoice_id::text AS ap_invoice_id, pi_id::text AS pi_id, created_at FROM scm.pv_allocations WHERE pv_id::text IN ${tx(ids)} ORDER BY created_at`;
  const apIds = uniq(al.map((a) => a.ap_invoice_id));
  const apl = apIds.length ? await tx`SELECT invoice_id::text AS invoice_id, line_no, description FROM scm.ap_invoice_lines WHERE invoice_id::text IN ${tx(apIds)} ORDER BY invoice_id, line_no` : [];
  const group = (rows, key) => { const m = new Map(); for (const r of rows) m.set(r[key], [...(m.get(r[key]) ?? []), r]); return m; };
  const linesOf = group(ln, 'pv_id'); const reqOf = group(rq, 'pv_id'); const allocOf = group(al, 'pv_id'); const apLinesOf = group(apl, 'invoice_id');

  const kinds = new Map();
  for (const co of [...new Set(vs.map((v) => v.company_id))].sort()) {
    out('');
    out(`=== company ${co}`);
    for (const v of vs.filter((x) => x.company_id === co)) {
      const own = (linesOf.get(v.id) ?? []).map((l) => l.description);
      const asked = reqOf.get(v.id) ?? [];
      const allocs = allocOf.get(v.id) ?? [];
      const apInv = uniq(allocs.map((a) => a.ap_invoice_id));
      const piN = uniq(allocs.map((a) => a.pi_id)).length;
      const fromAp = uniq(apInv.flatMap((id) => (apLinesOf.get(id) ?? []).map((l) => l.description)));
      const fromOwn = uniq(own.filter((d) => !isSettleLine(d)));
      const oldPurpose = asked.length ? asked.map((q) => [q.request_no, q.purpose].filter(Boolean).join(' ')).join('; ') : uniq(own).join('; ');
      const kind = apInv.length || piN ? (piN && !apInv.length ? 'AP→PI' : piN ? 'AP→AP+PI' : 'AP→AP') : asked.length ? 'request' : v.purpose ?? 'expense';
      kinds.set(`${co} ${kind}`, (kinds.get(`${co} ${kind}`) ?? 0) + 1);
      const next = fromAp.length ? fromAp.join('; ') : fromOwn.length ? fromOwn.join('; ') : asked.length ? uniq(asked.map((q) => q.purpose)).join('; ') : '';
      out(`${v.waiting ? 'W' : 'P'} ${v.pv_number} [${kind}${piN ? ` pi=${piN}` : ''}] ${short(v.payee_name, 30)}`);
      out(`    notes:   ${short(v.notes) || '—'}${v.bill_ref ? `   (bill_ref ${v.bill_ref})` : ''}`);
      out(`    purpose: ${short(oldPurpose) || '—'}`);
      out(`    NEW:     ${short(next) || '(nothing to read)'}`);
    }
  }
  out('');
  out(`kinds: ${[...kinds].map(([k, n]) => `${k}=${n}`).join(', ')}`);
});
await sql.end();
