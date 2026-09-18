import { describe, expect, test } from 'vitest';

import { parseCsv, parseWorkbook, importErrorDetail } from './fabric-csv';

// Build an .xlsx workbook buffer in memory from an array-of-arrays, so the test
// exercises the real SheetJS read path parseWorkbook uses (no committed binary
// fixture). Mirrors dependencySecurity.test.ts's producer.
async function xlsxBufferFromAoa(aoa: unknown[][]): Promise<ArrayBuffer> {
  const XLSX = await import('../../../lib/xlsx-runtime');
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Fabrics');
  return XLSX.writeXLSX(wb, { type: 'array' }) as ArrayBuffer;
}

describe('parseWorkbook — Excel imports the same shape as CSV', () => {
  test('an .xlsx buffer parses to the expected rows', async () => {
    const buf = await xlsxBufferFromAoa([
      // header row uses spaces + mixed case — must map like the snake_case export
      ['Fabric Code', 'Fabric Description', 'Sofa Price Tier', 'price_sen', 'lead_time_days'],
      ['AVANI 09', 'IVORY', 'PRICE_1', 1500, 30],
      ['BF-01', '', 'PRICE_2', '', ''],  // blank cells -> null
    ]);

    const { rows, errors } = await parseWorkbook(buf);

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { fabricCode: 'AVANI 09', fabricDescription: 'IVORY', sofaPriceTier: 'PRICE_1', priceSen: 1500, leadTimeDays: 30 },
      { fabricCode: 'BF-01', fabricDescription: null, sofaPriceTier: 'PRICE_2', priceSen: null, leadTimeDays: null },
    ]);
  });

  test('Excel and CSV produce identical rows for the same data', async () => {
    const buf = await xlsxBufferFromAoa([
      ['fabric_code', 'supplier_code', 'price_sen'],
      ['CG-015', 'DC-151-03', 900],
    ]);
    const fromXlsx = await parseWorkbook(buf);
    const fromCsv = parseCsv('fabric_code,supplier_code,price_sen\r\nCG-015,DC-151-03,900\r\n');

    expect(fromXlsx.rows).toEqual(fromCsv.rows);
  });

  test('a workbook missing fabric_code is a clear error, not a silent empty import', async () => {
    const buf = await xlsxBufferFromAoa([
      ['description', 'price_sen'],
      ['no code here', 100],
    ]);
    const { rows, errors } = await parseWorkbook(buf);

    expect(rows).toEqual([]);
    expect(errors).toEqual(['Header must include a fabric_code column']);
  });

  test('unknown columns are warned, not rejected', async () => {
    const buf = await xlsxBufferFromAoa([
      ['fabric_code', 'colour_of_the_month'],
      ['XZ-1', 'teal'],
    ]);
    const { rows, warnings } = await parseWorkbook(buf);

    expect(rows).toEqual([{ fabricCode: 'XZ-1' }]);
    expect(warnings).toEqual(['Ignoring unknown columns: colour_of_the_month']);
  });
});

describe('importErrorDetail — the server reason reaches the UI', () => {
  test('surfaces the reason AND the conflicting codes off the raw error body', () => {
    const err = Object.assign(new Error('That clashes with something already in the system.'), {
      status: 409,
      body: JSON.stringify({
        error: 'fabric_id_belongs_to_another_company',
        reason: 'These fabric codes already belong to another company.',
        ids: ['AVANI-01', 'BF-02'],
      }),
    });

    const detail = importErrorDetail(err);

    expect(detail).toContain('These fabric codes already belong to another company.');
    expect(detail).toContain('Conflicting codes: AVANI-01, BF-02');
  });

  test('falls back to message when there is no reason field', () => {
    const err = Object.assign(new Error('generic'), {
      body: JSON.stringify({ message: 'Company could not be resolved.' }),
    });
    expect(importErrorDetail(err)).toBe('Company could not be resolved.');
  });

  test('returns null when the error carries no structured body', () => {
    expect(importErrorDetail(new Error('boom'))).toBeNull();
    expect(importErrorDetail(Object.assign(new Error('x'), { body: 'not json' }))).toBeNull();
    expect(importErrorDetail(undefined)).toBeNull();
  });
});
