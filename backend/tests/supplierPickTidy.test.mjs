/* The supplier terms / bank tidy (owner 2026-11-24: 「改，连旧资料一起整理」).
   Pinned: the typed values found on production 2026-11-24 go to the list's
   entries ("30 DAYS" ×7, "30 Days", "30 days", "30 terms" → NET 30, "60 DAYS"
   → NET 60, a phone number cleared; "HLBB", "HONG LEONG BANK BERHAD", "PUBLIC
   BANK BERHAD" → the bank, upper case as stored); what is already right, and
   what no rule knows, is left alone; every value a tidy writes is on the list;
   a phone number is never printed. Codes made up. */
import { describe, expect, it } from 'vitest';
import {
  bankIsOnList, planFor, shown, storedBank, termIsOnList, tidyBank, tidyTerm,
} from '../scripts/lib/supplier-pick-tidy.mjs';
import { MALAYSIAN_BANKS, PAYMENT_TERMS } from '../src/scm/shared/pick-lists.ts';

describe('payment terms', () => {
  it('the typed days found on production become the NET term the list has', () => {
    for (const t of ['30 DAYS', '30 Days', '30 days', '30 terms', '30 day', 'NET30', 'Net 30 days', 'NET 30 ']) expect(tidyTerm(t)?.to, t).toBe('NET 30');
    expect(tidyTerm('60 DAYS')).toEqual({ to: 'NET 60', why: '60 days' });
    expect(tidyTerm('net 45')?.to).toBe('NET 45');
    expect(tidyTerm('C.O.D.')?.to).toBe('COD');
    expect(tidyTerm('advance payment')?.to).toBe('Advance Payment');
  });

  it('a phone number typed as a term is cleared', () => {
    expect(tidyTerm('+6052013576')).toEqual({ to: null, why: 'a phone number, not a term' });
    expect(tidyTerm('012-345 6789')?.to).toBeNull();
  });

  it('leaves a blank, a list term, and anything no rule knows', () => {
    for (const t of [null, undefined, '', '  ', ...PAYMENT_TERMS]) expect(tidyTerm(t), String(t)).toBeNull();
    for (const t of ['21 days', '30', 'NET 45 with 2% early discount', 'EOM']) expect(tidyTerm(t), t).toBeNull();
  });
});

describe('banks', () => {
  it('the short name and the company name found on production become the bank, stored upper case', () => {
    expect(tidyBank('HLBB')).toEqual({ to: 'HONG LEONG BANK', why: 'its short name' });
    expect(tidyBank('HONG LEONG BANK BERHAD')).toEqual({ to: 'HONG LEONG BANK', why: 'its company name ("Berhad")' });
    expect(tidyBank('PUBLIC BANK BERHAD')?.to).toBe('PUBLIC BANK');
    expect(tidyBank('MALAYAN BANKING BERHAD')?.to).toBe('MAYBANK');
    expect(tidyBank('OCBC BANK (MALAYSIA) BERHAD')?.to).toBe('OCBC BANK');
    expect(tidyBank('HONG  LEONG BANK')?.to).toBe('HONG LEONG BANK');
  });

  it('leaves a blank, a bank already as stored, and a bank abroad', () => {
    for (const b of [null, '', ...MALAYSIAN_BANKS.map(storedBank)]) expect(tidyBank(b), String(b)).toBeNull();
    for (const b of ['BANK OF CHINA', 'INDUSTRIAL AND COMMERCIAL BANK OF CHINA', 'DBS BANK']) expect(tidyBank(b), b).toBeNull();
  });
});

describe('the plan', () => {
  const rows = [
    { id: 'a', code: '400-X001', payment_terms: '30 DAYS', bank_name: null },
    { id: 'b', code: '400-X002', payment_terms: '+6052013576', bank_name: 'HLBB' },
    { id: 'c', code: '405-X003', payment_terms: null, bank_name: 'PUBLIC BANK' },
    { id: 'd', code: '405-X004', payment_terms: '21 days', bank_name: 'BANK OF CHINA' },
    { id: 'e', code: '400-X005', payment_terms: 'NET 30', bank_name: 'HONG LEONG BANK BERHAD' },
  ];

  it('lists each change with its company and reason, and names what it leaves as typed', () => {
    const { changes, leftAsTyped } = planFor(2, rows);
    expect(changes.map((c) => [c.companyId, c.code, c.field, c.from, c.to])).toEqual([
      [2, '400-X001', 'payment_terms', '30 DAYS', 'NET 30'],
      [2, '400-X002', 'payment_terms', '+6052013576', null],
      [2, '400-X002', 'bank_name', 'HLBB', 'HONG LEONG BANK'],
      [2, '400-X005', 'bank_name', 'HONG LEONG BANK BERHAD', 'HONG LEONG BANK'],
    ]);
    expect(leftAsTyped.map((l) => [l.code, l.field, l.value])).toEqual([
      ['405-X004', 'payment_terms', '21 days'],
      ['405-X004', 'bank_name', 'BANK OF CHINA'],
    ]);
  });

  it('every value it writes is on the list (or cleared), so a second run changes nothing', () => {
    const { changes } = planFor(1, rows);
    for (const c of changes) {
      if (c.to === null) continue;
      expect(c.field === 'payment_terms' ? termIsOnList(c.to) : bankIsOnList(c.to), `${c.code} ${c.field}`).toBe(true);
    }
    const after = rows.map((r) => {
      const next = { ...r };
      for (const c of changes.filter((x) => x.id === r.id)) next[c.field] = c.to;
      return next;
    });
    expect(planFor(1, after).changes).toEqual([]);
  });
});

describe('the public log', () => {
  it('never prints a phone number', () => {
    expect(shown('+6052013576')).toBe('(a phone number)');
    expect(shown('30 DAYS')).toBe('"30 DAYS"');
    expect(shown(null)).toBe('(blank)');
  });
});
