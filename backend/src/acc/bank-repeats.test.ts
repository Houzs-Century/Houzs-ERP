/* The same bank movement on a second file (owner 2026-10-14: B，做). Pinned on
   the prints 2990's Hong Leong September actually carried: the month-end CSV
   adds "at KLM" / "at DIO" / "at PNT" to the description and a DuitNow id to a
   transfer's reference, and reorders the reference's words; the any-day export
   says less. Plus the guards: the day and the amount must agree, the words must
   agree one way or the other, a one-word print pairs only on equal words, one
   earlier print answers one movement, an exact pair beats a containment one,
   and a line already filed as a repeat is a copy, never an earlier print. */

import { describe, expect, test } from 'vitest';
import { pairRepeats, repeatsAmong, samePrint, type EarlierPrint, type LineForRepeats, type PrintedMovement } from './bank-repeats';
import { movementWords } from './bank-parse';

const anyDay = (bookedOn: string, amountSen: number, description: string, reference: string | null, where = 'JE-1'): EarlierPrint =>
  ({ bookedOn, amountSen, description, reference, where });
const monthEnd = (bookedOn: string, amountSen: number, description: string, reference: string | null): PrintedMovement =>
  ({ bookedOn, amountSen, description, reference });

describe('the month-end statement repeats the any-day export', () => {
  test('a card payout, a transfer out, a customer transfer in and a cash deposit — each the same movement', () => {
    const earlier = [
      anyDay('2026-09-01', 705426, 'Cr Adv-Interbank GIRO', 'DMS A3 (FOR GHL) 161320P226260901 /GHL/6600030486', '2990-JE-2609-0336'),
      anyDay('2026-09-02', -500000, 'CIB Instant Transfer', 'LOO WEN WEI Claim', '2990-HPV-2609-001'),
      anyDay('2026-09-27', 168300, 'Instant Transfer', 'LIM SOOK TENG Tea Chen Wai', 'Transaction_Statement_20260901_20260928.csv (still open there)'),
      anyDay('2026-09-04', 171000, 'CDM Deposit', null, '2990-JE-2609-0050'),
    ];
    const incoming = [
      monthEnd('2026-09-01', 705426, 'Cr Adv-Interbank GIRO at KLM', '161320P226260901 /GHL/6600030486 DMS A3 (FOR GHL)'),
      monthEnd('2026-09-02', -500000, 'CIB Instant Transfer at DIO', 'Claim LOO WEN WEI 20260902HLBBMYKL010OCB90268183'),
      monthEnd('2026-09-27', 168300, 'Instant Transfer at KLM', 'Tea Chen Wai LIM SOOK TENG 20260927PBBEMYKL010ORM15275558'),
      monthEnd('2026-09-04', 171000, 'CDM Deposit at PNT', null),
    ];
    expect(pairRepeats(earlier, incoming)).toEqual([
      '2990-JE-2609-0336', '2990-HPV-2609-001', 'Transaction_Statement_20260901_20260928.csv (still open there)', '2990-JE-2609-0050',
    ]);
    /* And the other way round: the any-day export after the month-end file. */
    const back = pairRepeats(incoming.map((m) => ({ ...m, where: 'monthly' })), earlier);
    expect(back).toEqual(['monthly', 'monthly', 'monthly', 'monthly']);
  });

  test('another day, another amount, or a payee the earlier print never named is a movement of its own', () => {
    const earlier = [anyDay('2026-09-06', 11000, 'Instant Transfer', 'YUEN KAH MUN Grab n Win Voucher Refund - Carmen Yuen')];
    expect(pairRepeats(earlier, [
      monthEnd('2026-09-07', 11000, 'Instant Transfer at KLM', 'Grab n Win Voucher Refund - Carmen Yuen YUEN KAH MUN 2026'),
      monthEnd('2026-09-06', 11001, 'Instant Transfer at KLM', 'Grab n Win Voucher Refund - Carmen Yuen YUEN KAH MUN 2026'),
      monthEnd('2026-09-06', 11000, 'Instant Transfer at KLM', 'AHMAD BIN ALI 20260906MBBEMYKL010ORM1'),
    ])).toEqual([null, null, null]);
  });

  test('a one-word print pairs only on equal words', () => {
    const one = movementWords({ description: 'Interest', reference: null });
    expect(samePrint(one, movementWords({ description: 'Interest at KLM', reference: null }))).toBe(false);
    expect(samePrint(one, movementWords({ description: 'INTEREST', reference: null }))).toBe(true);
    expect(samePrint(movementWords({ description: 'CDM Deposit', reference: null }), movementWords({ description: 'CDM Deposit at PNT', reference: null }))).toBe(true);
  });

  test('one earlier print answers one movement; an exact pair is taken before a containment one', () => {
    /* Two deposits of RM 100 on the month-end file, one on the export: one repeat, one new. */
    expect(pairRepeats([anyDay('2026-09-04', 10000, 'CDM Deposit', null)], [
      monthEnd('2026-09-04', 10000, 'CDM Deposit at PNT', null), monthEnd('2026-09-04', 10000, 'CDM Deposit at PNT', null),
    ])).toEqual(['JE-1', null]);
    /* The export holds "Fund transfer" and "Fund transfer RACHEL NG"; the month-end
       print of the second pairs with the second, leaving the first for its own twin. */
    const earlier = [anyDay('2026-08-03', 143300, 'Fund transfer', null, 'A'), anyDay('2026-08-03', 143300, 'Fund transfer', 'RACHEL NG', 'B')];
    expect(pairRepeats(earlier, [monthEnd('2026-08-03', 143300, 'Fund transfer', 'RACHEL NG')])).toEqual(['B']);
  });
});

describe('repeatsAmong — the rule over files already in', () => {
  const line = (id: number, statementId: number, over: Partial<LineForRepeats>): LineForRepeats => ({
    id, statementId, lineNo: id, bookedOn: '2026-09-01', amountSen: 705426, description: 'Cr Adv-Interbank GIRO',
    reference: 'DMS A3 (FOR GHL) 161320P226260901 /GHL/6600030486', state: 'OPEN', kind: 'OTHER', where: `line ${id}`, ...over,
  });
  const KLM = { description: 'Cr Adv-Interbank GIRO at KLM', reference: '161320P226260901 /GHL/6600030486 DMS A3 (FOR GHL)' };

  test('an OPEN line on a later file repeating an earlier file\'s movement; the earlier file\'s own lines never', () => {
    const found = repeatsAmong([
      line(1, 13, { state: 'POSTED', where: '2990-JE-2609-0336' }),
      line(2, 14, { ...KLM }),
      line(3, 14, { bookedOn: '2026-09-30', amountSen: -2500, description: 'SERVICE CHARGE', reference: null }),
    ]);
    expect([...found.entries()]).toEqual([[2, '2990-JE-2609-0336']]);
  });

  test('a repeat is a copy: a third file pairs with the original, and its second twin stays new', () => {
    const found = repeatsAmong([
      line(1, 13, { state: 'POSTED', where: 'JE-A' }),
      line(2, 14, { ...KLM }),
      line(3, 15, { ...KLM }),
      line(4, 15, { ...KLM }),
    ]);
    expect([...found.entries()]).toEqual([[2, 'JE-A'], [3, 'JE-A']]);
  });

  test('a line already filed as a repeat is neither asked again nor an earlier print; a decided line is not asked', () => {
    const found = repeatsAmong([
      line(1, 13, { state: 'POSTED', where: 'JE-A' }),
      line(2, 14, { ...KLM, state: 'IGNORED', kind: 'DUPLICATE' }),
      line(3, 15, { ...KLM, state: 'POSTED', where: 'JE-B' }),
      line(4, 16, { ...KLM }),
    ]);
    /* Line 3, decided, is not asked; line 4 pairs with it — the same words beat
       line 1's containment — and line 2, a copy, is never offered. */
    expect([...found.entries()]).toEqual([[4, 'JE-B']]);
  });
});
