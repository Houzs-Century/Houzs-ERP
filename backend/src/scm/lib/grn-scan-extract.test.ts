// Unit tests for the GR delivery-order extraction normaliser — the defensive
// coercion that guarantees downstream code a well-shaped GrnExtracted whatever
// the model returns.
import { describe, expect, test } from 'vitest';
import { normalizeGrnExtract } from './grn-scan-extract';

describe('normalizeGrnExtract', () => {
  test('coerces a clean delivery order', () => {
    const out = normalizeGrnExtract({
      supplierName: 'DIGLANT SDN BHD',
      poNo: 'PO-010070',
      doNo: 'DO-55231',
      deliveryDate: '2026-09-18',
      lines: [
        { itemCode: 'AMN-SF9050 SOFA 2B(RHF)', barcode: '123', description: 'Sofa', qty: 2 },
        { itemCode: '9015-1S', barcode: null, description: 'Chair', qty: '3' },
      ],
    });
    expect(out.supplierName).toBe('DIGLANT SDN BHD');
    expect(out.poNo).toBe('PO-010070');
    expect(out.doNo).toBe('DO-55231');
    expect(out.deliveryDate).toBe('2026-09-18');
    expect(out.lines).toEqual([
      { itemCode: 'AMN-SF9050 SOFA 2B(RHF)', barcode: '123', description: 'Sofa', qty: 2 },
      { itemCode: '9015-1S', barcode: null, description: 'Chair', qty: 3 },
    ]);
  });

  test('missing / garbage input yields a safe empty shape', () => {
    expect(normalizeGrnExtract(null)).toEqual({
      supplierName: null, poNo: null, doNo: null, deliveryDate: null, lines: [],
    });
    expect(normalizeGrnExtract('nonsense').lines).toEqual([]);
    expect(normalizeGrnExtract({ lines: 'not-an-array' }).lines).toEqual([]);
  });

  test('blank strings become null; qty parses out units and clamps at 0', () => {
    const out = normalizeGrnExtract({
      supplierName: '  ',
      poNo: '',
      lines: [
        { itemCode: '  ', description: 'x', qty: '5 PCS' },
        { itemCode: 'A', qty: 'abc' },
        { itemCode: 'B', qty: -4 },
      ],
    });
    expect(out.supplierName).toBeNull();
    expect(out.poNo).toBeNull();
    expect(out.lines[0]).toEqual({ itemCode: null, barcode: null, description: 'x', qty: 5 });
    expect(out.lines[1].qty).toBe(0);
    expect(out.lines[2].qty).toBe(0); // negative clamps to 0
  });

  test('non-ISO delivery date is dropped to null', () => {
    expect(normalizeGrnExtract({ deliveryDate: '18/09/2026' }).deliveryDate).toBeNull();
    expect(normalizeGrnExtract({ deliveryDate: '2026-09-18' }).deliveryDate).toBe('2026-09-18');
  });
});
