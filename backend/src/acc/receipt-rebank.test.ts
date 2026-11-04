/* Moving earlier transfer receipts onto the bank the company now receives into
 * (owner 2026-11-04: 之前的收款我做maybank recon 时会有出现了吗？ → 做改记工具).
 *
 * Pinned: a transfer booked on Hong Leong is listed once Receive into is
 * Maybank, and moving it leaves ONE live entry, on Maybank, on the payment's
 * own date, with the Hong Leong pair reversed on that same date. A receipt
 * already matched on the Hong Leong statement, or in a closed month on either
 * bank, is listed with why and refused. Cash and card payments are never
 * candidates, and another company's receipts are invisible.
 */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { postSoPayment, type SoPaymentRow } from './payments';
import { rebankCandidates, rebankReceipts } from './receipt-rebank';

const HLB = '310-0020';
const MBB = '310-0010';
const CHART: Row[] = ['300-0000', '320-0000', MBB, HLB].flatMap((code) => [1, 2].map((company_id) => ({
  account_code: code, account_name: code, account_type: 'ASSET', parent_code: null, is_active: true, acc_money: code.startsWith('310'), company_id,
})));

const SO = (doc: string, company_id = 1): Row => ({ doc_no: doc, company_id, debtor_name: 'Ah Meng', phone: '0123', customer_id: 'cust-1', debtor_code: null });
const PAY = (id: string, over: Partial<Row> = {}): Row => ({
  id, so_doc_no: 'SO-2610-001', paid_at: '2026-10-05T14:00:00+08:00', method: 'transfer', merchant_provider: null, amount_sen: 50_000, company_id: 1, ...over,
});

/* Everything booked while Receive into was Hong Leong; then the owner set Maybank. */
async function world(extra: { matches?: Row[]; locks?: Row[] } = {}) {
  const pays = [
    PAY('pay-1'),
    PAY('pay-2', { paid_at: '2026-10-06T10:00:00+08:00', amount_sen: 12_345 }),
    PAY('pay-cash', { method: 'cash' }),
    PAY('pay-other-co', { so_doc_no: 'SO-2610-900', company_id: 2 }),
  ];
  const sb = fakeSb({
    accounts: CHART,
    acc_account_roles: [{ company_id: 1, role: 'BANK_DEFAULT', account_code: HLB }, { company_id: 2, role: 'BANK_DEFAULT', account_code: HLB }],
    acc_acquirers: [],
    mfg_sales_orders: [SO('SO-2610-001'), SO('SO-2610-900', 2)],
    mfg_sales_order_payments: pays,
    sales_invoice_payments: [],
    sales_invoices: [],
    journal_entries: [],
    journal_entry_lines: [],
    acc_bank_statement_matches: extra.matches ?? [],
    acc_bank_month_locks: extra.locks ?? [],
  });
  for (const p of pays) expect((await postSoPayment(sb, p as unknown as SoPaymentRow)).ok).toBe(true);
  sb.tables.acc_account_roles.find((r: Row) => r.company_id === 1)!.account_code = MBB;
  return sb;
}

const liveLegs = (sb: Awaited<ReturnType<typeof world>>, paymentId: string) => {
  const live = sb.tables.journal_entries.filter((j: Row) => j.source_type === 'SOPAY' && j.source_doc_no === paymentId && !j.reversed);
  return live.map((j: Row) => ({
    date: String(j.entry_date).slice(0, 10),
    bank: sb.tables.journal_entry_lines.find((l: Row) => l.journal_entry_id === j.id && Number(l.debit_sen) > 0)?.account_code,
  }));
};

describe('moving transfer receipts to Receive into', () => {
  it('lists this company\'s transfers on another bank — never cash, never another company', async () => {
    const sb = await world();
    const r = await rebankCandidates(sb, 1, '2026-10-01', '2026-10-31');
    expect(r.ok && r.target).toBe(MBB);
    expect(r.ok && r.rows.map((x) => [x.paymentId, x.fromAccount, x.amountSen, x.blocked])).toEqual([
      ['pay-1', HLB, 50_000, null],
      ['pay-2', HLB, 12_345, null],
    ]);
  });

  it('moves one: one live entry on Maybank on its own date; the Hong Leong pair reversed that day; then nothing left', async () => {
    const sb = await world();
    const r = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-1' }]);
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['moved']);
    expect(liveLegs(sb, 'pay-1')).toEqual([{ date: '2026-10-05', bank: MBB }]);
    const contra = sb.tables.journal_entries.find((j: Row) => j.source_type !== 'SOPAY' && String(j.narration ?? '').includes('moved from'));
    expect(String(contra?.entry_date).slice(0, 10)).toBe('2026-10-05');

    const again = await rebankCandidates(sb, 1, '2026-10-01', '2026-10-31');
    expect(again.ok && again.rows.map((x) => x.paymentId)).toEqual(['pay-2']);
    /* Moving it twice skips it, and writes nothing. */
    const n = sb.tables.journal_entries.length;
    const twice = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-1' }]);
    expect(twice.ok && twice.results[0]!.status).toBe('skipped');
    expect(sb.tables.journal_entries.length).toBe(n);
  });

  it('refuses a receipt matched on the Hong Leong statement, and one in a closed month on either bank', async () => {
    const probe = await world();
    const je1 = probe.tables.journal_entries.find((j: Row) => j.source_doc_no === 'pay-1')!.je_no;
    const sb = await world({
      matches: [{ company_id: 1, je_no: je1 }],
      locks: [{ company_id: 1, account_code: MBB, period_month: '2026-10-01', released_at: null }],
    });
    const r = await rebankCandidates(sb, 1, '2026-10-01', '2026-10-31');
    expect(r.ok && r.rows.map((x) => x.blocked)).toEqual([
      `already matched on the ${HLB} statement`,
      `${MBB} 2026-10 is closed — unlock it first`,
    ]);
    const n = sb.tables.journal_entries.length;
    const moved = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-1' }, { source: 'SOPAY', paymentId: 'pay-2' }]);
    expect(moved.ok && moved.results.map((x) => x.status)).toEqual(['skipped', 'skipped']);
    expect(sb.tables.journal_entries.length).toBe(n);
  });

  it('will not move another company\'s receipt or a cash payment by id', async () => {
    const sb = await world();
    const r = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-other-co' }, { source: 'SOPAY', paymentId: 'pay-cash' }]);
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['skipped', 'skipped']);
    expect(liveLegs(sb, 'pay-other-co')).toEqual([{ date: '2026-10-05', bank: HLB }]);
  });
});
