import { describe, expect, test } from 'vitest';
import { parseImportDate, parseImportText, readPoLineImportSheet, storedImportValue } from './po-line-import';

describe('parseImportDate — the three shapes the export can come back in', () => {
  test('ISO yyyy-mm-dd, with or without a time part', () => {
    expect(parseImportDate('2026-09-15')).toEqual({ ok: true, value: '2026-09-15' });
    expect(parseImportDate(' 2026-09-15T00:00:00 ')).toEqual({ ok: true, value: '2026-09-15' });
  });
  test('an Excel date serial, as a number or as numeric text', () => {
    expect(parseImportDate(46280)).toEqual({ ok: true, value: '2026-09-15' });
    expect(parseImportDate('46280')).toEqual({ ok: true, value: '2026-09-15' });
  });
  test('dd/mm/yyyy — day first, as Malaysia writes it', () => {
    expect(parseImportDate('15/09/2026')).toEqual({ ok: true, value: '2026-09-15' });
    expect(parseImportDate('1/9/2026')).toEqual({ ok: true, value: '2026-09-01' });
  });
  test('blank is a value (clear), not an error', () => {
    expect(parseImportDate(null)).toEqual({ ok: true, value: null });
    expect(parseImportDate('  ')).toEqual({ ok: true, value: null });
  });
  test('impossible or free-text dates are refused with a reason', () => {
    for (const bad of ['2026-02-30', '31/02/2026', '09/15/2026', 'next week', 15, true]) {
      const r = parseImportDate(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
  });
});

describe('text and stored values compare in one shape', () => {
  test('text is trimmed and blank is null', () => {
    expect(parseImportText('  chase supplier ')).toEqual({ ok: true, value: 'chase supplier' });
    expect(parseImportText('')).toEqual({ ok: true, value: null });
    expect(parseImportText(123)).toEqual({ ok: true, value: '123' });
    expect(parseImportText('x'.repeat(1001)).ok).toBe(false);
  });
  test('a stored date arrives as text over PostgREST and as a Date in a transaction', () => {
    expect(storedImportValue('deliveryDate', '2026-09-15')).toBe('2026-09-15');
    expect(storedImportValue('deliveryDate', new Date('2026-09-15'))).toBe('2026-09-15');
    expect(storedImportValue('remarks', '  ')).toBeNull();
  });
});

describe('readPoLineImportSheet', () => {
  const header = ['Doc No', 'Line ID', 'Item Code', 'Qty', 'Unit Price', 'Item Description 2', 'Remarks', 'Delivery Date', 'Estimate Delivery Date 1', 'Estimate Delivery Date 2', 'Estimate Delivery Date 3'];

  test('reads the six fields by header, keeps Excel row numbers, and names the ignored columns', () => {
    const sheet = readPoLineImportSheet([
      ['Purchase Order lines'],
      header,
      ['PO-000100', 'id-1', 'BED-K', 2, 1000, 'col:PC-151', 'chase', 46280, '2026-10-01', null, null],
      [null, null, null, null, null, null, null, null, null, null, null],
      ['PO-000100', 'id-2', 'BED-Q', 99, 1, '', null, '15/09/2026', '', null, null],
    ]);
    if (!sheet.ok) throw new Error(sheet.error);
    expect(sheet.fields).toEqual(['deliveryDate', 'estimateDeliveryDate1', 'estimateDeliveryDate2', 'estimateDeliveryDate3', 'description2', 'remarks']);
    expect(sheet.ignoredHeaders).toEqual(['Item Code', 'Qty', 'Unit Price']);
    expect(sheet.rows.map((r) => r.rowNumber)).toEqual([3, 5]);
    expect(sheet.rows[0]).toEqual({
      rowNumber: 3, docNo: 'PO-000100', lineId: 'id-1',
      values: { deliveryDate: 46280, estimateDeliveryDate1: '2026-10-01', estimateDeliveryDate2: null, estimateDeliveryDate3: null, description2: 'col:PC-151', remarks: 'chase' },
    });
    expect(Object.keys(sheet.rows[1]!.values)).not.toContain('qty');
  });

  test("reads a grid export: AutoCount's captions, ERP Doc No, and names the editable columns it lacks", () => {
    const sheet = readPoLineImportSheet([
      ['ERP Doc No', 'Item Code', 'Estimate Delivery Date', 'Supplier Delivery Date 2', 'Line ID'],
      ['PO-000100', 'AK-X', '2026-10-01', null, 'id-1'],
    ]);
    if (!sheet.ok) throw new Error(sheet.error);
    expect(sheet.fields).toEqual(['estimateDeliveryDate1', 'estimateDeliveryDate2']);
    expect(sheet.missingHeaders).toEqual(['Delivery Date', 'Supplier Delivery Date 3', 'Item Description 2', 'Remarks']);
    expect(sheet.rows[0]).toMatchObject({ docNo: 'PO-000100', lineId: 'id-1' });
    expect(sheet.ignoredHeaders).toEqual(['Item Code']);
  });

  test('a file without Line ID says how to get one from the grid', () => {
    const r = readPoLineImportSheet([['Doc No', 'Remarks'], ['PO-1', 'x']]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Columns');
  });

  test('only the columns present are read; a missing Estimate column is not a clear', () => {
    const sheet = readPoLineImportSheet([['doc no', 'LINE ID', 'remarks'], ['PO-1', 'id-1', 'x']]);
    if (!sheet.ok) throw new Error(sheet.error);
    expect(sheet.rows[0]!.values).toEqual({ remarks: 'x' });
  });

  test('a file without Line ID, Doc No or any importable column is refused in words', () => {
    expect(readPoLineImportSheet([['Doc No', 'Remarks']])).toMatchObject({ ok: false });
    expect(readPoLineImportSheet([['Line ID', 'Remarks']])).toMatchObject({ ok: false });
    const none = readPoLineImportSheet([['Doc No', 'Line ID', 'Qty']]);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('Delivery Date');
  });
});
