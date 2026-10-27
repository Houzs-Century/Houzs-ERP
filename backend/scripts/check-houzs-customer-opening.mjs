#!/usr/bin/env node
// check-houzs-customer-opening.mjs — READ ONLY. Owner 2026-10-27: 「debtor aging你当做0
// 可以吗？这个amount 放去 deferred Revenue 可以吗？」 — AutoCount's 31/08 TB carries
// 300-C002 CUSTOMER Dr RM 1,454,725.12 and 440-0000 DEFERRED REVENUE Cr RM 3,867,629.30.
// What does the ERP itself say the customers' money was at 31/08?
//   HELD     money paid by 31/08 on orders not yet delivered / invoiced by 31/08
//            (the deposits the business still owed goods for), by source
//   EARNED   money paid by 31/08 on orders delivered / invoiced by 31/08
//   LATER    money paid from 01/09 on orders delivered / invoiced by 31/08 — what
//            would sit as a customer credit in the ERP if the opening AR is 0
//   OWED     the delivered-by-31/08 orders' total less everything paid on them,
//            at 31/08 and today (what a debtor aging would hold)
// "Delivered by 31/08" = a delivery order dated on/before it, or a sales invoice
// dated on/before it. Writes nothing. Env: DATABASE_URL; CUTOFF / COMPANY_ID.
import postgres from 'postgres';

const CUTOFF = process.env.CUTOFF || '2026-08-31';
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const cols = async (t) => new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ${t}`).map((r) => r.column_name));
  const pick = (set, names) => names.find((n) => set.has(n));
  try {
    const doCols = await cols('delivery_orders');
    const soCols = await cols('mfg_sales_orders');
    const doDate = pick(doCols, ['do_date', 'delivery_date', 'doc_date', 'date']);
    const doSo = pick(doCols, ['so_doc_no', 'sales_order_doc_no', 'source_so_doc_no']);
    const doStatus = pick(doCols, ['status']);
    const soDate = pick(soCols, ['so_date', 'doc_date']);
    const soTotal = pick(soCols, ['local_total_sen', 'total_sen', 'grand_total_sen']);
    console.log(`ROW|cutoff ${CUTOFF}, company ${CO}; delivery_orders date=${doDate} so=${doSo} status=${doStatus}; so date=${soDate} total=${soTotal}`);
    if (!doDate || !doSo || !soTotal) throw new Error('column discovery failed');

    /* Every order of the company with: when it was first delivered / invoiced, its
       status today, and its money by source and side of the cutoff. */
    const rows = await sql.unsafe(`
      WITH fd AS (
        SELECT ${doSo} AS so, min(${doDate})::date AS first_do
        FROM scm.delivery_orders WHERE company_id = $1 ${doStatus ? `AND ${doStatus}::text NOT IN ('CANCELLED', 'VOID')` : ''}
        GROUP BY 1),
      fi AS (
        SELECT so_doc_no AS so, min(invoice_date)::date AS first_si
        FROM scm.sales_invoices WHERE company_id = $1 AND status::text <> 'CANCELLED' GROUP BY 1),
      pay AS (
        SELECT so_doc_no AS so,
          coalesce(sum(amount_sen) FILTER (WHERE method = 'imported' AND paid_at <= $2), 0) AS imp_before,
          coalesce(sum(amount_sen) FILTER (WHERE method <> 'imported' AND paid_at <= $2), 0) AS erp_before,
          coalesce(sum(amount_sen) FILTER (WHERE method = 'imported' AND paid_at > $2), 0) AS imp_after,
          coalesce(sum(amount_sen) FILTER (WHERE method <> 'imported' AND paid_at > $2), 0) AS erp_after
        FROM scm.mfg_sales_order_payments
        WHERE company_id = $1 AND converted_from_so_doc_no IS NULL
        GROUP BY 1)
      SELECT o.doc_no, o.status::text AS status, o.${soDate}::date AS so_date, o.${soTotal} AS total,
        fd.first_do, fi.first_si,
        coalesce(p.imp_before, 0) AS imp_before, coalesce(p.erp_before, 0) AS erp_before,
        coalesce(p.imp_after, 0) AS imp_after, coalesce(p.erp_after, 0) AS erp_after
      FROM scm.mfg_sales_orders o
      LEFT JOIN fd ON fd.so = o.doc_no LEFT JOIN fi ON fi.so = o.doc_no LEFT JOIN pay p ON p.so = o.doc_no
      WHERE o.company_id = $1`, [CO, CUTOFF]);

    const delivered = (r) => (r.first_do && String(r.first_do.toISOString?.() ?? r.first_do).slice(0, 10) <= CUTOFF)
      || (r.first_si && String(r.first_si.toISOString?.() ?? r.first_si).slice(0, 10) <= CUTOFF);
    const n = (v) => Number(v || 0);
    const agg = {};
    const add = (k, r, sen) => { agg[k] = agg[k] || { n: 0, sen: 0 }; agg[k].n++; agg[k].sen += sen; };
    let owedAtCut = 0, owedNow = 0, owedNowN = 0;
    for (const r of rows) {
      const before = n(r.imp_before) + n(r.erp_before);
      const after = n(r.imp_after) + n(r.erp_after);
      const soBeforeCut = r.so_date && String(r.so_date.toISOString?.() ?? r.so_date).slice(0, 10) <= CUTOFF;
      if (delivered(r)) {
        if (before) add('EARNED paid by cutoff, delivered by cutoff', r, before);
        if (n(r.erp_after)) add('LATER ERP money from 01/09 on delivered-by-cutoff orders', r, n(r.erp_after));
        if (n(r.imp_after)) add('LATER imported money dated from 01/09 on delivered-by-cutoff orders', r, n(r.imp_after));
        if (r.status !== 'CANCELLED') {
          const oc = n(r.total) - before; if (oc > 0) owedAtCut += oc;
          const on = n(r.total) - before - after; if (on > 0) { owedNow += on; owedNowN++; }
        }
      } else if (before) {
        const k = r.status === 'CANCELLED' ? 'HELD but the order is CANCELLED now' : soBeforeCut ? 'HELD on orders open at cutoff' : 'HELD on orders dated after cutoff (?)';
        add(`${k} — imported`, r, n(r.imp_before));
        add(`${k} — ERP-keyed`, r, n(r.erp_before));
      }
    }
    for (const [k, v] of Object.entries(agg).sort()) console.log(`ROW|${k}: ${v.n} orders ${rm(v.sen)}`);
    console.log(`ROW|OWED on delivered-by-cutoff orders, at cutoff (total − paid by cutoff, positive only): ${rm(owedAtCut)}`);
    console.log(`ROW|OWED on delivered-by-cutoff orders, today (total − all paid): ${owedNowN} orders ${rm(owedNow)}`);
    const st = {};
    for (const r of rows) if (!delivered(r) && (n(r.imp_before) + n(r.erp_before))) st[r.status] = (st[r.status] || 0) + 1;
    console.log(`ROW|HELD orders by status today: ${JSON.stringify(st)}`);
    /* What the ERP's own books say for customers at the cutoff. */
    const gl = await sql`SELECT l.account_code, coalesce(sum(l.debit_sen - l.credit_sen), 0)::bigint AS bal
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND j.entry_date <= ${CUTOFF} AND (l.account_code LIKE '300-%' OR l.account_code IN ('400-0001', '440-0000', '399-9999', '509-0000'))
      GROUP BY 1 ORDER BY 1`;
    for (const r of gl) console.log(`ROW|ERP books at cutoff ${r.account_code}: ${rm(r.bal)}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
