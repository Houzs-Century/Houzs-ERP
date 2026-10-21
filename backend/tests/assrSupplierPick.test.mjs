import { describe, expect, test } from 'vitest';
import { pickCaseSupplier } from '../scripts/lib/assr-supplier-pick.mjs';

describe('pickCaseSupplier (HC-0130 backfill)', () => {
  const pos = [
    { po_number: 'HC-PO-1', po_date: '2026-09-01', status: 'RECEIVED', code: '400-A' },
    { po_number: 'HC-PO-2', po_date: '2026-10-01', status: 'SUBMITTED', code: '400-B' },
    { po_number: 'HC-PO-3', po_date: '2026-10-09', status: 'CANCELLED', code: '400-Z' },
  ];
  const binds = [{ is_main_supplier: true, code: '400-MAIN' }, { is_main_supplier: false, code: '400-ALT' }];

  test('the latest live PO beats the SO binding and AutoCount', () => {
    expect(pickCaseSupplier({ hasSoLine: true, pos, binds, mainSupplier: '400-AC' })).toEqual({ code: '400-B', source: 'po' });
  });

  test('no PO -> the main bound supplier; one supplier and no main -> that one', () => {
    expect(pickCaseSupplier({ hasSoLine: true, pos: [], binds, mainSupplier: '400-AC' })).toEqual({ code: '400-MAIN', source: 'so' });
    expect(pickCaseSupplier({ hasSoLine: true, pos: [], binds: [{ is_main_supplier: false, code: '400-ONE' }], mainSupplier: null }))
      .toEqual({ code: '400-ONE', source: 'so' });
  });

  test('several suppliers and no main, or no SO line -> AutoCount, else null', () => {
    const two = [{ is_main_supplier: false, code: '400-A' }, { is_main_supplier: false, code: '400-B' }];
    expect(pickCaseSupplier({ hasSoLine: true, pos: [], binds: two, mainSupplier: '400-AC' })).toEqual({ code: '400-AC', source: 'auto' });
    expect(pickCaseSupplier({ hasSoLine: false, pos: [], binds, mainSupplier: null })).toBeNull();
    expect(pickCaseSupplier({ hasSoLine: true, pos: [pos[2]], binds: two, mainSupplier: null })).toBeNull();
  });
});
