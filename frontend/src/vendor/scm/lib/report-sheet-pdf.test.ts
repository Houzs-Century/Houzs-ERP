/* The PDF a Finance report exports prints the sheet the screen shows (owner
   2026-09-19: pdf 不好看，就应该和原本的一样) — pure here: the printed columns
   (a % beside its amount merges into one cell — the amount as the cell's
   text, the % drawn beside it, never under it: owner 2026-09-20 百分比应该在
   数字旁边而不是下面), the head and body as text, each row kind's dress, the
   page a sheet prints on. */
import { describe, expect, it } from 'vitest';
import type { ReportSheet, SheetTable } from './report-sheet';
import { isLandscape, pageFor, printedColumns, printedStyle, printedTable } from './report-sheet-pdf';

const monthly: SheetTable = {
  columns: [
    { label: '累计 08/2026 – 09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
    { label: '09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true },
  ],
  rows: [
    { kind: 'block', depth: 0, label: 'Expenses', cells: [] },
    { kind: 'row', depth: 1, label: 'RENT', cells: [200_000, 20, null, null] },
    { kind: 'net', depth: 0, label: 'NET PROFIT', cells: [-41_500, -6.9, 100, 0.1] },
  ],
};

describe('the printed table', () => {
  it('merges a % beside its amount into one printed column — the amount as the text, the % beside it — keeps the 累计 edge, and blanks a block', () => {
    expect(printedColumns(monthly)).toEqual([
      { label: '累计 08/2026 – 09/2026', cols: [0, 1], edge: true },
      { label: '09/2026', cols: [2, 3], edge: false },
    ]);
    const p = printedTable(monthly);
    expect(p.head).toEqual(['', '累计 08/2026 – 09/2026', '09/2026']);
    expect(p.body).toEqual([
      ['Expenses', '', ''],
      ['RENT', '2,000.00', '-'],
      ['NET PROFIT', '(415.00)', '1.00'],
    ]);
    expect(p.beside).toEqual([
      [null, null, null],
      [null, '20.0%', '-'],
      [null, '-6.9%', '0.1%'],
    ]);
  });

  it('prints a statement\'s two columns as they are, nothing beside, in the report\'s own money dress', () => {
    const t: SheetTable = { columns: [{ label: 'Amount', kind: 'amount' }, { label: '% of sales', kind: 'pct' }], rows: [{ kind: 'total', depth: 0, label: 'Total', cells: [5, 50] }] };
    const p = printedTable(t, (sen) => `RM ${sen}`);
    expect(p.body).toEqual([['Total', 'RM 5', '50.0%']]);
    expect(p.beside).toEqual([[null, null, null]]);
    expect(p.head).toEqual(['', 'Amount', '% of sales']);
  });

  it('dresses each row kind as the screen does — bold, the two shades, a rule above a total and a heavier one above a net line', () => {
    expect(printedStyle('block')).toMatchObject({ bold: true, fill: null, rule: 0 });
    expect(printedStyle('category')).toMatchObject({ bold: true, fill: null });
    expect(printedStyle('row')).toMatchObject({ bold: false, italic: false, fill: null, rule: 0 });
    expect(printedStyle('unassigned')).toMatchObject({ italic: true, soft: true });
    expect(printedStyle('total')).toEqual({ bold: true, italic: false, soft: false, fill: [236, 238, 234], rule: 0.2 });
    expect(printedStyle('net')).toEqual({ bold: true, italic: false, soft: false, fill: [227, 230, 224], rule: 0.4 });
  });

  it('picks the paper by the columns printed: portrait A4 up to four, landscape A4 to eight, landscape A3 beyond — the type stays readable', () => {
    const base: ReportSheet = { title: 'P&L', subtitle: '', meta: [], tables: [] };
    const cols = (n: number): SheetTable => ({ columns: Array.from({ length: n }, (_, i) => ({ label: `c${i}`, kind: 'amount' as const })), rows: [] });
    expect(pageFor({ ...base, tables: [cols(2)] })).toEqual({ format: 'a4', orientation: 'portrait', fontSize: 8.5, labelW: 110 });
    expect(pageFor({ ...base, tables: [cols(4)] })).toEqual({ format: 'a4', orientation: 'portrait', fontSize: 8.5, labelW: 62 });
    expect(pageFor({ ...base, tables: [cols(5)] })).toEqual({ format: 'a4', orientation: 'landscape', fontSize: 7, labelW: 80 });
    expect(pageFor({ ...base, tables: [cols(7)] })).toEqual({ format: 'a4', orientation: 'landscape', fontSize: 7, labelW: 80 });
    /* 累计 and twelve months: thirteen printed columns, each an amount with its % beside. */
    expect(pageFor({ ...base, tables: [cols(13)] })).toEqual({ format: 'a3', orientation: 'landscape', fontSize: 6.5, labelW: 70 });
    expect(isLandscape({ ...base, tables: [cols(4)] })).toBe(false);
    expect(isLandscape({ ...base, tables: [cols(5)] })).toBe(true);
    /* Two months with a % beside each still print as two columns — upright. */
    expect(isLandscape({ ...base, tables: [monthly] })).toBe(false);
  });

  it('columns under a heading print the heading over them on a row of its own; a cell runs across where the line is not split (owner 2026-11-09)', () => {
    const t: SheetTable = {
      columns: [
        { label: 'Total', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
        { label: 'Settlement', kind: 'amount', group: 'Oct 2026' }, { label: 'Deposit', kind: 'amount', group: 'Oct 2026' },
        { label: 'Settlement', kind: 'amount', group: 'Sep 2026' }, { label: 'Deposit', kind: 'amount', group: 'Sep 2026' },
      ],
      rows: [
        { kind: 'row', depth: 1, label: '300-0000', cells: [90_000, 100, 50_000, 40_000, null, null] },
        { kind: 'row', depth: 1, label: 'TAXATION', cells: [5_000, 2.5, 5_000, null, null, null], spans: { 2: 2, 4: 2 } },
      ],
    };
    expect(printedColumns(t).map((p) => [p.label, p.group])).toEqual([['Total', undefined], ['Settlement', 'Oct 2026'], ['Deposit', 'Oct 2026'], ['Settlement', 'Sep 2026'], ['Deposit', 'Sep 2026']]);
    const p = printedTable(t);
    expect(p.headRows).toEqual([
      [{ content: '', rowSpan: 2 }, { content: 'Total', rowSpan: 2 }, { content: 'Oct 2026', colSpan: 2, styles: { halign: 'center' } }, { content: 'Sep 2026', colSpan: 2, styles: { halign: 'center' } }],
      ['Settlement', 'Deposit', 'Settlement', 'Deposit'],
    ]);
    expect(p.body[0]).toEqual(['300-0000', '900.00', '500.00', '400.00', '-', '-']);
    expect(p.body[1]).toEqual(['TAXATION', '50.00', { content: '50.00', colSpan: 2, styles: { halign: 'center' } }, { content: '-', colSpan: 2, styles: { halign: 'center' } }]);
    /* The % beside Total stays beside it; a merged cell has none. */
    expect(p.beside[1]).toEqual([null, '2.5%', null, null, null, null]);
    /* Without headings, one head row — as before. */
    expect(printedTable(monthly).headRows).toEqual([['', '累计 08/2026 – 09/2026', '09/2026']]);
  });
});

describe('sections — a title over the header, a headed name column, text read left to right (owner 2026-11-13)', () => {
  it('prints the title across the table on a row above the header and heads the name column; a left column stays left', () => {
    const t: SheetTable = {
      title: 'Closed months — adjustments', labelHeader: 'Order',
      columns: [{ label: 'Month', kind: 'text', align: 'left' }, { label: 'Adjustment', kind: 'amount' }],
      rows: [{ kind: 'row', depth: 0, label: 'HC-SO-2609-213', cells: ['2026/09', 557_44] }],
    };
    const p = printedTable(t);
    expect(p.headRows).toEqual([
      [{ content: 'Closed months — adjustments', colSpan: 3, styles: { halign: 'left' } }],
      ['Order', 'Month', 'Adjustment'],
    ]);
    expect(p.printed.map((c) => c.align ?? 'right')).toEqual(['left', 'right']);
    expect(p.body).toEqual([['HC-SO-2609-213', '2026/09', '557.44']]);
  });
});
