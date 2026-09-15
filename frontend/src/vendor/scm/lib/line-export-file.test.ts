// The one sheet writer the line exports and the commission export share: a
// money column is a ringgit NUMBER shown #,##0.00, the way AutoCount prints it.
// docs/bugs/0928-datagrid-export-wrote-money-as-rm-text-or-blank-cells-and-ha.md
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writeLineExportXlsx } from './line-export-file';

const h = vi.hoisted(() => ({ books: [] as Array<{ Sheets: Record<string, Record<string, { t?: string; v?: unknown; z?: string }>> }> }));
vi.mock('../../../lib/xlsx-runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/xlsx-runtime')>();
  return { ...real, writeFileXLSX: (wb: (typeof h.books)[number]) => { h.books.push(wb); } };
});

afterEach(() => { h.books.length = 0; });

describe('writeLineExportXlsx', () => {
  test('formats the money columns it is told about and leaves the rest alone', async () => {
    await writeLineExportXlsx(
      ['Salesperson', 'Rate', 'Total (RM)'],
      { 'Total (RM)': '#,##0.00' },
      [['Ali', '2.50%', 15000], ['Bala', '3.00%', 123.4]],
      'Commission',
      'c.xlsx',
    );
    const ws = h.books[0]!.Sheets['Commission']!;
    expect(ws['C2']).toMatchObject({ t: 'n', v: 15000, z: '#,##0.00' });
    expect(ws['C3']).toMatchObject({ t: 'n', v: 123.4, z: '#,##0.00' });
    expect(ws['B2']!.z).toBeUndefined();
    expect(ws['C1']!.v).toBe('Total (RM)');
  });
});
