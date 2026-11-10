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
import { fakeRebankTx } from './fake-rebank-tx';

const CO = 1;
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
  sb.tables.acc_account_roles.find((r: Row) => r.company_id === CO)!.account_code = MBB;
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
    const r = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-1' }], fakeRebankTx(sb, null));
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['moved']);
    expect(liveLegs(sb, 'pay-1')).toEqual([{ date: '2026-10-05', bank: MBB }]);
    const contra = sb.tables.journal_entries.find((j: Row) => j.source_type !== 'SOPAY' && String(j.narration ?? '').includes('moved from'));
    expect(String(contra?.entry_date).slice(0, 10)).toBe('2026-10-05');

    const again = await rebankCandidates(sb, 1, '2026-10-01', '2026-10-31');
    expect(again.ok && again.rows.map((x) => x.paymentId)).toEqual(['pay-2']);
    /* Moving it twice skips it, and writes nothing. */
    const n = sb.tables.journal_entries.length;
    const twice = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-1' }], fakeRebankTx(sb, null));
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
    const moved = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-1' }, { source: 'SOPAY', paymentId: 'pay-2' }], fakeRebankTx(sb, null));
    expect(moved.ok && moved.results.map((x) => x.status)).toEqual(['skipped', 'skipped']);
    expect(sb.tables.journal_entries.length).toBe(n);
  });

  it('will not move another company\'s receipt or a cash payment by id', async () => {
    const sb = await world();
    const r = await rebankReceipts(sb, 1, [{ source: 'SOPAY', paymentId: 'pay-other-co' }, { source: 'SOPAY', paymentId: 'pay-cash' }], fakeRebankTx(sb, null));
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['skipped', 'skipped']);
    expect(liveLegs(sb, 'pay-other-co')).toEqual([{ date: '2026-10-05', bank: HLB }]);
  });
});

/* ALL OR NOTHING (owner-approved root fix). The contra and the new entry are
 * one transaction: a new entry that cannot post takes the contra back out, and
 * the receipt stays live on Hong Leong. Before this the reversal committed on
 * its own and the money sat in no bank. */
describe('a receipt moves whole or not at all', () => {
  type World = Awaited<ReturnType<typeof world>>;
  const allEntries = (sb: World) => JSON.stringify([sb.tables.journal_entries, sb.tables.journal_entry_lines]);
  /* Maybank deactivated after the list: the new entry is refused AFTER the contra was written. */
  const refuseMaybank = (sb: World) => {
    /* Copies, not the rows: CHART is shared by every world. */
    sb.tables.accounts = sb.tables.accounts.map((a: Row) => (a.account_code === MBB && a.company_id === CO ? { ...a, is_active: false } : a));
  };
  /* A client whose SOPAY entry insert throws, as the transaction client does on a database error. */
  const throwingOnPost = (message: string, paymentId: string | null) => (db: World): World => ({
    ...db,
    from: (t: string) => {
      const q = db.from(t);
      if (t !== 'journal_entries') return q;
      const insert = q.insert.bind(q);
      q.insert = (row: Row) => {
        if (row.source_type === 'SOPAY' && (paymentId === null || row.source_doc_no === paymentId)) throw new Error(message);
        return insert(row);
      };
      return q;
    },
  });

  it('the new entry refused: no reversal is left, the receipt is still live on Hong Leong, and it says so', async () => {
    const sb = await world();
    refuseMaybank(sb);
    const before = allEntries(sb);
    const tx = fakeRebankTx(sb, null);
    const r = await rebankReceipts(sb, CO, [{ source: 'SOPAY', paymentId: 'pay-1' }], tx);
    expect(r.ok && r.results[0]).toMatchObject({ status: 'failed', jeNo: null });
    expect(r.ok && r.results[0]!.reason).toMatch(new RegExp(`^nothing changed, still on ${HLB}: the new entry did not post: account_invalid`));
    expect(tx.rollbacks).toBe(1);
    expect(allEntries(sb)).toBe(before);
    expect(sb.tables.journal_entries.some((j: Row) => j.source_type === 'SOPAY_REVERSAL')).toBe(false);
    expect(liveLegs(sb, 'pay-1')).toEqual([{ date: '2026-10-05', bank: HLB }]);
  });

  it('the database failing mid-move (a thrown statement) rolls the contra back too', async () => {
    const sb = await world();
    const before = allEntries(sb);
    const r = await rebankReceipts(sb, CO, [{ source: 'SOPAY', paymentId: 'pay-1' }], fakeRebankTx(sb, throwingOnPost('connection reset', null)));
    expect(r.ok && r.results[0]).toMatchObject({ status: 'failed', reason: `nothing changed, still on ${HLB}: connection reset` });
    expect(allEntries(sb)).toBe(before);
  });

  it('success writes both: the contra on Hong Leong and the new entry on Maybank', async () => {
    const sb = await world();
    const tx = fakeRebankTx(sb, null);
    const r = await rebankReceipts(sb, CO, [{ source: 'SOPAY', paymentId: 'pay-1' }], tx);
    const out = r.ok ? r.results[0]! : null;
    expect(out).toMatchObject({ status: 'moved', reason: null });
    const orig = sb.tables.journal_entries.find((j: Row) => j.je_no === out!.fromJeNo)!;
    const contra = sb.tables.journal_entries.find((j: Row) => j.source_type === 'SOPAY_REVERSAL' && j.reversed_by_je === orig.id)!;
    expect(orig.reversed).toBe(true);
    expect(contra.posted).toBe(true);
    expect(sb.tables.journal_entry_lines.filter((l: Row) => l.journal_entry_id === contra.id && Number(l.credit_sen) > 0).map((l: Row) => l.account_code))
      .toEqual([HLB]);
    expect(sb.tables.journal_entries.find((j: Row) => j.je_no === out!.jeNo)).toMatchObject({ source_type: 'SOPAY', posted: true });
    expect(liveLegs(sb, 'pay-1')).toEqual([{ date: '2026-10-05', bank: MBB }]);
    expect(tx.rollbacks).toBe(0);
  });

  it('reports each receipt on its own: one failing does not undo the one before it, and a repeat is refused', async () => {
    const sb = await world();
    const r = await rebankReceipts(sb, CO, [
      { source: 'SOPAY', paymentId: 'pay-1' },
      { source: 'SOPAY', paymentId: 'pay-2' },
      { source: 'SOPAY', paymentId: 'pay-1' },
      { source: 'SOPAY', paymentId: 'pay-cash' },
    ], fakeRebankTx(sb, throwingOnPost('disk full', 'pay-2')));
    expect(r.ok && r.results.map((x) => [x.paymentId, x.status, x.reason])).toEqual([
      ['pay-1', 'moved', null],
      ['pay-2', 'failed', `nothing changed, still on ${HLB}: disk full`],
      ['pay-1', 'skipped', 'listed twice in this move'],
      ['pay-cash', 'skipped', `not a transfer receipt on another bank than ${MBB}`],
    ]);
    expect(liveLegs(sb, 'pay-1')).toEqual([{ date: '2026-10-05', bank: MBB }]);
    expect(liveLegs(sb, 'pay-2')).toEqual([{ date: '2026-10-06', bank: HLB }]);
  });

  it('company scope: a statement match made after the list refuses inside the transaction, but only this company\'s match', async () => {
    const sb = await world();
    const je1 = sb.tables.journal_entries.find((j: Row) => j.source_doc_no === 'pay-1')!.je_no;
    const je2 = sb.tables.journal_entries.find((j: Row) => j.source_doc_no === 'pay-2')!.je_no;
    /* The matches land between the list and the move: pay-1's in THIS company, pay-2's number in another. */
    let landed = false;
    const tx = fakeRebankTx(sb, (db) => {
      if (!landed) { landed = true; db.tables.acc_bank_statement_matches.push({ company_id: CO, je_no: je1 }, { company_id: 2, je_no: je2 }); }
      return db;
    });
    const r = await rebankReceipts(sb, CO, [{ source: 'SOPAY', paymentId: 'pay-1' }, { source: 'SOPAY', paymentId: 'pay-2' }], tx);
    expect(r.ok && r.results.map((x) => [x.paymentId, x.status, x.reason])).toEqual([
      ['pay-1', 'skipped', `already matched on the ${HLB} statement`],
      ['pay-2', 'moved', null],
    ]);
    expect(liveLegs(sb, 'pay-1')).toEqual([{ date: '2026-10-05', bank: HLB }]);
    /* Another company's receipt, named by id, is never touched on the atomic path. */
    const other = await rebankReceipts(sb, CO, [{ source: 'SOPAY', paymentId: 'pay-other-co' }], fakeRebankTx(sb, null));
    expect(other.ok && other.results[0]!.status).toBe('skipped');
    expect(liveLegs(sb, 'pay-other-co')).toEqual([{ date: '2026-10-05', bank: HLB }]);
  });

  it('RECEIPT_REBANK_MODE=two-step (tx null) still runs the old path; the reversal it leaves is why it is the rollback, not the default', async () => {
    const sb = await world();
    refuseMaybank(sb);
    const r = await rebankReceipts(sb, CO, [{ source: 'SOPAY', paymentId: 'pay-1' }], null);
    expect(r.ok && r.results[0]!.reason).toMatch(/^reversed, but the new entry did not post/);
    expect(liveLegs(sb, 'pay-1')).toEqual([]);
  });
});
