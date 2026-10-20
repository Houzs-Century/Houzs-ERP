#!/usr/bin/env node
/* HC-0132: book an unbacked scan header deposit as its own is_deposit payment row.

   THE DAMAGE. Before #4767 the scan job stamped the slip's deposit on the SO
   header (deposit_sen) and kept it even when the receipt pass then booked no
   is_deposit ledger row. Paid is soPaidSen = (is_deposit row ? 0 : deposit_sen)
   + ledger rows (src/scm/shared/so-outstanding.ts:105), so Paid shows the money
   while the Payments list, which reads the ledger, says "No payments recorded".
   check-orphan-scan-deposits.mjs calls this bucket AT RISK; run 39398328008
   (2026-10-20) found HC-SO-2610-248 (RM 3,150) and HC-SO-2610-289 (RM 1,444).

   SCOPE, identical in plan and apply: scan-origin (slip_image_key set),
   deposit_sen > 0, not CANCELLED, and ZERO payment rows of any kind. The
   REALIZED bucket (a header deposit PLUS an ordinary row of the same money) is
   NOT touched: booking a row there would make the doubled Paid permanent. Its
   fix lowers Paid and is repair-orphan-scan-deposits.mjs's job, owner's call.

   WHAT IS WRITTEN, per order, mirroring the scan job's own booking
   (recordScanReceiptPayments -> recordSoPaymentRow, src/scm/lib/so-payment-row.ts):
     payment  one scm.mfg_sales_order_payments row: amount = deposit_sen,
              is_deposit = true, method / bank / plan from the header via
              deriveLedgerMethod (src/scm/lib/scan-receipt-plan.ts:91), account
              sheet via deriveAccountSheet (so-payment-row.ts:39), approval code
              from the header, slip_key = the order's receipt image (else its
              slip image), created_by / collected_by = the salesperson (as the
              scan job does), paid_at = the day the order was scanned (MYT).
     audit    one mfg_so_audit_log ADD_PAYMENT row, source 'script'.
   Paid does not move: the header stops counting the moment the is_deposit row
   that replaces it exists. deposit_sen itself is left as it is.

   NOT done, printed instead: the journal entry, Official Receipt and deposit
   invoice that recordSoPaymentRow's bookSoPaymentBestEffort adds. The journal
   entry comes from the Self-check payment backfill (backfillSoPayments, never
   double-posts); the receipt heals at its next print (ensureReceiptForPayment).
   AutoCount is not queued.

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes in one transaction after
   re-checking each order, then re-reads on a fresh connection and asserts the
   shape: each order has exactly one payment row, is_deposit, amount = deposit_sen.

   RE-RUN: inert. A booked order has a payment row, so it leaves the scope. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* deriveLedgerMethod (scan-receipt-plan.ts:91) + deriveAccountSheet
   (so-payment-row.ts:39), from the header's dropdown values. */
function ledgerRowFromHeader(h) {
  const raw = String(h.payment_method ?? '').trim().toLowerCase();
  if (raw === 'cash') return { method: 'cash', merchant_provider: null, installment_months: null, online_type: null, account_sheet: 'Cash', guessed: false };
  if (raw === 'online') return { method: 'transfer', merchant_provider: null, installment_months: null, online_type: null, account_sheet: 'Bank transfer', guessed: false };
  const bank = String(h.merchant_provider ?? '').trim() || null;
  const months = Number(h.installment_months) > 0 ? Number(h.installment_months) : null;
  return { method: 'merchant', merchant_provider: bank, installment_months: months, online_type: null, account_sheet: bank || 'Card terminal', guessed: raw !== 'merchant' && raw !== 'installment' };
}

const scopeRows = (db) => db`
  SELECT so.doc_no, so.company_id, so.status, so.deposit_sen, so.payment_method, so.merchant_provider,
         so.installment_months, so.approval_code, so.receipt_image_key, so.slip_image_key,
         so.salesperson_id, (so.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS scanned_on
    FROM scm.mfg_sales_orders so
   WHERE so.slip_image_key IS NOT NULL
     AND so.deposit_sen > 0
     AND so.status <> 'CANCELLED'
     AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p
                      WHERE p.so_doc_no = so.doc_no AND p.company_id = so.company_id)
   ORDER BY so.company_id, so.doc_no`;

/* Every column the apply writes, checked in PLAN so apply cannot be the first
   to find a missing one. */
const WRITES = {
  mfg_sales_order_payments: ['company_id', 'so_doc_no', 'paid_at', 'method', 'merchant_provider', 'installment_months', 'online_type',
    'approval_code', 'amount_sen', 'account_sheet', 'slip_key', 'collected_by', 'note', 'created_by', 'is_deposit'],
  mfg_so_audit_log: ['so_doc_no', 'company_id', 'action', 'actor_name_snapshot', 'field_changes', 'status_snapshot', 'source', 'note', 'payment_id'],
};

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let todo;
  try {
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name IN ('mfg_sales_order_payments', 'mfg_so_audit_log')`;
    const missing = Object.entries(WRITES).flatMap(([t, cs]) =>
      cs.filter((c) => !cols.some((x) => x.table_name === t && x.column_name === c)).map((c) => `scm.${t}.${c}`));
    if (missing.length) { bad(`REFUSED: column(s) not found: ${missing.join(', ')}`); return 1; }
    todo = await scopeRows(sql);
    note(`=== ${todo.length} scan order(s) with a header deposit and no payment row ===`);
    for (const r of todo) {
      const l = ledgerRowFromHeader(r);
      note(`${r.doc_no} co=${r.company_id} ${r.status} deposit ${rm(r.deposit_sen)} -> is_deposit row: ${l.method}` +
        `${l.merchant_provider ? ` ${l.merchant_provider}` : ''}${l.installment_months ? ` ${l.installment_months}m` : ''}` +
        ` sheet=${l.account_sheet} appr=${r.approval_code ?? '-'} paid_at=${r.scanned_on}` +
        ` slip=${r.receipt_image_key ? 'receipt' : 'order slip'}${l.guessed ? ' (method not read, assumed Merchant)' : ''}`);
    }
    const noSlip = todo.filter((r) => !r.receipt_image_key && !r.slip_image_key);
    if (noSlip.length) { for (const r of noSlip) bad(`REFUSED: ${r.doc_no} has no slip image to prove the payment`); return 1; }
    if (!todo.length) { note('Nothing to do.'); return 0; }
    if (!APPLY) {
      note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
      note('After apply: run the Self-check payment backfill so each row gets its journal entry.');
      return 0;
    }
    await sql.begin(async (tx) => {
      const fresh = await scopeRows(tx);
      const key = (rs) => rs.map((r) => `${r.doc_no}|${r.company_id}|${r.deposit_sen}`).join(',');
      if (key(fresh) !== key(todo)) throw new Error('orders moved since the plan; nothing written');
      for (const r of todo) {
        const l = ledgerRowFromHeader(r);
        const noteText = `HC-0132 repair: the scanned slip's deposit, on the order header with no payment row, booked as its deposit row${l.guessed ? '; method not read, assumed card terminal (Merchant)' : ''}`;
        const [p] = await tx`
          INSERT INTO scm.mfg_sales_order_payments
            (company_id, so_doc_no, paid_at, method, merchant_provider, installment_months, online_type,
             approval_code, amount_sen, account_sheet, slip_key, collected_by, note, created_by, is_deposit)
          VALUES (${r.company_id}, ${r.doc_no}, ${r.scanned_on}, ${l.method}, ${l.merchant_provider}, ${l.installment_months},
                  ${l.online_type}, ${r.approval_code}, ${r.deposit_sen}, ${l.account_sheet},
                  ${r.receipt_image_key ?? r.slip_image_key}, ${r.salesperson_id}, ${noteText}, ${r.salesperson_id}, true)
          RETURNING id`;
        await tx`
          INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note, payment_id)
          VALUES (${r.doc_no}, ${r.company_id}, 'ADD_PAYMENT', 'System (HC-0132 repair)',
                  ${tx.json([{ field: 'paidAt', from: null, to: r.scanned_on }, { field: 'method', from: null, to: l.method },
                             { field: 'amountSen', from: null, to: Number(r.deposit_sen) }])},
                  ${r.status}, 'script', ${noteText}, ${String(p.id)})`;
      }
    });
  } finally {
    await sql.end();
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    let ok = true;
    for (const r of todo) {
      const rows = await check`
        SELECT amount_sen, is_deposit FROM scm.mfg_sales_order_payments
         WHERE company_id = ${r.company_id} AND so_doc_no = ${r.doc_no}`;
      const good = rows.length === 1 && rows[0].is_deposit === true && Number(rows[0].amount_sen) === Number(r.deposit_sen);
      if (!good) ok = false;
      (good ? note : bad)(`${r.doc_no}: ${rows.length} row(s)${rows[0] ? `, is_deposit=${rows[0].is_deposit}, ${rm(rows[0].amount_sen)}` : ''} ${good ? 'OK' : 'WRONG SHAPE'}`);
    }
    note('Next: run the Self-check payment backfill so each new row gets its journal entry.');
    return ok ? 0 : 1;
  } finally {
    await check.end();
  }
}

main().then((c) => process.exit(c), (e) => { bad(e.message); process.exit(1); });
