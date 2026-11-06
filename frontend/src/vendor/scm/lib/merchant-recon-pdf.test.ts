/* The two Merchant reports lists on paper (owner 2026-11-06: 支持pdf?). They print
   what the screen shows. Pinned: the cells and the totals, read without a PDF; and,
   on the real jsPDF, what the eye found wrong in the first sample: a report's name
   left alone at the foot of a page, away from its lines. Ordinary ASCII unless a
   test says otherwise: no font fetch, no network. */

import fs from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { jsPDF } from 'jspdf';

const deliver = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (...args: unknown[]) => deliver(...args) };
});

import {
  generateReportLinesPdf, generateWaitingCardsPdf, reportLinesTable, waitingCardsSubtitle, waitingCardsTable,
  type PrintedLine, type PrintedReport, type WaitingCardsView,
} from './merchant-recon-pdf';

afterEach(() => { deliver.mockClear(); vi.unstubAllGlobals(); });

const KEYS = ['merchant', 'document', 'refNo', 'salesperson', 'paidOn', 'days', 'amount', 'accountSheet', 'approval'];
const view = (body: Array<Array<string | number | null>>): WaitingCardsView => ({
  keys: KEYS,
  matrix: {
    header: ['Merchant', 'Document', 'Ref No.', 'Salesperson', 'Customer paid on', 'Days', 'Amount', 'Account sheet', 'Approval'],
    formats: ['text', 'text', 'text', 'text', 'date', 'number', 'money', 'text', 'text'],
    body,
  },
});
const WAITING = [
  ['MBB', 'HC-SO-013055', 'HC12980', 'Esther', '2026-08-01', 97, 3700, '393020', 'HC12980'],
  ['AEON', 'HC-SO-2611-019', 'ZNT6390', null, '2026-11-02', 4, 4200.5, null, null],
];

const line = (over: Partial<PrintedLine> = {}): PrintedLine => ({
  date: '2026-11-05', lineNo: 17, ref: 'R41797', grossSen: 399000, feeSen: 4788, netSen: 394212,
  document: null, orders: [], status: 'you choose', tone: null, ...over,
});
const report = (over: Partial<PrintedReport> = {}): PrintedReport => ({
  merchant: 'AEON', file: '20261105_000458030287527.csv', netSen: 378364, lines: [line()], ...over,
});

const pagesOf = (doc: jsPDF): string[] => {
  const pages = (doc.internal as unknown as { pages: Array<string[] | null> }).pages;
  return pages.slice(1).map((p) => (p ?? []).join('\n'));
};
const drawn = () => deliver.mock.calls[0]! as [jsPDF, string, string];
/* A PDF string escapes its brackets. */
const asPdf = (text: string) => text.replace(/[()]/g, '\\$&');

describe('the card payments list', () => {
  test('prints each format as the screen reads it, and a blank as a dash', () => {
    const t = waitingCardsTable(view(WAITING));
    expect(t.head).toEqual(['Merchant', 'Document', 'Ref No.', 'Salesperson', 'Customer paid on', 'Days', 'Amount', 'Account sheet', 'Approval']);
    expect(t.body[0]).toEqual(['MBB', 'HC-SO-013055', 'HC12980', 'Esther', '2026/08/01', '97', '3,700.00', '393020', 'HC12980']);
    expect(t.body[1]).toEqual(['AEON', 'HC-SO-2611-019', 'ZNT6390', '-', '2026/11/02', '4', '4,200.50', '-', '-']);
  });

  test('totals the money under its own column, whatever column that has become', () => {
    expect(waitingCardsTable(view(WAITING)).foot).toEqual([
      { content: 'Total (2 rows)', colSpan: 6 }, '7,900.50', { content: '', colSpan: 2 },
    ]);
    const moved: WaitingCardsView = {
      keys: ['amount', 'document'],
      matrix: { header: ['Amount', 'Document'], formats: ['money', 'text'], body: [[10, 'A'], [5.25, 'B']] },
    };
    expect(waitingCardsTable(moved).foot).toEqual(['15.25', { content: 'Total (2 rows)', colSpan: 1 }]);
  });

  test('a reader who hid Amount gets no total row, and Days only where it still shows', () => {
    const noMoney: WaitingCardsView = { keys: ['document'], matrix: { header: ['Document'], formats: ['text'], body: [['A']] } };
    const t = waitingCardsTable(noMoney);
    expect(t.foot).toBeNull();
    expect(t.daysCol).toBe(-1);
    expect(waitingCardsTable(view(WAITING)).daysCol).toBe(5);
  });

  test('the sentence on top says how many have no bank, and which merchant the list was cut to', () => {
    const withUntagged = view([['未标', 'A', null, null, '2026-08-01', 1, 1, null, null], ...WAITING]);
    expect(waitingCardsSubtitle(withUntagged, null)).toBe('Card payments no merchant report has reported yet. 1 keyed in without a bank (未标). All amounts in RM.');
    expect(waitingCardsSubtitle(view(WAITING), 'AEON')).toBe('Merchant: AEON. Card payments no merchant report has reported yet. All amounts in RM.');
  });

  test('the drawn document leaves as a preview under the list\'s name, numbered, the total on the last page only', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ['MBB', `HC-SO-${i}`, `HC${i}`, 'Esther', '2026-08-01', 20, 100, '393020', 'A1']);
    await generateWaitingCardsPdf(view(rows), { merchant: null });
    const [doc, name, action] = drawn();
    expect(name).toMatch(/^card-payments-not-reported-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(action).toBe('preview');
    const pages = pagesOf(doc);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
    expect(pages.filter((p) => p.includes(asPdf('Total (120 rows)'))).length).toBe(1);
    expect(pages[pages.length - 1]).toContain(asPdf('Total (120 rows)'));
    expect(pages[0]).toContain('CARD PAYMENTS NOT REPORTED');
  });

  test('未标 draws in the embedded Chinese face, the sentence on top included', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const buf = fs.readFileSync(`public${url}`);
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    });
    await generateWaitingCardsPdf(view([['未标', 'HC-SO-1', 'HC1', 'Esther', '2026-08-01', 20, 100, '393020', 'A1']]), { merchant: null });
    const [doc] = drawn();
    expect(Object.keys(doc.getFontList())).toContain('NotoSansSC');
  }, 30000);
});

describe('the reports still to reconcile', () => {
  const ORDER = { docNo: 'HC-SO-009256', customer: 'Mandy Lim', sales: 'Lim Yau Wei', sheet: '903549', paidOn: '2025-11-18', code: 'HC6301', amountSen: 165000 };
  const OTHER = { docNo: 'HC-SO-009349', customer: 'Angelia', sales: 'Anthony', sheet: null, paidOn: null, code: 'ZNT5481', amountSen: 30000 };

  test('a line with no sale says what the screen says; several orders stack in their cells', () => {
    const t = reportLinesTable([report({
      lines: [
        line({ document: '7 possible' }),
        line({ ref: '036911', lineNo: 24, date: '2025-11-22', grossSen: 195000, feeSen: 2340, netSen: 192660, orders: [ORDER, OTHER], status: 'the system’s guess — check it' }),
      ],
    })]);
    expect(t.body[0]).toEqual(['2026/11/05\nline 17', 'R41797', '3,990.00', '47.88', '3,942.12', '7 possible', '-', '-', '-', '-', '-', '-', 'you choose']);
    expect(t.body[1]).toEqual([
      '2025/11/22\nline 24', '036911', '1,950.00', '23.40', '1,926.60',
      'HC-SO-009256\nHC-SO-009349', 'Mandy Lim\nAngelia', 'Lim Yau Wei\nAnthony', '903549\n-', '2025/11/18\n-', 'HC6301\nZNT5481', '1,650.00\n300.00',
      'the system’s guess — check it',
    ]);
  });

  test('each report names itself once, on its first line; the total adds every line once', () => {
    const t = reportLinesTable([
      report({ lines: [line(), line({ ref: 'R2', lineNo: 18 })] }),
      report({ merchant: 'MBB', file: 'b.CSV', netSen: 100, lines: [line({ ref: 'R3', grossSen: 1000, feeSen: 10, netSen: 990, orders: [ORDER] })] }),
    ]);
    expect([...t.bands.entries()]).toEqual([
      [0, 'AEON   20261105_000458030287527.csv   net 3,783.64'],
      [2, 'MBB   b.CSV   net 1.00'],
    ]);
    expect(t.foot).toEqual([
      { content: 'Total (3 lines)', colSpan: 2 }, '7,990.00', '95.86', '7,894.14', { content: '', colSpan: 6 }, '1,650.00', '',
    ]);
  });

  test('a report\'s name is never parted from its first line by a page break', async () => {
    const reports = Array.from({ length: 70 }, (_, i) => report({
      file: `REPORT-${i}.csv`,
      lines: [line({ ref: `FIRST-${i}` }), line({ ref: `NEXT-${i}` })],
    }));
    await generateReportLinesPdf(reports, { merchant: null });
    const [doc, name, action] = drawn();
    expect(name).toMatch(/^merchant-reports-to-reconcile-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(action).toBe('preview');
    const pages = pagesOf(doc);
    expect(pages.length).toBeGreaterThan(2);
    const pageOf = (text: string) => pages.findIndex((p) => p.includes(`(${text}) Tj`));
    reports.forEach((_, i) => {
      expect(pages.findIndex((p) => p.includes(`REPORT-${i}.csv`))).toBe(pageOf(`FIRST-${i}`));
    });
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
  });

  test('a report longer than a page prints every line, its name once, and the total once', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => line({ ref: `LINE-${i}`, lineNo: i + 1 }));
    await generateReportLinesPdf([report({ file: 'LONG.csv', lines })], { merchant: 'AEON' });
    const [doc] = drawn();
    const pages = pagesOf(doc);
    const all = pages.join('\n');
    expect(pages.length).toBeGreaterThan(2);
    lines.forEach((l) => expect(all).toContain(`(${l.ref}) Tj`));
    expect(all.split('LONG.csv').length - 1).toBe(1);
    expect(all.split(asPdf('Total (120 lines)')).length - 1).toBe(1);
    expect(pages[pages.length - 1]).toContain(asPdf('Total (120 lines)'));
    expect(pages[0]).toContain('Merchant: AEON.');
  });
});
