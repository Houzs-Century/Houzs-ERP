// Conts-ERP #717: the DO detail GET hands the printed DO its ship-from warehouse
// NAME. The lookup is company-scoped, so another company's warehouse never
// resolves even when its id is asked for.
import { describe, expect, test } from 'vitest';
import { doWarehouseLabels } from './do-warehouse-labels';

type Row = { id: string; code: string | null; name: string | null; company_id: number };

function fakeSb(rows: Row[], fail = false) {
  return {
    from: (table: string) => {
      expect(table).toBe('warehouses');
      let current = [...rows];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { current = current.filter((r) => (r as Record<string, unknown>)[col] === val); return q; },
        in: (col: string, vals: unknown[]) => { current = current.filter((r) => vals.includes((r as Record<string, unknown>)[col])); return q; },
        then: (onF: (v: unknown) => unknown) => Promise.resolve(
          fail ? { data: null, error: { message: 'boom' } } : { data: current, error: null },
        ).then(onF),
      };
      return q;
    },
  };
}

const ctx = (companyId: number) => ({ get: (k: string) => (k === 'companyId' ? companyId : undefined) });

const ROWS: Row[] = [
  { id: 'wh-blk', code: 'BLK', name: 'Balakong Warehouse', company_id: 1 },
  { id: 'wh-code-only', code: 'KL', name: '  ', company_id: 1 },
  { id: 'wh-other', code: 'GZ', name: 'Guangzhou Warehouse', company_id: 2 },
];

describe('doWarehouseLabels', () => {
  test('returns the code label and the trimmed name per warehouse', async () => {
    const map = await doWarehouseLabels(fakeSb(ROWS), ctx(1), ['wh-blk', 'wh-code-only', null, 'wh-blk']);
    expect(map.get('wh-blk')).toEqual({ label: 'BLK', name: 'Balakong Warehouse' });
    expect(map.get('wh-code-only')).toEqual({ label: 'KL', name: null });
  });

  test("another company's warehouse does not resolve", async () => {
    const map = await doWarehouseLabels(fakeSb(ROWS), ctx(1), ['wh-other']);
    expect(map.has('wh-other')).toBe(false);
  });

  test('no ids means no read, and a failed read yields no labels rather than throwing', async () => {
    expect((await doWarehouseLabels({ from: () => { throw new Error('should not read'); } }, ctx(1), [null])).size).toBe(0);
    expect((await doWarehouseLabels(fakeSb(ROWS, true), ctx(1), ['wh-blk'])).size).toBe(0);
  });
});
