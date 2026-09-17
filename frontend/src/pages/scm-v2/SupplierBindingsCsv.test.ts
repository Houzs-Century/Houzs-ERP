// B3 (2026-09-17) — the bulk-import auto-create parse. buildCreates must turn an
// UNKNOWN internal_code in the sheet into a create row (with prices parsed to
// sen), leave KNOWN codes alone, and always carry a non-empty supplier_sku +
// materialName (the batch-create endpoint requires them).
import { describe, expect, test } from 'vitest';
import { buildCreates, detectImportFormat } from './SupplierBindingsCsv';
import type { BindingRow } from '../../vendor/scm/lib/suppliers-queries';
import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';

const LONG_HEADER = ['internal_code', 'supplier_sku', 'category', 'height', 'tier', 'price_rm', 'lead_time_days', 'moq', 'is_main_supplier'];

const known = (code: string): Map<string, BindingRow> =>
  new Map([[code, { item_code: code } as BindingRow]]);

describe('buildCreates — bulk import auto-create', () => {
  test('creates an accessory binding for an unknown code, parsing price to sen', () => {
    const rows = [['ACC-1', 'SUP-ACC-1', 'other', '', '', '51.25', '7', '2', 'true']];
    const creates = buildCreates(rows, LONG_HEADER, 'long', new Map(), new Map(), []);
    expect(creates).toHaveLength(1);
    const c = creates[0]!;
    expect(c.itemCode).toBe('ACC-1');
    expect(c.supplierSku).toBe('SUP-ACC-1');
    expect(c.unitPriceSen).toBe(5125); // 51.25 RM → sen
    expect(c.leadTimeDays).toBe(7);
    expect(c.moq).toBe(2);
    expect(c.isMainSupplier).toBe(true);
    expect(c.materialName).toBe('ACC-1'); // no catalogue row → fall back to code
    expect(c.materialKind).toBe('mfg_product');
  });

  test('does NOT create a binding for a code already bound to this supplier', () => {
    const rows = [['K-1', 'SUP-K-1', 'other', '', '', '10.00', '', '', '']];
    const creates = buildCreates(rows, LONG_HEADER, 'long', known('K-1'), new Map(), []);
    expect(creates).toHaveLength(0);
  });

  test('carries a sofa price matrix built from height/tier rows', () => {
    const rows = [
      ['SOFA-X', 'SUP-SOFA-X', 'sofa', '30', 'P1', '1000.00', '', '', ''],
      ['SOFA-X', 'SUP-SOFA-X', 'sofa', '30', 'P2', '1200.00', '', '', ''],
    ];
    const products = new Map<string, MfgProductRow>([
      ['SOFA-X', { code: 'SOFA-X', name: 'Sofa X', category: 'SOFA' } as MfgProductRow],
    ]);
    const creates = buildCreates(rows, LONG_HEADER, 'long', new Map(), products, ['30']);
    expect(creates).toHaveLength(1);
    const c = creates[0]!;
    expect(c.materialName).toBe('Sofa X'); // catalogue name preferred
    expect(c.supplierSku).toBe('SUP-SOFA-X');
    expect(c.priceMatrix).toEqual({ '30': { P1: 100000, P2: 120000 } });
  });

  test('falls back to the code as supplier_sku when the sheet has none', () => {
    const rows = [['RAW-9', '', 'other', '', '', '3.00', '', '', '']];
    const creates = buildCreates(rows, LONG_HEADER, 'long', new Map(), new Map(), []);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.supplierSku).toBe('RAW-9');
  });

  test('detectImportFormat picks long when price_rm present', () => {
    expect(detectImportFormat(LONG_HEADER)).toBe('long');
    expect(detectImportFormat(['internal_code', 'unit_price_rm'])).toBe('wide');
  });
});
