// The Daily Bank board's arithmetic. The decisions pinned: opening is strictly
// BEFORE the date, the day's movements split into receipts and payouts, lines
// after the date never bleed backwards, transit is an as-of balance shown but
// not counted as movable, and available = money closing minus pending.

import { describe, it, expect } from 'vitest';
import { computeDailyBank, voucherPayoutSen, type CashbookPayout, type CashbookReceipt, type GlLine } from './daily-bank';

const MONEY = [
  { account_code: '310-0010', account_name: 'Bank — Maybank Current' },
  { account_code: '320-0000', account_name: 'CASH IN HAND' },
];
const TRANSIT = [
  { acquirerCode: 'MBB', account_code: '326-0000', account_name: 'Card Machine Clearing (EDC)' },
];

const L = (over: Partial<GlLine>): GlLine => ({
  entry_date: '2026-08-16',
  je_no: 'JE-2608-0001',
  source_type: 'SOPAY',
  source_doc_no: 'pay-1',
  account_code: '310-0010',
  debit_sen: 0,
  credit_sen: 0,
  notes: null,
  ...over,
});

describe('computeDailyBank', () => {
  it('opening strictly before the date; the day splits into receipts and payouts; tomorrow never bleeds back', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [
      L({ entry_date: '2026-08-10', debit_sen: 100000 }),                       // opening +1000.00
      L({ entry_date: '2026-08-16', je_no: 'JE-A', debit_sen: 50000 }),          // today in
      L({ entry_date: '2026-08-16', je_no: 'JE-B', credit_sen: 20000, source_type: 'PV' }), // today out
      L({ entry_date: '2026-08-17', debit_sen: 999999 }),                        // tomorrow — ignored
    ], [], null);
    const bank = board.blocks[0];
    expect(bank).toMatchObject({ openingSen: 100000, inSen: 50000, outSen: 20000, closingSen: 130000 });
    expect(bank.receipts).toHaveLength(1);
    expect(bank.receipts[0]).toMatchObject({ jeNo: 'JE-A', amountSen: 50000 });
    expect(bank.payouts[0]).toMatchObject({ jeNo: 'JE-B', amountSen: 20000, sourceType: 'PV' });
  });

  it('transit is an as-of balance (≤ date) and is NOT part of available', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [
      L({ account_code: '326-0000', entry_date: '2026-08-14', debit_sen: 70000 }),
      L({ account_code: '326-0000', entry_date: '2026-08-16', debit_sen: 30000 }),
      L({ account_code: '310-0010', entry_date: '2026-08-16', debit_sen: 10000 }),
    ], [], null);
    expect(board.transit[0].balanceSen).toBe(100000);
    expect(board.totalTransitSen).toBe(100000);
    expect(board.availableSen).toBe(10000); // bank only — swiped money cannot be spent yet
  });

  it('an account with no lines still renders as a zero block — absence is a value, not a crash', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [], [], null);
    expect(board.blocks).toHaveLength(2);
    expect(board.blocks[1]).toMatchObject({ openingSen: 0, closingSen: 0 });
    expect(board.availableSen).toBe(0);
  });

  it('phase 3: vouchers in the approval queue subtract from available — asked-for money is not spendable', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [
      L({ entry_date: '2026-08-10', debit_sen: 100000 }),
    ], [
      { total_sen: 30000, exchange_rate: 1 },            // RM 300.00 awaiting a yes
      { total_sen: 10000, exchange_rate: 0.619838 },     // ¥100.00 → RM 61.98, converted the way posting will
    ], null);
    expect(board.pendingApprovalSen).toBe(30000 + Math.round(10000 * 0.619838));
    expect(board.availableSen).toBe(100000 - board.pendingApprovalSen);
  });

  it('phase 3: a garbage rate falls back to 1, never to zero pending', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [], [
      { total_sen: 5000, exchange_rate: null },
      { total_sen: 5000, exchange_rate: 'not-a-number' },
    ], null);
    expect(board.pendingApprovalSen).toBe(10000);
  });
});

/* By bank (owner 2026-09-29, his "BANK BALANCE AVAILABLE" sample): the pending
   vouchers sit on the account they pay from, the card money on the bank its
   acquirer pays into, each block carries its own available and the line with
   the transit added; what names no bank on the board stays in its own list,
   still inside the totals. */
describe('computeDailyBank — by bank', () => {
  const BANKS = [
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK' },
    { account_code: '310-0020', account_name: 'CASH AT BANK - HLBB' },
  ];
  const ACQUIRERS = [
    { acquirerCode: 'MBB', account_code: '326-0020', account_name: 'CARD MACHINE CLEARING — MBB', bankAccountCode: '310-0010' },
    { acquirerCode: 'PBB', account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB', bankAccountCode: '310-0020' },
    { acquirerCode: 'GHL', account_code: '326-0030', account_name: 'CARD MACHINE CLEARING — GHL', bankAccountCode: '310-0020' },
    { acquirerCode: 'Untagged bank', account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)', bankAccountCode: null },
  ];
  const DAY = '2026-09-29';
  const LEDGER: GlLine[] = [
    L({ account_code: '310-0020', entry_date: '2026-09-28', debit_sen: 6_172_699 }),          // HLBB B/F 61,726.99
    L({ account_code: '310-0020', entry_date: DAY, je_no: 'JE-IN', debit_sen: 285_000, source_type: 'SOPAY', source_doc_no: 'pay-9', party: 'Hookka', doc_no: 'OR-0443', notes: 'Settle invoice' }),
    L({ account_code: '310-0020', entry_date: DAY, je_no: 'JE-OUT', credit_sen: 44_264, source_type: 'PV', source_doc_no: 'PV-0432', party: 'Tan Yong Hong', notes: 'Claude - Sep' }),
    L({ account_code: '310-0010', entry_date: '2026-09-01', debit_sen: 100_000 }),             // Maybank B/F 1,000.00
    L({ account_code: '326-0020', entry_date: '2026-09-20', debit_sen: 4_677_417 }),
    L({ account_code: '326-0010', entry_date: '2026-09-20', debit_sen: 3_750_352 }),
    L({ account_code: '326-0030', entry_date: '2026-09-25', debit_sen: 4_220_064 }),
    L({ account_code: '326-0000', entry_date: '2026-09-25', debit_sen: 336_500 }),
  ];
  const PENDING = [
    { id: 'pv-1', pv_number: 'HPV-023', payee_name: 'UNICOM', notes: 'BILL IV2026-09-007', purpose: 'OTHER', credit_account_code: '310-0020', voucher_date: '2026-09-18', total_sen: 1_083_600, exchange_rate: 1 },
    { id: 'pv-2', pv_number: 'HPV-030', payee_name: 'UMOBILE', notes: '', purpose: 'SUPPLIER_PAYMENT', credit_account_code: '310-0020', voucher_date: DAY, total_sen: 7_210, exchange_rate: 1 },
    { id: 'pv-3', pv_number: 'HPV-040', payee_name: 'PETTY', notes: 'Cash float', purpose: 'OTHER', credit_account_code: '320-0000', voucher_date: DAY, total_sen: 5_000, exchange_rate: 1 },
  ];

  it('a pending voucher reads what it pays for when the route read it, never its bill number (owner 2026-11-09)', () => {
    const described = PENDING.map((v) => (v.id === 'pv-1' ? { ...v, description_text: '15 FOOTER NON LED TRUCK (1 WEEK)' } : v));
    const hlbb = computeDailyBank(DAY, BANKS, ACQUIRERS, LEDGER, described, null).blocks.find((b) => b.accountCode === '310-0020')!;
    expect(hlbb.pending.map((p) => p.description)).toEqual(['15 FOOTER NON LED TRUCK (1 WEEK)', 'Supplier payment']);
  });

  it("each bank: B/F + received − paid = Bank Balance; its own checked vouchers off it = available; its acquirers' card money added = available + in transit", () => {
    const board = computeDailyBank(DAY, BANKS, ACQUIRERS, LEDGER, PENDING, null);
    const hlbb = board.blocks.find((b) => b.accountCode === '310-0020')!;
    expect(hlbb).toMatchObject({ openingSen: 6_172_699, inSen: 285_000, outSen: 44_264, closingSen: 6_413_435 });
    expect(hlbb.pending.map((p) => [p.pvNumber, p.payee, p.description, p.amountSen])).toEqual([
      ['HPV-023', 'UNICOM', 'BILL IV2026-09-007', 1_083_600],
      ['HPV-030', 'UMOBILE', 'Supplier payment', 7_210],       // no note → the purpose in words
    ]);
    expect(hlbb.pendingSen).toBe(1_090_810);
    expect(hlbb.availableSen).toBe(6_413_435 - 1_090_810);
    expect(hlbb.transit.map((t) => t.acquirerCode)).toEqual(['PBB', 'GHL']);
    expect(hlbb.transitSen).toBe(3_750_352 + 4_220_064);
    expect(hlbb.availableWithTransitSen).toBe(6_413_435 - 1_090_810 + 3_750_352 + 4_220_064);
    const may = board.blocks.find((b) => b.accountCode === '310-0010')!;
    expect(may).toMatchObject({ closingSen: 100_000, pendingSen: 0, availableSen: 100_000, transitSen: 4_677_417, availableWithTransitSen: 4_777_417 });
    expect(may.transit.map((t) => t.acquirerCode)).toEqual(['MBB']);
  });

  it("the day's lines carry who and which document; the document falls back to the source's number, then the journal's", () => {
    const board = computeDailyBank(DAY, BANKS, ACQUIRERS, [
      ...LEDGER,
      L({ account_code: '310-0010', entry_date: DAY, je_no: 'JE-X', debit_sen: 100, source_doc_no: 'RCT-1' }),
      L({ account_code: '310-0010', entry_date: DAY, je_no: 'JE-Y', debit_sen: 100, source_doc_no: null }),
    ], PENDING, null);
    const hlbb = board.blocks.find((b) => b.accountCode === '310-0020')!;
    expect(hlbb.receipts[0]).toMatchObject({ party: 'Hookka', docNo: 'OR-0443', note: 'Settle invoice', amountSen: 285_000 });
    expect(hlbb.payouts[0]).toMatchObject({ party: 'Tan Yong Hong', docNo: 'PV-0432', amountSen: 44_264 });
    const may = board.blocks.find((b) => b.accountCode === '310-0010')!;
    expect(may.receipts.map((m) => [m.docNo, m.party])).toEqual([['RCT-1', null], ['JE-Y', null]]);
  });

  it('what names no bank on the board stays in its own list, still inside the totals', () => {
    const board = computeDailyBank(DAY, BANKS, ACQUIRERS, LEDGER, PENDING, null);
    expect(board.unassignedTransit.map((t) => [t.acquirerCode, t.balanceSen])).toEqual([['Untagged bank', 336_500]]);
    /* Cash in hand is not on this board's list, so its voucher waits in the bottom list. */
    expect(board.unassignedPending.map((p) => [p.pvNumber, p.accountCode])).toEqual([['HPV-040', '320-0000']]);
    expect(board.totalTransitSen).toBe(4_677_417 + 3_750_352 + 4_220_064 + 336_500);
    expect(board.pendingApprovalSen).toBe(1_083_600 + 7_210 + 5_000);
    expect(board.availableSen).toBe(board.totalClosingSen - board.pendingApprovalSen);
  });
});

/* The cash book — a second board beside the original (owner 2026-11-23: 先做一个
   daily bank的一开始直接，但不需要列实际差额。然后我每天会手动输入收到的金额; 付款就根据pv;
   then 原版的daily bank还是要保留哦，我这算是新的daily bank). It carries only the
   accounts whose start is on or before the day: start + receipts typed for it −
   approved vouchers paying out of it on their voucher date (bank charge included);
   pending only for those accounts; transit as before. The rest wait in
   notStarted. Without a cash book the board is the original, unchanged. */
describe('computeDailyBank — the cash book', () => {
  const BANKS = [
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK' },
    { account_code: '310-0020', account_name: 'CASH AT BANK - HLBB' },
  ];
  const ACQ = [
    { acquirerCode: 'MBB', account_code: '326-0020', account_name: 'CARD MACHINE CLEARING — MBB', bankAccountCode: '310-0010' },
    { acquirerCode: 'PBB', account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB', bankAccountCode: '310-0020' },
  ];
  const DAY = '2026-11-25';
  const LEDGER: GlLine[] = [
    L({ account_code: '310-0010', entry_date: '2026-09-30', debit_sen: 52_943_781 }),     // the ledger's Maybank, far from the bank's
    L({ account_code: '310-0010', entry_date: DAY, je_no: 'JE-L', debit_sen: 999 }),        // a ledger line today: not the cash book's
    L({ account_code: '310-0020', entry_date: '2026-11-01', credit_sen: 81_164_858 }),    // HLBB: no start
    L({ account_code: '326-0020', entry_date: '2026-11-20', debit_sen: 120_000 }),
    L({ account_code: '326-0010', entry_date: '2026-11-20', debit_sen: 70_000 }),
  ];
  const START = { account_code: '310-0010', start_date: '2026-11-24', balance_sen: 77_408_649 };
  const R = (over: Partial<CashbookReceipt>): CashbookReceipt => ({ id: 'r', account_code: '310-0010', receipt_date: DAY, amount_sen: 0, note: '', created_by: 'Chew', ...over });
  const V = (over: Partial<CashbookPayout>): CashbookPayout => ({
    id: 'v', pv_number: 'HPV-1', payee_name: 'PAYEE', notes: null, purpose: 'OTHER', credit_account_code: '310-0010',
    voucher_date: DAY, total_sen: 0, exchange_rate: 1, bank_charge_sen: 0, ...over,
  });
  const PENDING = [
    { id: 'p1', pv_number: 'HPV-9', payee_name: 'UMOBILE', credit_account_code: '310-0010', voucher_date: DAY, total_sen: 30_000, exchange_rate: 1 },
    { id: 'p2', pv_number: 'HPV-8', payee_name: 'PAYS FROM HLBB', credit_account_code: '310-0020', voucher_date: DAY, total_sen: 5_000, exchange_rate: 1 },
  ];

  it('B/F = start + receipts − approved vouchers before the day; the day adds its own; only its own banks, their pending and their transit count', () => {
    const board = computeDailyBank(DAY, BANKS, ACQ, LEDGER, PENDING, {
      starts: [START],
      receipts: [
        R({ id: 'r0', receipt_date: '2026-11-23', amount_sen: 50_000, note: 'before the start: already inside it' }),
        R({ id: 'r1', receipt_date: '2026-11-24', amount_sen: 300_000, note: 'Hookka deposit' }),
        R({ id: 'r2', receipt_date: DAY, amount_sen: 120_050, note: 'Cash sales showroom' }),
        R({ id: 'r3', receipt_date: '2026-11-26', amount_sen: 999_999, note: 'tomorrow' }),
      ],
      payouts: [
        V({ id: 'v0', pv_number: 'HPV-0', voucher_date: '2026-11-23', total_sen: 10_000 }),
        V({ id: 'v1', pv_number: 'HPV-1', voucher_date: '2026-11-24', total_sen: 40_000, bank_charge_sen: 100 }),
        V({ id: 'v2', pv_number: 'HPV-2', payee_name: 'UNICOM', notes: 'Truck rental', total_sen: 25_000, bank_charge_sen: 50 }),
        V({ id: 'v3', pv_number: 'HPV-3', voucher_date: '2026-11-26', total_sen: 1 }),
      ],
    });
    expect(board.book).toBe('cashbook');
    expect(board.blocks.map((b) => b.accountCode)).toEqual(['310-0010']);
    const may = board.blocks[0]!;
    expect(may.start).toEqual({ date: '2026-11-24', balanceSen: 77_408_649 });
    expect(may.openingSen).toBe(77_408_649 + 300_000 - 40_100);
    expect(may).toMatchObject({ inSen: 120_050, outSen: 25_050, closingSen: 77_408_649 + 300_000 - 40_100 + 120_050 - 25_050 });
    expect(may.receipts.map((m) => [m.sourceType, m.sourceDocNo, m.note, m.amountSen, m.typedBy])).toEqual([['TYPED', 'r2', 'Cash sales showroom', 120_050, 'Chew']]);
    expect(may.payouts.map((m) => [m.sourceType, m.docNo, m.party, m.note, m.amountSen])).toEqual([
      ['PV', 'HPV-2', 'UNICOM', 'Truck rental · incl. bank charge RM 0.50', 25_050],
    ]);
    expect(may.pendingSen).toBe(30_000);
    expect(may.availableSen).toBe(may.closingSen - 30_000);
    expect(may.availableWithTransitSen).toBe(may.availableSen + 120_000);
    /* HLBB is not on the cash book yet: no block, its pending voucher not counted here, its card money with no bank here. */
    expect(board.notStarted).toEqual([{ accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB', startDate: null }]);
    expect(board.pendingApprovalSen).toBe(30_000);
    expect(board.unassignedPending).toEqual([]);
    expect(board.unassignedTransit.map((t) => t.acquirerCode)).toEqual(['PBB']);
    expect(board.totalClosingSen).toBe(may.closingSen);
    expect(board.availableSen).toBe(may.closingSen - 30_000);
    expect(board.note).toMatch(/^The cash book/);
  });

  it('on the start day B/F is the start itself and the day lists its own money', () => {
    const board = computeDailyBank('2026-11-24', BANKS, ACQ, LEDGER, [], {
      starts: [START],
      receipts: [R({ id: 'r1', receipt_date: '2026-11-24', amount_sen: 300_000, note: 'Hookka deposit' })],
      payouts: [V({ id: 'v1', voucher_date: '2026-11-24', total_sen: 40_000 })],
    });
    expect(board.blocks[0]).toMatchObject({ accountCode: '310-0010', openingSen: 77_408_649, inSen: 300_000, outSen: 40_000, closingSen: 77_668_649 });
  });

  it('a day before its start, an account is not on the cash book yet — and says when it starts', () => {
    const board = computeDailyBank('2026-11-23', BANKS, ACQ, LEDGER, PENDING, { starts: [START], receipts: [], payouts: [] });
    expect(board.blocks).toEqual([]);
    expect(board.notStarted).toEqual([
      { accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK', startDate: '2026-11-24' },
      { accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB', startDate: null },
    ]);
    expect(board).toMatchObject({ totalClosingSen: 0, pendingApprovalSen: 0, availableSen: 0 });
  });

  it('an overdrawn account starts below zero', () => {
    const board = computeDailyBank(DAY, BANKS, ACQ, LEDGER, [], { starts: [{ ...START, balance_sen: -500_000 }], receipts: [], payouts: [] });
    expect(board.blocks[0]!.closingSen).toBe(-500_000);
  });

  it('a foreign voucher comes off in MYR the way posting converts it; its bank charge as keyed', () => {
    expect(voucherPayoutSen(V({ total_sen: 10_000, exchange_rate: 0.619838, bank_charge_sen: 800 }))).toBe(Math.round(10_000 * 0.619838) + 800);
    expect(voucherPayoutSen(V({ total_sen: 10_000, exchange_rate: 'garbage', bank_charge_sen: null }))).toBe(10_000);
  });

  it('without a cash book the board is the original: every account from the ledger, starts ignored', () => {
    const board = computeDailyBank(DAY, BANKS, ACQ, LEDGER, PENDING, null);
    expect(board).toMatchObject({ book: 'ledger', notStarted: [] });
    expect(board.blocks.map((b) => [b.accountCode, b.start, b.closingSen])).toEqual([
      ['310-0010', null, 52_943_781 + 999],
      ['310-0020', null, -81_164_858],
    ]);
    expect(board.pendingApprovalSen).toBe(35_000);
    expect(board.note).toMatch(/^Computed live from the ledger/);
  });
});
