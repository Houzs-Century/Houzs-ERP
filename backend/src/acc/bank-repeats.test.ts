/* The same bank movement on a second file (owner 2026-10-14: B，做). Pinned on
   the prints 2990's Hong Leong September actually carried: the month-end CSV
   adds "at KLM" / "at DIO" / "at PNT" to the description and a DuitNow id to a
   transfer's reference, and reorders the reference's words; the any-day export
   says less. Plus the guards: the day and the amount must agree, the words must
   agree one way or the other, a one-word print pairs only on equal words, one
   earlier print answers one movement, an exact pair beats a containment one,
   and a line already filed as a repeat is a copy, never an earlier print. */

import { describe, expect, test } from 'vitest';
import { pairRepeats, printMarks, repeatsAmong, samePrint, type EarlierPrint, type LineForRepeats, type PrintedMovement } from './bank-repeats';
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

/* 2990's Hong Leong October (owner 2026-11-10: 「已经match 的就不需要去理会」). The
   month-end CSV cut a description short ("…via Intern"), reordered the reference,
   and the reader's joining of a lone letter onto the word before it ("Internet (B)"
   → "internetb", "BHD. I-2608" → "bhdi") left neither print's words inside the
   other's. Three movements already matched on the any-day export came in again as
   still to decide and broke the month's tally by RM 9,095.10. Each pair carries
   the same transaction number, document number or biller account — a mark only
   that movement prints. These are the prints as stored. */
describe('the month-end print words a movement differently — a mark both prints carry makes it one', () => {
  const earlier = [
    anyDay('2026-10-02', -7210, 'JomPAY Bill Payment', 'U MOBILE SDN BHD 30515721824 DA203JNP22610021822Y', '2990-JE-2609-0379'),
    anyDay('2026-10-02', -70000, 'Fund Trf fr CA to CA-Internet(B)', 'THE CONTS SDN. BHD. I-2608-063 2990-Draft-2609-030', '2990-JE-2609-0377'),
    anyDay('2026-10-12', -832300, 'Fund Trf from CA to SA via Internet (B)', 'CHOW WAI MAN TNB DEPOSIT n PRINT 2990-HPV-2610-013', '2990-JE-2610-0204'),
  ];
  const incoming = [
    monthEnd('2026-10-02', -7210, 'JomPAY Bill Payment at DIO', '30515721824 DA203JNP22610021822Y U MOBILE SDN BHD CIBJOM29092026039886'),
    monthEnd('2026-10-02', -70000, 'Fund Trf fr CA to CA-Internet(B)', 'I-2608-063 2990-Draft-2609-030 THE CONTS SDN. BHD.'),
    monthEnd('2026-10-12', -832300, 'Fund Trf from CA to SA via Intern', 'TNB DEPOSIT n PRINT 2990-HPV-2610-013 CHOW WAI MAN'),
  ];

  test('the words alone miss all three', () => {
    incoming.forEach((m, i) => expect(samePrint(movementWords(earlier[i]!), movementWords(m))).toBe(false));
  });

  test('the shared mark pairs each with the movement it repeats', () => {
    expect(pairRepeats(earlier, incoming)).toEqual(['2990-JE-2609-0379', '2990-JE-2609-0377', '2990-JE-2610-0204']);
  });

  test("the next month's bill to the same biller account is a movement of its own", () => {
    expect(pairRepeats(earlier, [
      monthEnd('2026-10-27', -7210, 'JomPAY Bill Payment at DIO', '30515721824 DASMRCEV22610271127Y U MOBILE SDN BHD CIBJOM16102026050909'),
    ])).toEqual([null]);
  });

  test('two bills of one amount on one day: the one carrying the same transaction number takes the earlier print', () => {
    const another = monthEnd('2026-10-02', -7210, 'JomPAY Bill Payment at DIO', '30515721824 DA999XYZ22610021999Y U MOBILE SDN BHD CIBJOM29092026999999');
    expect(pairRepeats([earlier[0]!], [another, incoming[0]!])).toEqual([null, '2990-JE-2609-0379']);
  });

  test('a day in the reference is no mark: two merchants paid the same amount the same day are two movements', () => {
    expect(pairRepeats(
      [anyDay('2026-10-26', 168300, 'CA Credit Advice', '00005992235 MERCHANT 20261024', 'JE-X')],
      [monthEnd('2026-10-26', 168300, 'CA Credit Advice', '00005992284 MERCHANT 20261024')],
    )).toEqual([null]);
  });

  test('words still come first: an exact pair is never taken by a mark', () => {
    /* Two prints of the same day and amount sharing the biller account; the
       month-end copy of the second says exactly what the second said. */
    const a = anyDay('2026-10-02', -7210, 'JomPAY Bill Payment', 'U MOBILE SDN BHD 30515721824 DA203JNP22610021822Y', 'A');
    const b = anyDay('2026-10-02', -7210, 'JomPAY Bill Payment', 'U MOBILE SDN BHD 30515721824 DA111AAA22610021111Y', 'B');
    expect(pairRepeats([a, b], [
      monthEnd('2026-10-02', -7210, 'JomPAY Bill Payment', 'U MOBILE SDN BHD 30515721824 DA111AAA22610021111Y'),
      incoming[0]!,
    ])).toEqual(['B', 'A']);
  });
});

describe('printMarks — what only one movement prints', () => {
  test('a long number, a code of letters and digits, a document number', () => {
    expect([...printMarks({ description: 'JomPAY Bill Payment', reference: 'U MOBILE SDN BHD 30515721824 DA203JNP22610021822Y' })].sort())
      .toEqual(['30515721824', 'DA203JNP22610021822Y']);
    expect([...printMarks({ description: 'Fund Trf fr CA to CA-Internet(B)', reference: 'THE CONTS SDN. BHD. I-2608-063 2990-Draft-2609-030' })].sort())
      .toEqual(['2990-DRAFT-2609-030', 'I-2608-063']);
  });

  test('never a day, a short number, a hyphenated word or a run of short numbers', () => {
    expect([...printMarks({ description: 'CA Credit Advice', reference: '00005992284 MERCHANT 20261024' })]).toEqual(['00005992284']);
    expect([...printMarks({ description: 'Fund Trf fr CA to CA-Internet(B)', reference: '10-0015 0017 0026 HOUZS VENTURE' })]).toEqual([]);
    expect([...printMarks({ description: 'CDM Deposit at PNT', reference: null })]).toEqual([]);
  });
});
