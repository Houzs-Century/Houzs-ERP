/* An other debtor's own data on its way into the form and back, and the account
   code the form suggests (owner 2026-11-03: AutoCount style, 305-A001): the same
   rule the migration's fill used, so a new debtor continues the numbers. */

import { describe, expect, test } from 'vitest';
import { debtorPartyBody, debtorPartyFrom, emptyDebtorParty, suggestDebtorCode } from './debtor-party';

describe('the suggested account code', () => {
  test('the control’s number, the name’s first letter, the first number when nobody has that letter', () => {
    expect(suggestDebtorCode('AKEMI (M) SDN. BHD.', '305-0000', [])).toBe('305-A001');
  });

  test('the next number after the highest taken, not a count: a gap is not filled', () => {
    expect(suggestDebtorCode('Apex', '305-0000', ['305-A001', '305-A007', '305-B001'])).toBe('305-A008');
  });

  test('a name that starts with a digit takes the digit, as AutoCount numbers 2990 HOME', () => {
    expect(suggestDebtorCode('2990 Home Sdn Bhd', '305-0000', [])).toBe('305-2001');
  });

  test('marks and spaces before the first letter do not count', () => {
    expect(suggestDebtorCode('  (m) Holdings', '305-0000', [])).toBe('305-M001');
  });

  test('a name with no letter or digit, or no name yet, suggests nothing', () => {
    expect(suggestDebtorCode('陈先生', '305-0000', [])).toBe('');
    expect(suggestDebtorCode('   ', '305-0000', [])).toBe('');
  });

  test('the prefix is the company’s own control', () => {
    expect(suggestDebtorCode('Alpha', '306-0000', ['305-A001'])).toBe('306-A001');
  });

  test('a hand-typed code that does not fit the shape is ignored; a blank too', () => {
    expect(suggestDebtorCode('Alpha', '305-0000', ['305-ABC', 'A999', '', null, undefined, '305-A1'])).toBe('305-A001');
  });

  test('past 999 the number just grows', () => {
    expect(suggestDebtorCode('Zeta', '305-0000', ['305-Z999'])).toBe('305-Z1000');
  });

  test('a stored code in any case counts', () => {
    expect(suggestDebtorCode('Alpha', '305-0000', ['305-a004'])).toBe('305-A005');
  });
});

describe('the code in the form’s values', () => {
  test('a fresh form has none; a stored debtor’s comes in; the body sends it trimmed', () => {
    expect(emptyDebtorParty().code).toBe('');
    expect(debtorPartyFrom({ name: 'AHMAD', phone: null, notes: null, code: '305-A001' }).code).toBe('305-A001');
    expect(debtorPartyFrom({ name: 'AHMAD', phone: null, notes: null, code: null }).code).toBe('');
    expect(debtorPartyBody({ ...emptyDebtorParty(), code: ' 305-A001 ' }).code).toBe('305-A001');
  });
});
