/* The Payment vouchers list's Total (owner 2026-11-09: 「表格最下面的总数（Total）-
   payment voucher 可以加」). Pinned: the ringgit of the vouchers showing — a voucher in
   another currency at its own rate, the conversion posting and Money today use — a
   cancelled voucher listed but not counted, and the footer's words saying both. */

import { describe, expect, test } from 'vitest';
import { pvListTotal, pvListTotalNote, ringgitSenOfPv } from './pv-list-total';

describe('the Payment vouchers total', () => {
  test('a voucher pays its own amount at its own rate; a rate that cannot be read counts as one', () => {
    expect(ringgitSenOfPv({ currency: 'MYR', total_sen: 32_050, exchange_rate: 1 })).toBe(32_050);
    expect(ringgitSenOfPv({ currency: 'RMB', total_sen: 100_000, exchange_rate: 0.65 })).toBe(65_000);
    expect(ringgitSenOfPv({ currency: 'USD', total_sen: 10_000, exchange_rate: '4.4725' })).toBe(44_725);
    expect(ringgitSenOfPv({ currency: 'MYR', total_sen: 5_000, exchange_rate: null })).toBe(5_000);
    expect(ringgitSenOfPv({ currency: 'MYR', total_sen: 5_000, exchange_rate: 0 })).toBe(5_000);
  });

  test('a cancelled voucher is listed but not counted; a foreign one is counted at its rate', () => {
    expect(pvListTotal([
      { status: 'DRAFT', currency: 'MYR', total_sen: 10_000, exchange_rate: 1 },
      { status: 'POSTED', currency: 'RMB', total_sen: 100_000, exchange_rate: 0.65 },
      { status: 'CANCELLED', currency: 'MYR', total_sen: 99_999, exchange_rate: 1 },
    ])).toEqual({ sen: 75_000, cancelled: 1, foreign: 1 });
    expect(pvListTotal([])).toEqual({ sen: 0, cancelled: 0, foreign: 0 });
  });

  test('the footer says what the total leaves out and what it converts, and nothing when neither', () => {
    expect(pvListTotalNote({ cancelled: 0, foreign: 0 })).toBe('');
    expect(pvListTotalNote({ cancelled: 2, foreign: 0 })).toBe('2 cancelled not counted');
    expect(pvListTotalNote({ cancelled: 0, foreign: 1 })).toBe('Foreign at its own rate');
    expect(pvListTotalNote({ cancelled: 1, foreign: 3 })).toBe('1 cancelled not counted · foreign at its own rate');
  });
});
