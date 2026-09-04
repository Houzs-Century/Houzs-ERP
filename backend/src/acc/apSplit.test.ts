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

describe('piLines — the credit lands on the supplier\'s own control', () => {
  const pi = { invoice_number: '2990-PI-2608-018' };

  test('a 405 supplier credits AP_OTHER (405-0000)', () => {
    const lines = piLines(DEFAULT_ROLE_CODES, pi, { code: '405-Z002', name: 'ZHEJIANG JU MIAO' }, 1_644_000);
    const credit = lines.find((l) => l.creditSen > 0)!;
    expect(credit.accountCode).toBe('405-0000');
    expect(credit.creditSen).toBe(1_644_000);
    expect(credit.partyCode).toBe('405-Z002');
  });

  test('a trade supplier still credits AP (400-0000), balanced against inventory', () => {
    const lines = piLines(DEFAULT_ROLE_CODES, pi, { code: '400-T005', name: 'TODERN HOME' }, 255_000);
    const credit = lines.find((l) => l.creditSen > 0)!;
    expect(credit.accountCode).toBe('400-0000');
    const debit = lines.find((l) => l.debitSen > 0)!;
    expect(debit.accountCode).toBe('330-0000');
    expect(debit.debitSen).toBe(credit.creditSen);
  });

  test('a supplier with NO code stays on AP — fail toward the trade control, never a throw', () => {
    const lines = piLines(DEFAULT_ROLE_CODES, pi, { code: null, name: null }, 100 );
    expect(lines.find((l) => l.creditSen > 0)!.accountCode).toBe('400-0000');
  });
});
