#!/usr/bin/env node
/* Read-only: how many supplier invoices were marked paid WITHOUT a payment voucher?
 *
 * THE DEFECT (docs/bugs/0889-supplier-invoice-payments-could-skip-the-payment-voucher-and.md).
 * PATCH /purchase-invoices/:id/payment added a typed amount straight onto
 * scm.purchase_invoices.paid_sen. No payment voucher, so no journal entry
 * (Dr Payables / Cr Bank) was ever booked for that money, no hold check, no
 * approval. The phone's Record Payment sheet reached it. The route is retired;
 * this counts what it left behind in the books.
 *
 * HOW A DIRECT PAYMENT IS RECOGNISED. That route, and nothing else, wrote an
 * scm.entity_audit_log row with entity_type 'PURCHASE_INVOICE', note
 * 'Payment recorded', and a field change named 'paymentAmountSen'. The voucher
 * settlement writes no such row.
 *
 * WHAT IT CANNOT SEE, AND SAYS SO. The audit write was added on 2026-07-18
 * (#798). A direct payment made before that left no trace in this table, so
 * the count is a FLOOR, and the first section prints the earliest purchase
 * invoice audit row so the reader knows where the window starts.
 *
 * NO NAMES. The repository is public and so is this log: it prints invoice
 * numbers, dates and amounts, never who pressed the button or which supplier.
 *
 * Writes nothing: SELECTs only, no DDL, no transaction.
 *
 * RE-RUN: safe and idempotent — it is a read. The route refuses every call
 * since this fix, so a second run should find no row newer than the deploy.
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "-");

async function main() {
  const [window] = await sql`
    SELECT min(created_at) AS first_pi_audit, count(*)::int AS pi_audit_rows
      FROM scm.entity_audit_log
     WHERE entity_type = 'PURCHASE_INVOICE'`;
  note(`purchase invoice audit rows: ${window.pi_audit_rows}, earliest ${day(window.first_pi_audit)}`);
  note(`  (a direct payment before that date left no trace here: the counts below are a floor)`);

  const direct = await sql`
    SELECT l.entity_id,
           l.entity_doc_no,
           l.company_id,
           l.created_at,
           coalesce((
             SELECT (fc->>'to')::bigint
               FROM jsonb_array_elements(l.field_changes) fc
              WHERE fc->>'field' = 'paymentAmountSen'
              LIMIT 1
           ), 0) AS amount_sen
      FROM scm.entity_audit_log l
     WHERE l.entity_type = 'PURCHASE_INVOICE'
       AND l.note = 'Payment recorded'
     ORDER BY l.created_at DESC`;

  note(`\n=== payments typed straight onto a supplier invoice ===`);
  note(`  entries: ${direct.length}   total ${rm(direct.reduce((t, r) => t + Number(r.amount_sen), 0))}`);
  if (direct.length === 0) {
    note(`\nNone recorded. Nothing in the books needs reconciling from this route (inside the audit window).`);
    await sql.end({ timeout: 5 });
    return;
  }
  note(`  first ${day(direct[direct.length - 1].created_at)}, latest ${day(direct[0].created_at)}`);

  const byCo = new Map();
  for (const r of direct) {
    const k = String(r.company_id ?? "none");
    const cur = byCo.get(k) ?? { n: 0, sen: 0 };
    cur.n += 1;
    cur.sen += Number(r.amount_sen);
    byCo.set(k, cur);
  }
  note(`\n  by company_id:`);
  for (const [co, v] of [...byCo].sort((a, b) => b[1].n - a[1].n)) note(`     company ${co}: ${v.n} entries, ${rm(v.sen)}`);

  /* Where each invoice stands now, beside what vouchers paid on it. A direct
     amount plus posted voucher money above the invoice total is a supplier paid
     twice on paper; either way the direct amount has no journal entry. */
  const ids = [...new Set(direct.map((r) => r.entity_id))];
  const state = await sql`
    SELECT pi.id::text AS id, pi.invoice_number, pi.company_id, pi.status,
           pi.total_sen, pi.paid_sen,
           coalesce((
             SELECT sum(a.amount_sen)
               FROM scm.pv_allocations a
               JOIN scm.payment_vouchers pv ON pv.id = a.pv_id
              WHERE a.pi_id = pi.id AND pv.status = 'POSTED'
           ), 0)::bigint AS voucher_sen
      FROM scm.purchase_invoices pi
     WHERE pi.id::text = ANY(${ids})`;
  const directByPi = new Map();
  for (const r of direct) directByPi.set(r.entity_id, (directByPi.get(r.entity_id) ?? 0) + Number(r.amount_sen));

  const rows = state.map((s) => ({ ...s, direct_sen: directByPi.get(s.id) ?? 0 }));
  const overPaid = rows.filter((r) => r.direct_sen + Number(r.voucher_sen) > Number(r.total_sen));
  const alsoVoucher = rows.filter((r) => Number(r.voucher_sen) > 0);
  note(`\n=== the invoices behind them ===`);
  note(`  invoices: ${ids.length} (found now: ${rows.length})`);
  note(`  of which a posted voucher ALSO paid money on: ${alsoVoucher.length}`);
  note(`  of which direct + voucher money exceeds the invoice total: ${overPaid.length}`);

  note(`\n=== each invoice (newest direct entry first, max 60) ===`);
  const latest = new Map();
  for (const r of direct) if (!latest.has(r.entity_id)) latest.set(r.entity_id, r.created_at);
  const shown = [...rows].sort((a, b) => String(latest.get(b.id)).localeCompare(String(latest.get(a.id)))).slice(0, 60);
  for (const r of shown) {
    note(
      `  ${String(r.invoice_number).padEnd(22)} co ${String(r.company_id).padEnd(2)} ${String(r.status).padEnd(15)} ` +
      `total ${rm(r.total_sen).padStart(14)}  paid ${rm(r.paid_sen).padStart(14)}  ` +
      `direct ${rm(r.direct_sen).padStart(14)}  voucher ${rm(r.voucher_sen).padStart(14)}  ` +
      `last ${day(latest.get(r.id))}`);
  }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
