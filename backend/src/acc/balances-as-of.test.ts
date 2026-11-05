/* The Trial balance as at a day (batch 6 read c1): the all-time balances less
   the lines the books count dated after the day — a reversal pair taken back
   by neither side, an asset or an expense still reading debit less credit,
   the rest credit less debit, an account with nothing later left as it was. */
import { describe, expect, test } from 'vitest';
import { balancesAsOf, type AccountBalanceRow } from './balances-as-of';

const row = (code: string, type: string, dr: number, cr: number, balance: number): AccountBalanceRow =>
  ({ account_code: code, account_name: code, account_type: type, total_debit_sen: dr, total_credit_sen: cr, balance_sen: balance, company_id: 2 });

describe('balancesAsOf', () => {
  const allTime = [
    row('310-0010', 'ASSET', 900_000, 300_000, 600_000),
    row('500-0000', 'INCOME', 0, 700_000, 700_000),
    row('900-A001', 'EXPENSE', 50_000, 0, 50_000),
  ];

  test('takes the later lines back off, each side on its own, and re-reads the balance by the account’s nature', () => {
    const out = balancesAsOf(allTime, [
      { account_code: '310-0010', debit_sen: 100_000, credit_sen: 0, reversed: false, reversed_by_je: null },
      { account_code: '310-0010', debit_sen: 0, credit_sen: 20_000, reversed: false, reversed_by_je: null },
      { account_code: '500-0000', debit_sen: 0, credit_sen: 100_000, reversed: false, reversed_by_je: null },
    ]);
    expect(out[0]).toMatchObject({ total_debit_sen: 800_000, total_credit_sen: 280_000, balance_sen: 520_000 });
    expect(out[1]).toMatchObject({ total_debit_sen: 0, total_credit_sen: 600_000, balance_sen: 600_000 });
    /* Nothing later: the account is the very row it was. */
    expect(out[2]).toBe(allTime[2]);
  });

  test('a reversal pair moved nothing in the books, so neither side is taken back', () => {
    const out = balancesAsOf(allTime, [
      { account_code: '310-0010', debit_sen: 100_000, credit_sen: 0, reversed: true, reversed_by_je: 'JE-9' },
      { account_code: '310-0010', debit_sen: 0, credit_sen: 100_000, reversed: false, reversed_by_je: 'JE-8' },
    ]);
    expect(out[0]).toBe(allTime[0]);
  });

  test('nothing after the day reads exactly as the all-time balances', () => {
    expect(balancesAsOf(allTime, [])).toEqual(allTime);
  });
});
