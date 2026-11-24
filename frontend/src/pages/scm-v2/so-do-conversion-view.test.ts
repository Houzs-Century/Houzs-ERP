/* The SO to DO conversion report's rules (so-do-conversion-view.ts): where a
   DO's order sits, the part the tiles filter to, and the sheet Excel and PDF
   are made from — the parts with their totals and shares, then the DOs. Made-up
   figures. */
import { describe, expect, test } from 'vitest';
import type { ConversionRow, SoDoConversionData } from '../../vendor/scm/lib/so-do-conversion-queries';
import { conversionSheet, fromText, partViewOf, partsShown, rowsOfPart, shareText } from './so-do-conversion-view';

const r = (id: string, part: ConversionRow['part'], soDate: string | null, amountSen: number, extra: Partial<ConversionRow> = {}): ConversionRow => ({
  id, doNumber: `DO-${id}`, doDate: '2026-11-05', status: 'LOADED', docNo: soDate ? `SO-${id}` : null, soDate, customer: null, imported: false,
  part, otherReason: null, amountSen, ...extra,
});
const DATA: SoDoConversionData = {
  month: '2026-11', from: '2026-11-01', to: '2026-11-30',
  total: { dos: 3, amountSen: 400_000, pct: 100 },
  parts: {
    this_month: { dos: 1, amountSen: 100_000, pct: 25 },
    earlier: { dos: 2, amountSen: 300_000, pct: 75 },
    other: { dos: 0, amountSen: 0, pct: 0 },
  },
  rows: [r('a', 'this_month', '2026-11-02', 100_000), r('b', 'earlier', '2026-10-30', 200_000), r('c', 'earlier', '2026-02-11', 100_000, { imported: true })],
};

describe('the SO to DO conversion rules', () => {
  test("a DO says where its order sits, or why it sits in neither part", () => {
    expect(fromText(r('a', 'this_month', '2026-11-02', 1))).toBe('This month');
    expect(fromText(r('b', 'earlier', '2026-10-30', 1))).toBe('Earlier · Oct 2026');
    expect(fromText(r('c', 'other', null, 1, { otherReason: 'order_after' }))).toBe('Order dated after the DO');
    expect(fromText(r('d', 'other', null, 1, { otherReason: 'order_not_found' }))).toBe('Order not found');
    expect(fromText(r('e', 'other', null, 1, { otherReason: null }))).toBe('Other DOs');
  });

  test('the part in the URL, and the rows it keeps', () => {
    expect(partViewOf('earlier')).toBe('earlier');
    expect(partViewOf('bogus')).toBe('all');
    expect(partViewOf(null)).toBe('all');
    expect(rowsOfPart(DATA.rows, 'earlier').map((x) => x.id)).toEqual(['b', 'c']);
    expect(rowsOfPart(DATA.rows, 'all')).toHaveLength(3);
  });

  test('Other DOs is a part only when the month has one, and a share reads to one decimal', () => {
    expect(partsShown(DATA)).toEqual(['this_month', 'earlier']);
    expect(partsShown({ ...DATA, parts: { ...DATA.parts, other: { dos: 1, amountSen: 0, pct: 0 } } })).toEqual(['this_month', 'earlier', 'other']);
    expect(shareText(25)).toBe('25.0%');
    expect(shareText(null)).toBe('—');
  });

  test('the sheet holds the parts with their totals and shares, then the DOs of the part shown', () => {
    const sheet = conversionSheet(DATA, 'all');
    expect(sheet.title).toBe('SO to DO conversion');
    expect(sheet.subtitle).toBe('Nov 2026 · by DO date · shipped DOs · RM');
    const [summary, list] = sheet.tables;
    expect(summary!.rows.map((x) => [x.label, ...x.cells])).toEqual([
      ["This month's orders", '1 DO', 100_000, 25],
      ['Earlier orders', '2 DOs', 300_000, 75],
      ['Total', '3 DOs', 400_000, 100],
    ]);
    expect(list!.rows.map((x) => [x.label, x.cells[4], x.cells[5]])).toEqual([
      ['DO-a', 'This month', 100_000], ['DO-b', 'Earlier · Oct 2026', 200_000], ['DO-c', 'Earlier · Feb 2026 (imported)', 100_000], ['Total', '3 DOs', 400_000],
    ]);
    const earlier = conversionSheet(DATA, 'earlier');
    expect(earlier.tables[1]!.title).toBe('Delivery orders · Earlier orders');
    expect(earlier.tables[1]!.rows.at(-1)!.cells.slice(4)).toEqual(['2 DOs', 300_000]);
  });
});
