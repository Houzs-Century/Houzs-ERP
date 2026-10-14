/* HC-0003 T5: one parser for every import file. */
import { describe, expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { parseCSV } from './csv';
import { normalizeImportHeader, readImportGrid, resolveImportHeaders } from './import-sheet';

const file = (name: string, body: BlobPart): File => {
  const f = new File([body], name);
  /* jsdom's File has neither text() nor arrayBuffer(); the browser's does. */
  Object.defineProperty(f, 'arrayBuffer', { value: async () => body });
  Object.defineProperty(f, 'text', { value: async () => String(body) });
  return f;
};

describe('resolveImportHeaders: the importer reads its own key whatever the sheet calls it', () => {
  const known = ['internal_code', 'price_rm', 'bedframe_P1'];

  test('case, spaces and underscores do not matter, and the key keeps its own spelling', () => {
    expect(resolveImportHeaders([' Internal Code ', 'PRICE RM', 'Bedframe p1'], known, {}))
      .toEqual(['internal_code', 'price_rm', 'bedframe_P1']);
  });

  test('an alias maps to its key; a known key wins over an alias of the same name', () => {
    expect(resolveImportHeaders(['Item Code', 'price_rm'], known, { 'item code': 'internal_code', price_rm: 'internal_code' }))
      .toEqual(['internal_code', 'price_rm']);
  });

  test('a header the importer does not know passes through as written (trimmed)', () => {
    expect(resolveImportHeaders(['  Colour of the Month '], known, {})).toEqual(['Colour of the Month']);
  });

  test('normalizeImportHeader collapses runs of space and underscore', () => {
    expect(normalizeImportHeader('  Fabric  __ Code ')).toBe('fabric_code');
  });
});

describe('parseCSV: what Excel writes', () => {
  test('quoted commas, doubled quotes, CRLF inside quotes, BOM', () => {
    expect(parseCSV('﻿code,name\r\nA,"x, ""y""\r\nz"\r\n')).toEqual([['code', 'name'], ['A', 'x, "y"\r\nz']]);
  });

  test('an inch mark in the middle of an unquoted cell stays a character', () => {
    expect(parseCSV('code,desc\nS-1,24" seat, firm\n')).toEqual([['code', 'desc'], ['S-1', '24" seat', ' firm']]);
  });
});

describe('readImportGrid: CSV and Excel give the same rows', () => {
  test('an .xlsx and the same data as .csv read the same', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['code', 'price'], ['A-1', 1535.5], ['B-2', '']]), 'S');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const fromXlsx = await readImportGrid(file('skus.xlsx', bytes));
    const fromCsv = await readImportGrid(file('skus.csv', 'code,price\r\nA-1,1535.5\r\nB-2,\r\n'));
    expect(fromXlsx).toEqual([['code', 'price'], ['A-1', '1535.5'], ['B-2', '']]);
    expect(fromCsv).toEqual(fromXlsx);
  });

  test('a broken workbook (a cut-off .xlsx) is refused with a reason, not an empty import', async () => {
    await expect(readImportGrid(file('broken.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer))).rejects.toThrow(/could not be read/);
  });
});
