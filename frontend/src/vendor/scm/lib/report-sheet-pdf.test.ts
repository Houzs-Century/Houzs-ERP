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
});
