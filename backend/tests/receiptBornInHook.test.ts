/* The Official Receipt is born in the one hook every SO payment row reaches
   (docs/bugs/0935) — bookSoPaymentBestEffort, beside the booking and the
   deposit invoice — so the SO-create inserts (the POS deposit, the split
   rows), which reach the hook and never reached recordSoPaymentRow, receipt
   their money too. Pinned:
     · a card row booked through the hook births a DRAFT receipt on the
       payment's month; a cash row a FORMAL one at once;
     · the row as SO-create selects it (no created_by) is enough;
     · booking the same row twice finds the same receipt;
     · a converted row births none — it was receipted when first received. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bookSoPaymentBestEffort } from '../src/scm/lib/so-payment-row';

const CO = 2;
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const world = () => fakeSb(
  {
    accounts: [
      acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
      acct('310-0010', 'CASH AT BANK - MAYBANK', 'ASSET'),
      acct('320-0000', 'CASH IN HAND', 'ASSET'),
      acct('326-0000', 'CARD MACHINE CLEARING (EDC)', 'ASSET'),
    ],
    companies: [{ id: CO, code: '2990', name: '2990' }],
    mfg_sales_orders: [{ doc_no: '2990-SO-2609-001', company_id: CO, debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-1', status: 'CONFIRMED' }],
    mfg_sales_order_payments: [],
    acc_account_roles: [],
    acc_company_settings: [],
    acc_deposit_invoices: [],
    acc_official_receipts: [],
    acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }],
    acc_numbering: [],
    journal_entries: [], journal_entry_lines: [],
  },
  {},
  [
    { table: 'acc_official_receipts', column: 'or_number', name: 'acc_official_receipts_or_number_key' },
    { table: 'acc_official_receipts', column: 'payment_id', name: 'acc_official_receipts_payment_once' },
  ],
  ['journal_entry_lines', 'acc_official_receipts'],
);

/** The deposit row exactly as SO-create selects it back — no created_by. */
const soCreateRow = (id: string, over: Row = {}): Row => ({
  id, so_doc_no: '2990-SO-2609-001', paid_at: '2026-09-05', method: 'merchant', merchant_provider: 'MBB', amount_sen: 100_000, company_id: CO, ...over,
});
const receipts = (sb: ReturnType<typeof world>) => sb.tables.acc_official_receipts as Row[];

describe('the receipt is born with the booking', () => {
  test('a card row from SO-create births a DRAFT on the payment month; the same row again finds it', async () => {
    const sb = world();
    await bookSoPaymentBestEffort(sb, soCreateRow('p-1'), 'deposit at SO create');
    expect(receipts(sb)).toHaveLength(1);
    expect(receipts(sb)[0]).toMatchObject({ payment_source: 'SOPAY', payment_id: 'p-1', status: 'DRAFT', or_number: '2990-DraftOR-2609-001', amount_sen: 100_000, doc_no: '2990-SO-2609-001', method: 'merchant', created_by: null });
    await bookSoPaymentBestEffort(sb, soCreateRow('p-1'), 'deposit at SO create');
    expect(receipts(sb)).toHaveLength(1);
    /* And it was booked — the hook still books. */
    expect((sb.tables.journal_entries as Row[]).map((j) => j.source_type)).toEqual(['SOPAY']);
  });

  test('a cash row is formal at once; a converted row gets no receipt', async () => {
    const sb = world();
    await bookSoPaymentBestEffort(sb, soCreateRow('p-2', { method: 'cash', merchant_provider: null, created_by: 'u-1' }), 'split payment at SO create');
    expect(receipts(sb)).toHaveLength(1);
    expect(receipts(sb)[0]).toMatchObject({ payment_id: 'p-2', status: 'FORMAL', created_by: 'u-1' });
    expect(String(receipts(sb)[0]!.or_number)).toMatch(/^2990-COR-2609-\d{3}$/);
    await bookSoPaymentBestEffort(sb, soCreateRow('p-3', { method: 'converted', merchant_provider: null, converted_from_so_doc_no: '2990-SO-2607-024' }), 'split payment at SO create');
    expect(receipts(sb).map((r) => r.payment_id)).toEqual(['p-2']);
  });
});
