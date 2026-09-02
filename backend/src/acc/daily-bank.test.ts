// The Daily Bank board's arithmetic. The decisions pinned: opening is strictly
// BEFORE the date, the day's movements split into receipts and payouts, lines
// after the date never bleed backwards, transit is an as-of balance shown but
// not counted as movable, and available = money closing minus pending.

import { describe, it, expect } from 'vitest';
import { computeDailyBank, type GlLine } from './daily-bank';

const MONEY = [
  { account_code: '330-0000', account_name: 'Bank — Maybank Current' },
  { account_code: '335-0000', account_name: 'Cash on Hand' },
];
const TRANSIT = [
  { acquirerCode: 'MBB', account_code: '320-0000', account_name: 'Card Machine Clearing (EDC)' },
];

const L = (over: Partial<GlLine>): GlLine => ({
  entry_date: '2026-08-16',
  je_no: 'JE-2608-0001',
  source_type: 'SOPAY',
  source_doc_no: 'pay-1',
  account_code: '330-0000',
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
    ]);
    const bank = board.blocks[0];
    expect(bank).toMatchObject({ openingSen: 100000, inSen: 50000, outSen: 20000, closingSen: 130000 });
    expect(bank.receipts).toHaveLength(1);
    expect(bank.receipts[0]).toMatchObject({ jeNo: 'JE-A', amountSen: 50000 });
    expect(bank.payouts[0]).toMatchObject({ jeNo: 'JE-B', amountSen: 20000, sourceType: 'PV' });
  });

  it('transit is an as-of balance (≤ date) and is NOT part of available', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [
      L({ account_code: '320-0000', entry_date: '2026-08-14', debit_sen: 70000 }),
      L({ account_code: '320-0000', entry_date: '2026-08-16', debit_sen: 30000 }),
      L({ account_code: '330-0000', entry_date: '2026-08-16', debit_sen: 10000 }),
    ]);
    expect(board.transit[0].balanceSen).toBe(100000);
    expect(board.totalTransitSen).toBe(100000);
    expect(board.availableSen).toBe(10000); // bank only — swiped money cannot be spent yet
  });

  it('an account with no lines still renders as a zero block — absence is a value, not a crash', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, []);
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
    ]);
    expect(board.pendingApprovalSen).toBe(30000 + Math.round(10000 * 0.619838));
    expect(board.availableSen).toBe(100000 - board.pendingApprovalSen);
  });

  it('phase 3: a garbage rate falls back to 1, never to zero pending', () => {
    const board = computeDailyBank('2026-08-16', MONEY, TRANSIT, [], [
      { total_sen: 5000, exchange_rate: null },
      { total_sen: 5000, exchange_rate: 'not-a-number' },
    ]);
    expect(board.pendingApprovalSen).toBe(10000);
  });
});
