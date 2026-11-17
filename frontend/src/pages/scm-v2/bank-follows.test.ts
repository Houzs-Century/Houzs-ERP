import { describe, expect, test } from 'vitest';
import { bankFollowsText } from './bank-follows';

/* Owner 2026-11-17: 我只要对一边 — a confirm on Merchant Recon says what the bank side did. */
describe('the bank side of a merchant confirm, in a line', () => {
  test('a credit that matched itself is named with its entries', () => {
    expect(bankFollowsText({ matched: 1, jeNos: ['2990-JE-2611-0430'], left: [] }))
      .toBe("The bank's credit for it matched itself (2990-JE-2611-0430).");
  });

  test('one left for a person says why; nothing to say is nothing', () => {
    expect(bankFollowsText({ matched: 0, jeNos: [], left: ['line 3 (RM 615.00): its month is closed'] }))
      .toBe('Left for you on the bank screen: line 3 (RM 615.00): its month is closed.');
    expect(bankFollowsText({ matched: 0, jeNos: [], left: [] })).toBeNull();
    expect(bankFollowsText(undefined)).toBeNull();
  });

  test('a bank side that could not be read says so, and where to go instead', () => {
    expect(bankFollowsText({ error: 'timeout' })).toMatch(/could not be checked \(timeout\).*bank screen/);
  });
});
