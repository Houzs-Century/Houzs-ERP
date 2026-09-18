/* "Find the sale" — the payment the window could not offer, chosen by a person.
 *
 * Owner 2026-09-10, on a GHL line the screen called "no sale in the ERP":
 * 「我要怎样选对应的 SO?」. The sale WAS in the ERP — 2990-SO-2606-011, the same
 * RM 2,865.00, keyed twelve days after the swipe and with no bank on it — and
 * the matcher never loaded it because GHL's window is three days. The window
 * is right for "what could plausibly be this"; it is the wrong instrument for
 * "the person knows which sale this is". So the line gains a search over the
 * company's card payments, whatever their date, with the system's own
 * "possible" ones ranked first (owner: 你可以注明 possible，但不能不让我选其他的).
 *
 * Three rules, each a case below: only card / instalment / migration-era
 * payments (a cash sale is not on a merchant report); nothing another line has
 * already claimed; and — on CONFIRM, not on search — the amount must equal
 * the line's gross, read back from the database and not trusted from the
 * screen, because the manual path is exactly where a stale or hand-edited
 * amount would slip through (owner: 金额要跟 report 上的 gross 一样才给确认).
 */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { confirmSettlementRow, findPaymentsForRow } from './settlement';

const CHART: Row[] = ['300-0000', '326-0000', '326-0020', '900-T009'].map((code) => ({
  account_code: code, account_name: code, account_type: code.startsWith('9') ? 'EXPENSE' : 'ASSET', parent_code: null, is_active: true, company_id: 2,
}));

const so = (doc_no: string, debtor_name: string, salesperson_id: string | null = null): Row => ({ doc_no, company_id: 2, debtor_name, customer_id: `c-${doc_no}`, debtor_code: null, salesperson_id });
const pay = (id: string, so_doc_no: string, over: Partial<Row> = {}): Row => ({
  id, so_doc_no, company_id: 2, paid_at: '2026-06-14', method: 'installment', merchant_provider: null,
  amount_sen: 286_500, approval_code: '005751', collected_by: null, created_by: 'u1', ...over,
});

const world = (over: { matches?: Row[]; pays?: Row[] } = {}) => fakeSb({
  accounts: CHART,
  acc_account_roles: [],
  acc_acquirers: [{ company_id: 2, code: 'GHL', display_name: 'GHL', transit_account_code: '326-0020', fee_account_code: '900-T009', bank_account_code: null, date_tolerance_days: 3, has_unique_ref: false, fee_method: 'stated', is_active: true }],
  acc_settlement_batches: [{ id: 5, company_id: 2, acquirer_code: 'GHL', file_name: 'StatementOfAccountDetails2026-06-05.csv', period_from: '2026-06-02', period_to: '2026-06-02', net_sen: 275_040, stated_net_sen: 275_040 }],
  acc_settlement_rows: [
    { id: 2, batch_id: 5, company_id: 2, acquirer_code: 'GHL', line_no: 2, txn_date: '2026-06-02', ref: '615318040666', gross_sen: 286_500, fee_sen: 11_460, net_sen: 275_040, bucket: 'UNMATCHED', confirmed_at: null, posted_je_no: null },
    /* Another company's line with the same id shape — never reachable from company 2. */
    { id: 3, batch_id: 6, company_id: 1, acquirer_code: 'GHL', line_no: 1, txn_date: '2026-06-02', ref: null, gross_sen: 100, fee_sen: 0, net_sen: 100, bucket: 'UNMATCHED', confirmed_at: null, posted_je_no: null },
  ],
  acc_settlement_matches: over.matches ?? [],
  mfg_sales_orders: [
    so('2990-SO-2606-011', 'Chou Mun Yee', 's-kw'),
    so('2990-SO-2606-013', 'Tan Ah Kow'),
    so('2990-SO-2606-002', 'Wong li way'),
    so('2990-SO-2605-090', 'Lim Siew Mei'),
  ],
  mfg_sales_order_payments: over.pays ?? [
    pay('p-011', '2990-SO-2606-011'),                                                        // the one: same amount, 12 days off, no bank
    pay('p-013', '2990-SO-2606-013', { amount_sen: 336_500, approval_code: '009577' }),     // different amount
    pay('p-002', '2990-SO-2606-002', { amount_sen: 168_300, method: 'merchant', merchant_provider: 'MBB', paid_at: '2026-06-12' }),
    pay('p-cash', '2990-SO-2605-090', { amount_sen: 286_500, method: 'cash', paid_at: '2026-06-02' }),   // same amount, but cash
    pay('p-old', '2990-SO-2605-090', { amount_sen: 286_500, method: 'merchant', merchant_provider: 'GHL', paid_at: '2026-05-01' }), // same amount, months earlier
    pay('p-theirs', 'HC-SO-1', { company_id: 1, amount_sen: 286_500 }),                     // other company
  ],
  sales_invoice_payments: [],
  sales_invoices: [],
  journal_entries: [],
  journal_entry_lines: [],
  staff: [{ id: 's-kw', name: 'Kah Wai' }],
}, {}, [], ['acc_settlement_rows', 'acc_settlement_batches', 'acc_settlement_matches']);

describe('findPaymentsForRow', () => {
  it('finds the sale by its document number, whatever its date, and marks the exact amount possible', async () => {
    const out = await findPaymentsForRow(world(), 2, 2, 'SO-2606-011');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments.map((p) => p.id)).toEqual(['p-011']);
    expect(out.payments[0]).toMatchObject({ docNo: '2990-SO-2606-011', customerName: 'Chou Mun Yee', amountSen: 286_500, paidOn: '2026-06-14', possible: true, merchantProvider: null });
  });

  it('finds by the customer\'s name, case-insensitively', async () => {
    const out = await findPaymentsForRow(world(), 2, 2, 'chou');
    expect(out.ok && out.payments.map((p) => p.id)).toEqual(['p-011']);
  });

  it('finds by the amount typed as money', async () => {
    const out = await findPaymentsForRow(world(), 2, 2, '2865');
    expect(out.ok && out.payments.map((p) => p.id).sort()).toEqual(['p-011', 'p-old']);
  });

  it('with nothing typed, lists the company\'s card payments — possible ones first, then newest first', async () => {
    const out = await findPaymentsForRow(world(), 2, 2, '');
    expect(out.ok && out.payments.map((p) => `${p.id}:${p.possible ? 'Y' : 'n'}`)).toEqual([
      'p-011:Y', 'p-old:Y', 'p-013:n', 'p-002:n',
    ]);
  });

  /* A cash sale is not on any merchant report, and another company's money is
     not this company's to claim. Neither appears however well the amount agrees. */
  it('never offers a cash payment, or another company\'s', async () => {
    const out = await findPaymentsForRow(world(), 2, 2, '');
    const ids = out.ok ? out.payments.map((p) => p.id) : [];
    expect(ids).not.toContain('p-cash');
    expect(ids).not.toContain('p-theirs');
  });

  it('never offers a payment another line has already claimed', async () => {
    const out = await findPaymentsForRow(world({ matches: [{ id: 1, settlement_row_id: 9, company_id: 2, payment_source: 'SOPAY', payment_id: 'p-011', amount_sen: 286_500 }] }), 2, 2, 'SO-2606-011');
    expect(out.ok && out.payments).toEqual([]);
  });

  it('refuses a line that is not this company\'s', async () => {
    const out = await findPaymentsForRow(world(), 2, 3, '');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.status).toBe('not_found');
  });

  it('a read that fails is a refusal, not an empty list', async () => {
    const sb = fakeSb({ acc_settlement_rows: [{ id: 2, company_id: 2, gross_sen: 286_500 }], acc_settlement_matches: [], mfg_sales_order_payments: [], sales_invoice_payments: [], mfg_sales_orders: [], sales_invoices: [] }, { mfg_sales_order_payments: ['approval_code'] }, [], ['acc_settlement_rows']);
    const out = await findPaymentsForRow(sb, 2, 2, '');
    expect(out.ok).toBe(false);
  });
});

describe('confirmSettlementRow reads the chosen payments back, and trusts nothing from the screen', () => {
  const confirm = (sb: ReturnType<typeof world>, payments: Array<{ source: 'SOPAY' | 'SIPAY'; id: string; docNo: string | null; amountSen: number }>) =>
    confirmSettlementRow(sb, { companyId: 2, rowId: 2, matchReason: 'manual', userName: 'Chew', payments });

  it('confirms the found sale — the fee posts, the payment is claimed, and its bank is stamped', async () => {
    const sb = world();
    const out = await confirm(sb, [{ source: 'SOPAY', id: 'p-011', docNo: '2990-SO-2606-011', amountSen: 286_500 }]);
    expect(out).toMatchObject({ ok: true, status: 'confirmed' });
    expect(sb.tables.acc_settlement_matches).toHaveLength(1);
    expect(sb.tables.mfg_sales_order_payments.find((p: Row) => p.id === 'p-011')!.merchant_provider).toBe('GHL');
  });

  it('refuses a payment that is not in this company\'s books, or does not exist', async () => {
    expect((await confirm(world(), [{ source: 'SOPAY', id: 'p-theirs', docNo: null, amountSen: 286_500 }])).status).toBe('payment_not_found');
    expect((await confirm(world(), [{ source: 'SOPAY', id: 'p-nope', docNo: null, amountSen: 286_500 }])).status).toBe('payment_not_found');
  });

  /* THE RULE THE OWNER SET. The screen said RM 2,865.00; the row says something
     else now (edited since, or a stale list). The database's figure is the
     one that must equal the gross — and here it does not. */
  it('refuses when the payment\'s own amount is not the line\'s gross, whatever the screen sent', async () => {
    const sb = world({ pays: [pay('p-011', '2990-SO-2606-011', { amount_sen: 286_400 })] });
    const out = await confirm(sb, [{ source: 'SOPAY', id: 'p-011', docNo: '2990-SO-2606-011', amountSen: 286_500 }]);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('amount_mismatch');
    expect(!out.ok && out.reason).toMatch(/2,864\.00|2864\.00/);
    expect(sb.tables.acc_settlement_matches).toHaveLength(0);
  });

  it('refuses a cash payment — a merchant report cannot be explained by cash', async () => {
    const out = await confirm(world(), [{ source: 'SOPAY', id: 'p-cash', docNo: '2990-SO-2605-090', amountSen: 286_500 }]);
    expect(out.ok).toBe(false);
    expect(out.status).toBe('not_card_payment');
  });
});
