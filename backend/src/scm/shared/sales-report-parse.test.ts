// The daily sales report as the floor actually types it, read into bills and
// day totals. Pinned so the chat and the server read the same lines the same
// way, and so a phone-typed variation keeps parsing.
import { describe, expect, test } from 'vitest';
import {
  extractRefTokens,
  looksLikeSalesReport,
  normalizeRefToken,
  parseSalesReport,
  reportDateFor,
  summaryTotalOf,
} from './sales-report-parse';

const REPORT = `11/10 Akemi @ SUNWAY KLUANG MALL

1. HC8993 RM6500 Jason
2. HC10785 RM4999 Melvin

Total - RM 11,499`;

describe('parseSalesReport', () => {
  test('reads the header date, each numbered bill and the total', () => {
    const r = parseSalesReport(REPORT);
    expect(r.date).toEqual({ day: 11, month: 10 });
    expect(r.bills).toEqual([
      { line: 3, ref_raw: 'HC8993', ref_token: 'HC8993', amount_sen: 650000, extra_sen: null, extra_tag: null, salesperson_name: 'Jason' },
      { line: 4, ref_raw: 'HC10785', ref_token: 'HC10785', amount_sen: 499900, extra_sen: null, extra_tag: null, salesperson_name: 'Melvin' },
    ]);
    expect(r.days).toEqual([]);
    expect(r.total_sen).toBe(1149900);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('tolerates phone spellings: spaces and dashes in the number, RM with a space, commas, cents, separators, no name', () => {
    const r = parseSalesReport([
      'HC 13281 - RM 6,500.50 - Jason Lee',
      '3) ZNT-6042: rm4999 Melvin',
      'CR0315 2060',
      'EGT 0319 RM3,700 Louis 014-6698448',
    ].join('\n'));
    expect(r.bills.map((b) => [b.ref_token, b.amount_sen, b.salesperson_name])).toEqual([
      ['HC13281', 650050, 'Jason Lee'],
      ['ZNT6042', 499900, 'Melvin'],
      ['CR0315', 206000, null],
      ['EGT0319', 370000, 'Louis 014-6698448'],
    ]);
    expect(r.bills[0]!.ref_raw).toBe('HC 13281');
  });

  test('a day-summary message reads its days and its total, and has no bills', () => {
    const r = parseSalesReport(`5/10 - 11/10 AKEMI SUNWAY KLUANG SOLO

5/10 - 0
6/10 - 0
7/10 - RM 126
8/10 - RM 12,499
9/10 - RM 3999
10/10 - RM 5400
11/10 - RM 11,499

Total - RM 33,523`);
    expect(r.bills).toEqual([]);
    expect(r.date).toEqual({ day: 5, month: 10 });
    expect(r.days.map((d) => [d.day, d.month, d.amount_sen])).toEqual([
      [5, 10, 0], [6, 10, 0], [7, 10, 12600], [8, 10, 1249900], [9, 10, 399900], [10, 10, 540000], [11, 10, 1149900],
    ]);
    expect(r.total_sen).toBe(3352300);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(looksLikeSalesReport(`5/10 - 0\nTotal - RM 0`)).toBe(false);
  });

  test('a total that is not the sum of the bills is a warning, and the bills still stand', () => {
    const r = parseSalesReport('1. HC1 RM100 A\n2. HC2 RM200 B\nTotal RM 400');
    expect(r.bills).toHaveLength(0); // "HC1" has fewer than three digits — not a booklet number
    const r2 = parseSalesReport('1. HC1001 RM100 A\n2. HC1002 RM200 B\nTotal RM 400');
    expect(r2.bills).toHaveLength(2);
    expect(r2.warnings).toEqual(['The message\'s Total (RM 400.00) is not the sum of its bills (RM 300.00).']);
  });

  test('an unreadable line is skipped and reported; a zero amount is not a bill', () => {
    const r = parseSalesReport('1. HC8993 RM6500 Jason\nfoc mattress for HC8993\n2. HC8994 RM0 Nobody');
    expect(r.bills.map((b) => b.ref_token)).toEqual(['HC8993']);
    expect(r.skipped.map((s) => s.text)).toEqual(['foc mattress for HC8993', '2. HC8994 RM0 Nobody']);
  });

  test('empty and null input parse to nothing', () => {
    expect(parseSalesReport('').bills).toEqual([]);
    expect(parseSalesReport(null).bills).toEqual([]);
    expect(looksLikeSalesReport(null)).toBe(false);
    expect(looksLikeSalesReport(REPORT)).toBe(true);
  });
});

describe('normalizeRefToken / extractRefTokens', () => {
  test('one spelling for every way a booklet number is typed', () => {
    expect(normalizeRefToken('HC 8993')).toBe('HC8993');
    expect(normalizeRefToken('hc-8993')).toBe('HC8993');
    expect(normalizeRefToken(' znt 6042 ')).toBe('ZNT6042');
  });
  test('every booklet number in a hand-typed Ref No., and none of the words', () => {
    expect(extractRefTokens('HC13263 share with yuny')).toEqual(['HC13263']);
    expect(extractRefTokens('HC13503 + ZNT6191')).toEqual(['HC13503', 'ZNT6191']);
    expect(extractRefTokens('HC 13281')).toEqual(['HC13281']);
    expect(extractRefTokens('')).toEqual([]);
    expect(extractRefTokens(null)).toEqual([]);
  });
});

describe('the report as WhatsApp actually pastes it (2026-10-14, Sutera Mall)', () => {
  /* The list copied from the group carried U+2060 word joiners after the
     numbering on three lines and a non-breaking space on one; three of seven
     bills were dropped on the first live paste. */
  const WA = [
    'JB @ SUTERA MALL 9-11/10',
    '',
    '10/10',
    '1. HC13162 RM1999 Ethan',
    '2. HC13163 RM4172 + 710(T) Ethan',
    '3. ⁠HC13164 RM5300 CH',
    '4. HC13130 RM4273 + 727(T) Ethan',
    '5. HC13031 RM8622 + 1446 (T) Sheldon',
    '6. ⁠HC13106 RM8199 Louis',
    '7. ⁠HC13165 RM5300 CH',
    '',
    'TOTAL: RM37,865+2883(T)',
  ].join('\n');

  test('invisible joiners and non-breaking spaces do not hide a bill', () => {
    const r = parseSalesReport(WA);
    expect(r.bills.map((b) => b.ref_token)).toEqual(['HC13162', 'HC13163', 'HC13164', 'HC13130', 'HC13031', 'HC13106', 'HC13165']);
    expect(r.date).toEqual({ day: 10, month: 10 });
    expect(r.skipped.map((s) => s.text)).toEqual(['JB @ SUTERA MALL 9-11/10']);
  });

  test('a "+ 710(T)" tail is kept apart from the bill and out of the name', () => {
    const r = parseSalesReport(WA);
    const t = r.bills.find((b) => b.ref_token === 'HC13163')!;
    expect(t.amount_sen).toBe(417200);
    expect(t.extra_sen).toBe(71000);
    expect(t.extra_tag).toBe('T');
    expect(t.salesperson_name).toBe('Ethan');
    const s = r.bills.find((b) => b.ref_token === 'HC13031')!;
    expect([s.amount_sen, s.extra_sen, s.extra_tag, s.salesperson_name]).toEqual([862200, 144600, 'T', 'Sheldon']);
    const plain = r.bills.find((b) => b.ref_token === 'HC13106')!;
    expect([plain.extra_sen, plain.extra_tag, plain.salesperson_name]).toEqual([null, null, 'Louis']);
  });

  test('the TOTAL line with its own "+" part is read, matches the bills, and the extras are reported', () => {
    const r = parseSalesReport(WA);
    expect(r.total_sen).toBe(3786500);
    expect(r.bills.reduce((s, b) => s + b.amount_sen, 0)).toBe(3786500);
    expect(r.warnings).toEqual(['3 bills carry a "+" amount (RM 2,883.00 in total) that is not counted in the amount.']);
  });

  test('a "+" amount without a tag is still an extra, and the name stays whole', () => {
    const r = parseSalesReport('1. HC1001 RM100 + 50 Ethan Lee');
    expect([r.bills[0]!.amount_sen, r.bills[0]!.extra_sen, r.bills[0]!.extra_tag, r.bills[0]!.salesperson_name]).toEqual([10000, 5000, null, 'Ethan Lee']);
  });

  test('the summary that followed: its Total does not add up to its days, and says so', () => {
    const r = parseSalesReport('JB @ Sutera Mall 9-11/10\n\n9/10:RM10,500 \n10/10:RM37,865+2883\n\nTotal RM48,185+2883');
    expect(r.bills).toEqual([]);
    expect(r.days.map((d) => [d.day, d.month, d.amount_sen, d.extra_sen])).toEqual([[9, 10, 1050000, null], [10, 10, 3786500, 288300]]);
    expect(r.total_sen).toBe(4818500);
    expect(r.warnings).toContain("The message's Total (RM 48,185.00) is not the sum of its days (RM 48,365.00).");
    expect(summaryTotalOf(r)).toEqual({ total_sen: 4818500, days_sen: 4836500 });
  });
});

describe('a summary with a disposal charge and a lost parenthesis (Homedec @ Zanotti)', () => {
  const HOMEDEC = 'Homedec@Zanotti 2-4/10\n\n2/10 - RM6288\n3/10 - RM8888\n4/10 - RM8538+150(D)\n\nTotal- RM23,714+150(D';

  test('the "+150(D)" is kept apart, the Total is read without its closing parenthesis, and the days add up', () => {
    const r = parseSalesReport(HOMEDEC);
    expect(r.days.map((d) => [d.day, d.amount_sen, d.extra_sen, d.extra_tag])).toEqual([
      [2, 628800, null, null], [3, 888800, null, null], [4, 853800, 15000, 'D'],
    ]);
    expect(r.total_sen).toBe(2371400);
    expect(r.skipped.map((s) => s.text)).toEqual(['Homedec@Zanotti 2-4/10']);
    expect(r.warnings).toEqual(['1 day carries a "+" amount (RM 150.00 in total) that is not counted in the amount.']);
    expect(summaryTotalOf(r)).toEqual({ total_sen: 2371400, days_sen: 2371400 });
  });

  test('a bill message is never a summary, and a summary with no total is not one either', () => {
    expect(summaryTotalOf(parseSalesReport(REPORT))).toBeNull();
    expect(summaryTotalOf(parseSalesReport('2/10 - RM6288'))).toBeNull();
    expect(summaryTotalOf(parseSalesReport('Total RM 3700'))).toEqual({ total_sen: 370000, days_sen: null });
  });
});

describe('the report date', () => {
  test('a date inside the header counts when no line is a date (Setia Spice, 2026-10-14)', () => {
    const r = parseSalesReport('AKEMI@Setia Spice Convention Centre 3/10\n\n1. HC13378 RM4000 YW\n\nTotal RM4000');
    expect(r.date).toEqual({ day: 3, month: 10 });
    expect(r.bills.map((b) => b.ref_token)).toEqual(['HC13378']);
  });
  test('a line that is a date wins over the header, and a range of days is never the date', () => {
    expect(parseSalesReport('JB @ SUTERA MALL 9-11/10\n\n10/10\n1. HC13162 RM1999 Ethan').date).toEqual({ day: 10, month: 10 });
    expect(parseSalesReport('Homedec@Zanotti 2-4/10\n1. HC1001 RM100 A').date).toBeNull();
    expect(parseSalesReport('1. HC1001 RM100 A\nsee you 5/10').date).toBeNull();
  });
});

describe('reportDateFor', () => {
  test('takes the year from the project and pads the day and month', () => {
    expect(reportDateFor({ day: 7, month: 10 }, '2026-10-05')).toBe('2026-10-07');
    expect(reportDateFor(null, '2026-10-05')).toBeNull();
    expect(reportDateFor({ day: 7, month: 10 }, null)).toBeNull();
  });
});
