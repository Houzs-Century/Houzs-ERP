/* The AP split (owner 2026-09-03): 405-x supplier codes are AutoCount's
   OTHER CREDITORS. apControlRole is the ONE home of the prefix rule; piLines
   books the bill's credit onto whichever control the supplier belongs to.
   The blast radius he approved: supplier list and screens unchanged, only
   the GL landing follows the code. */

import { describe, expect, test } from 'vitest';
import { DEFAULT_ROLE_CODES, apControlRole, piLines } from './rules';

describe('apControlRole — one home for the 405 prefix', () => {
  test('405-x goes to AP_OTHER, everything else (and nothing) to AP', () => {
    expect(apControlRole('405-Z002')).toBe('AP_OTHER');
    expect(apControlRole('405-0000')).toBe('AP_OTHER');
    expect(apControlRole('400-T005')).toBe('AP');
    expect(apControlRole('4050')).toBe('AP');       // no dash — not the series
    expect(apControlRole(null)).toBe('AP');
    expect(apControlRole(undefined)).toBe('AP');
    expect(apControlRole('')).toBe('AP');
  });
});

describe('piLines — one debit per group, the credit on the supplier\'s own control', () => {
  const pi = { invoice_number: '2990-PI-2608-018' };
  const ONE_GROUP = [{ groupCode: 'ACCESSORY', accountCode: '601-0004', myrSen: 1_644_000 }];

  test('a 405 supplier credits AP_OTHER (405-0000)', () => {
    const lines = piLines(DEFAULT_ROLE_CODES, pi, { code: '405-Z002', name: 'ZHEJIANG JU MIAO' }, ONE_GROUP);
    const credit = lines.find((l) => l.creditSen > 0)!;
    expect(credit.accountCode).toBe('405-0000');
    expect(credit.creditSen).toBe(1_644_000);
    expect(credit.partyCode).toBe('405-Z002');
  });

  test('a mixed invoice debits each group\'s OWN purchase account, and the credit is their sum — inventory is not touched', () => {
    const lines = piLines(DEFAULT_ROLE_CODES, pi, { code: '400-T005', name: 'TODERN HOME' }, [
      { groupCode: 'SOFA', accountCode: '601-0003', myrSen: 155_000 },
      { groupCode: 'MATTRESS', accountCode: '601-0001', myrSen: 100_000 },
    ]);
    const debits = lines.filter((l) => l.debitSen > 0);
    expect(debits.map((l) => [l.accountCode, l.debitSen])).toEqual([
      ['601-0003', 155_000],
      ['601-0001', 100_000],
    ]);
    const credit = lines.find((l) => l.creditSen > 0)!;
    expect(credit.accountCode).toBe('400-0000');
    expect(credit.creditSen).toBe(255_000);
    expect(lines.some((l) => l.accountCode === '330-0000')).toBe(false);
  });

  test('a supplier with NO code stays on AP — fail toward the trade control, never a throw', () => {
    const lines = piLines(DEFAULT_ROLE_CODES, pi, { code: null, name: null }, [
      { groupCode: 'SOFA', accountCode: '601-0003', myrSen: 100 },
    ]);
    expect(lines.find((l) => l.creditSen > 0)!.accountCode).toBe('400-0000');
  });
});
