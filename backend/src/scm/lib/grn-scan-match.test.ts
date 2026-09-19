// Unit tests for the GR scan matcher — the safety-critical core that decides
// which open PO line(s) a scanned delivery order clears. The invariant under
// test: a scanned line becomes a `pick` ONLY when it resolves to EXACTLY ONE
// open PO line; zero or many leave it UNMATCHED, and nothing is ever guessed.
import { describe, expect, test } from 'vitest';
import {
  matchGrnScanToPoLines,
  normalizeCode,
  type OpenPoLine,
  type SupplierSkuBinding,
  type ScannedGrnLine,
} from './grn-scan-match';

const line = (over: Partial<OpenPoLine> = {}): OpenPoLine => ({
  poItemId: 'pi-1',
  poId: 'po-1',
  poNumber: 'HC-PO-2609-166',
  supplierId: 'sup-1',
  itemCode: '9050-2B(RHF)',
  materialName: 'Sofa 2B',
  supplierSku: null,
  remaining: 5,
  ...over,
});

const scan = (over: Partial<ScannedGrnLine> = {}): ScannedGrnLine => ({
  itemCode: null,
  barcode: null,
  description: null,
  qty: 1,
  ...over,
});

describe('normalizeCode', () => {
  test('uppercases and strips non-alnum', () => {
    expect(normalizeCode('HC-PO-2609-166')).toBe('HCPO2609166');
    expect(normalizeCode('9050-2B(RHF)')).toBe('90502BRHF');
    expect(normalizeCode('AMN-SF9050 SOFA 2B(RHF)')).toBe('AMNSF9050SOFA2BRHF');
    expect(normalizeCode(null)).toBe('');
  });
});

describe('matchGrnScanToPoLines', () => {
  test('direct item_code match -> confident pick, qty clamped to remaining', () => {
    const res = matchGrnScanToPoLines(
      'PO-010070',
      [scan({ itemCode: '9050-2B(RHF)', qty: 10 })],
      [line({ remaining: 3 })],
      [],
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 3 }]);
    expect(res.unmatched).toHaveLength(0);
    expect(res.poNumberMatched).toBe(false); // PO-010070 != HC-PO-2609-166
    expect(res.matchedPoNumbers).toEqual(['HC-PO-2609-166']);
  });

  test('supplier Article No resolves via binding -> our item code', () => {
    const bindings: SupplierSkuBinding[] = [
      { supplierSku: 'AMN-SF9050 SOFA 2B(RHF)', acItemCode: null, itemCode: '9050-2B(RHF)' },
    ];
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: 'AMN-SF9050 SOFA 2B(RHF)', qty: 2 })],
      [line({ remaining: 5 })],
      bindings,
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 2 }]);
  });

  test('barcode resolves via binding', () => {
    const bindings: SupplierSkuBinding[] = [
      { supplierSku: '1234567890123', acItemCode: null, itemCode: '9050-2B(RHF)' },
    ];
    const res = matchGrnScanToPoLines(null, [scan({ barcode: '1234567890123', qty: 1 })], [line()], bindings);
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 1 }]);
  });

  test('matches the PO line by its OWN supplier_sku', () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: 'AMN-SF9050 SOFA 2B(RHF)', qty: 1 })],
      [line({ supplierSku: 'AMN-SF9050 SOFA 2B(RHF)', itemCode: 'X-DIFFERENT' })],
      [],
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 1 }]);
  });

  test('PO-number match scopes matching to that PO', () => {
    const res = matchGrnScanToPoLines(
      'HC-PO-2609-166',
      [scan({ itemCode: '9050-2B(RHF)', qty: 1 })],
      [
        line({ poItemId: 'pi-A', poNumber: 'HC-PO-2609-166', itemCode: '9050-2B(RHF)' }),
        line({ poItemId: 'pi-B', poNumber: 'HC-PO-2609-999', itemCode: '9050-2B(RHF)' }),
      ],
      [],
    );
    // Two POs carry the same item code, but the scanned PO No pins it to one —
    // so it is UNAMBIGUOUS, not a many-match.
    expect(res.poNumberMatched).toBe(true);
    expect(res.matchedPoNumberValue).toBe('HC-PO-2609-166');
    expect(res.picks).toEqual([{ poItemId: 'pi-A', qty: 1 }]);
  });

  test('no matching open line -> unmatched, no pick (never fabricates)', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: 'NOPE', qty: 1 })], [line()], []);
    expect(res.picks).toEqual([]);
    expect(res.unmatched).toEqual([
      { line: expect.objectContaining({ itemCode: 'NOPE' }), reason: 'no_open_po_line', candidatePoItemIds: [] },
    ]);
  });

  test('ambiguous many-match (no PO scope) -> unmatched, never guesses', () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: '9050-2B(RHF)', qty: 1 })],
      [
        line({ poItemId: 'pi-A', poNumber: 'HC-PO-2609-1', itemCode: '9050-2B(RHF)' }),
        line({ poItemId: 'pi-B', poNumber: 'HC-PO-2609-2', itemCode: '9050-2B(RHF)' }),
      ],
      [],
    );
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].reason).toBe('ambiguous');
    expect(res.unmatched[0].candidatePoItemIds.sort()).toEqual(['pi-A', 'pi-B']);
  });

  test('a fully-received PO line (zero remaining) is not picked', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '9050-2B(RHF)', qty: 1 })], [line({ remaining: 0 })], []);
    // remaining 0 is excluded by the loader in production; the matcher guards it too.
    // With no in-scope line, this is a no_open_po_line miss.
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].line.itemCode).toBe('9050-2B(RHF)');
  });

  test('two scanned lines for the same PO line sum, then clamp to remaining', () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: '9050-2B(RHF)', qty: 2 }), scan({ itemCode: '9050-2B(RHF)', qty: 3 })],
      [line({ remaining: 4 })],
      [],
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 4 }]);
  });

  test('zero/blank qty line carries nothing', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '9050-2B(RHF)', qty: 0 })], [line()], []);
    expect(res.picks).toEqual([]);
    expect(res.unmatched).toHaveLength(0);
  });

  test('a supplier SKU mapping to two item codes is dropped (never guessed)', () => {
    const bindings: SupplierSkuBinding[] = [
      { supplierSku: 'AMB', acItemCode: null, itemCode: 'CODE-A' },
      { supplierSku: 'AMB', acItemCode: null, itemCode: 'CODE-B' },
    ];
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: 'AMB', qty: 1 })],
      [line({ poItemId: 'pi-A', itemCode: 'CODE-A' }), line({ poItemId: 'pi-B', itemCode: 'CODE-B' })],
      bindings,
    );
    // Both item codes resolve, so the scanned line hits TWO open lines -> ambiguous.
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].reason).toBe('ambiguous');
  });
});
