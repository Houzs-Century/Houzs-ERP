/* Confirming a transfer into a bank that is not the default (Conts #476).
 *
 * A transfer is booked on the default bank (Hong Leong) when it is recorded.
 * Finance confirms it into Maybank: the receipt used to say Maybank while the
 * journal stayed on Hong Leong, so the Maybank reconciliation never showed the
 * money. Pinned: the confirm moves the entry first — one live entry, on
 * Maybank, on the payment's own date — then stamps the receipt; a confirm onto
 * the bank it is already on moves nothing; a payment matched on the Hong Leong
 * statement refuses the confirm and leaves the receipt a draft; a card
 * payment's receipt never moves its entry (its money leg is the clearing
 * account by design).
 */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { postSoPayment, type SoPaymentRow } from './payments';
import { formaliseReceipt } from './receipts';
import { rebankCandidates } from './receipt-rebank';
import { fakeRebankTx } from './fake-rebank-tx';

const CO = 1;
const HLB = '310-0020';
const MBB = '310-0010';
const CHART: Row[] = ['300-0000', '320-0000', '888-0000', MBB, HLB].map((code) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, acc_money: code.startsWith('310'), company_id: CO,
}));

const PAY = (id: string, over: Partial<Row> = {}): Row => ({
  id, so_doc_no: 'SO-2611-001', paid_at: '2026-11-05T14:00:00+08:00', method: 'transfer', merchant_provider: null, amount_sen: 50_000, company_id: CO, ...over,
});
const RECEIPT = (id: number, paymentId: string, method = 'transfer'): Row => ({
  id, company_id: CO, or_number: `HCDraftOR-2611-00${id}`, status: 'DRAFT', paid_at: '2026-11-05T14:00:00+08:00',
  method, payment_source: 'SOPAY', payment_id: paymentId, amount_sen: 50_000,
});

async function world(extra: { matches?: Row[] } = {}) {
  const pays = [PAY('pay-1'), PAY('pay-card', { method: 'merchant', merchant_provider: 'MBB' })];
  const sb = fakeSb({
    accounts: CHART,
    acc_account_roles: [{ company_id: CO, role: 'BANK_DEFAULT', account_code: HLB }],
    acc_acquirers: [{ company_id: CO, code: 'MBB', display_name: 'MBB', transit_account_code: '888-0000', is_active: true }],
    acc_bank_letters: [{ company_id: CO, account_code: MBB, letter: 'M' }, { company_id: CO, account_code: HLB, letter: 'H' }],
    acc_company_settings: [],
    mfg_sales_orders: [{ doc_no: 'SO-2611-001', company_id: CO, debtor_name: 'Ah Meng', phone: '0123', customer_id: 'cust-1', debtor_code: null }],
    mfg_sales_order_payments: pays,
    sales_invoice_payments: [],
    sales_invoices: [],
    journal_entries: [],
    journal_entry_lines: [],
    acc_official_receipts: [RECEIPT(1, 'pay-1'), RECEIPT(2, 'pay-card', 'merchant')],
    acc_bank_statement_matches: extra.matches ?? [],
    acc_bank_month_locks: [],
  });
  for (const p of pays) expect((await postSoPayment(sb, p as unknown as SoPaymentRow)).ok).toBe(true);
  return sb;
}

const liveBanks = (sb: Awaited<ReturnType<typeof world>>, paymentId: string) =>
  sb.tables.journal_entries
    .filter((j: Row) => j.source_type === 'SOPAY' && j.source_doc_no === paymentId && !j.reversed)
    .map((j: Row) => ({
      date: String(j.entry_date).slice(0, 10),
      bank: sb.tables.journal_entry_lines.find((l: Row) => l.journal_entry_id === j.id && Number(l.debit_sen) > 0)?.account_code,
    }));

const confirm = (sb: Awaited<ReturnType<typeof world>>, receiptId: number, accountCode: string) =>
  formaliseReceipt(sb, { companyId: CO, companyCode: 'HOUZS', receiptId, accountCode, actor: 'Finance', rebankTx: fakeRebankTx(sb, null) });

describe('confirming a transfer into a chosen bank', () => {
  it('moves the entry to the chosen bank, on its own date, then stamps the receipt', async () => {
    const sb = await world();
    expect(liveBanks(sb, 'pay-1')).toEqual([{ date: '2026-11-05', bank: HLB }]);
    const r = await confirm(sb, 1, MBB);
    expect(r.ok).toBe(true);
    expect(liveBanks(sb, 'pay-1')).toEqual([{ date: '2026-11-05', bank: MBB }]);
    expect(sb.tables.acc_official_receipts.find((x: Row) => x.id === 1)).toMatchObject({ status: 'FORMAL', channel_account_code: MBB });
  });

  it('the rebank clean-up leaves a receipt confirmed into another bank where it is', async () => {
    const sb = await world();
    expect((await confirm(sb, 1, MBB)).ok).toBe(true);
    const r = await rebankCandidates(sb, CO, '2026-11-01', '2026-11-30');
    expect(r).toMatchObject({ ok: true, target: HLB, rows: [] });
  });

  it('a confirm onto the bank it is already on moves nothing', async () => {
    const sb = await world();
    const before = sb.tables.journal_entries.length;
    expect((await confirm(sb, 1, HLB)).ok).toBe(true);
    expect(sb.tables.journal_entries.length).toBe(before);
    expect(liveBanks(sb, 'pay-1')).toEqual([{ date: '2026-11-05', bank: HLB }]);
  });

  it('a payment matched on the Hong Leong statement refuses the confirm; the receipt stays a draft', async () => {
    const pre = await world();
    const jeNo = pre.tables.journal_entries.find((j: Row) => j.source_doc_no === 'pay-1')!.je_no;
    const sb = await world({ matches: [{ id: 1, company_id: CO, bank_line_id: 9, je_no: jeNo }] });
    const r = await confirm(sb, 1, MBB);
    expect(r).toMatchObject({ ok: false, status: 'payment_reconciled' });
    expect(liveBanks(sb, 'pay-1')).toEqual([{ date: '2026-11-05', bank: HLB }]);
    expect(sb.tables.acc_official_receipts.find((x: Row) => x.id === 1)).toMatchObject({ status: 'DRAFT' });
  });

  it('a card payment\'s receipt never moves its entry off the clearing account', async () => {
    const sb = await world();
    expect((await confirm(sb, 2, MBB)).ok).toBe(true);
    expect(liveBanks(sb, 'pay-card')).toEqual([{ date: '2026-11-05', bank: '888-0000' }]);
  });
});
