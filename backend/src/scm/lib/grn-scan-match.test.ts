// Unit tests for the GR scan matcher — the safety-critical core that decides
// which open PO line(s) a scanned delivery order clears. The invariant under
// test: a scanned line becomes a `pick` ONLY when it resolves to EXACTLY ONE
// open PO line; zero or many leave it UNMATCHED, and nothing is ever guessed.
import { describe, expect, test } from 'vitest';
import {
  describeUnmatchedScanLines,
  listScanLines,
  matchGrnScanToPoLines,
  nameMatchItem,
  normalizeCode,
  pickBySpec,
  normalizeSupplierName,
  resolvePrintedPo,
  resolveScannedSupplier,
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
  locationCode: null,
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
      'sup-1',
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
      'sup-1',
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 2 }]);
  });

  test('barcode resolves via binding', () => {
    const bindings: SupplierSkuBinding[] = [
      { supplierSku: '1234567890123', acItemCode: null, itemCode: '9050-2B(RHF)' },
    ];
    const res = matchGrnScanToPoLines(null, [scan({ barcode: '1234567890123', qty: 1 })], [line()], bindings, 'sup-1');
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 1 }]);
  });

  test('matches the PO line by its OWN supplier_sku', () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: 'AMN-SF9050 SOFA 2B(RHF)', qty: 1 })],
      [line({ supplierSku: 'AMN-SF9050 SOFA 2B(RHF)', itemCode: 'X-DIFFERENT' })],
      [],
      'sup-1',
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
      'sup-1',
    );
    // Two POs carry the same item code, but the scanned PO No pins it to one —
    // so it is UNAMBIGUOUS, not a many-match.
    expect(res.poNumberMatched).toBe(true);
    expect(res.matchedPoNumberValue).toBe('HC-PO-2609-166');
    expect(res.picks).toEqual([{ poItemId: 'pi-A', qty: 1 }]);
  });

  test('no matching open line -> unmatched, no pick (never fabricates)', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: 'NOPE', qty: 1 })], [line()], [], 'sup-1');
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
      'sup-1',
    );
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].reason).toBe('ambiguous');
    expect(res.unmatched[0].candidatePoItemIds.sort()).toEqual(['pi-A', 'pi-B']);
  });

  test('a fully-received PO line (zero remaining) is not picked', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '9050-2B(RHF)', qty: 1 })], [line({ remaining: 0 })], [], 'sup-1');
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
      'sup-1',
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 4 }]);
  });

  test('zero/blank qty line carries nothing', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '9050-2B(RHF)', qty: 0 })], [line()], [], 'sup-1');
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
      'sup-1',
    );
    // Both item codes resolve, so the scanned line hits TWO open lines -> ambiguous.
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].reason).toBe('ambiguous');
  });

  // Regression: a Hookka delivery order with 6 lines where only 1 item code hit
  // any open PO line company-wide became a GRN against the wrong PO, and once
  // posted it flipped that PO's sales order to READY.
  test('one stray hit out of six lines becomes a draft flagged as a weak match', () => {
    const res = matchGrnScanToPoLines(
      'PO-010070',
      [
        scan({ itemCode: '9050-2B(RHF)', qty: 1 }),
        scan({ itemCode: 'U1', qty: 1 }), scan({ itemCode: 'U2', qty: 1 }),
        scan({ itemCode: 'U3', qty: 1 }), scan({ itemCode: 'U4', qty: 1 }),
        scan({ itemCode: 'U5', qty: 1 }),
      ],
      [line()],
      [],
      'sup-1',
    );
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 1 }]);
    expect(res.refused).toBeNull();
    expect(res.weakMatch).toEqual({ matched: 1, scanned: 6 });
    expect(res.unmatched).toHaveLength(5);
  });

  test("another supplier's PO line is never a candidate", () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: '9050-2B(RHF)', qty: 1 })],
      [line({ supplierId: 'sup-OTHER' })],
      [],
      'sup-1',
    );
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].reason).toBe('no_open_po_line');
  });

  test('unresolved supplier and no PO-number hit -> refused', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '9050-2B(RHF)', qty: 1 })], [line()], [], null);
    expect(res.picks).toEqual([]);
    expect(res.refused).toBe('supplier_unknown');
  });

  test('our PO number printed on the DO still converts with an unresolved supplier', () => {
    const res = matchGrnScanToPoLines('HC-PO-2609-166', [scan({ itemCode: '9050-2B(RHF)', qty: 1 })], [line()], [], null);
    expect(res.refused).toBeNull();
    expect(res.picks).toEqual([{ poItemId: 'pi-1', qty: 1 }]);
  });

  test('our PO number belonging to a different supplier -> no pick', () => {
    const res = matchGrnScanToPoLines(
      'HC-PO-2609-166',
      [scan({ itemCode: '9050-2B(RHF)', qty: 1 })],
      [line({ supplierId: 'sup-OTHER' })],
      [],
      'sup-1',
    );
    expect(res.poNumberMatched).toBe(false);
    expect(res.picks).toEqual([]);
  });

  test('hits spread over two POs without a PO-number hit -> refused', () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: 'A', qty: 1 }), scan({ itemCode: 'B', qty: 1 })],
      [
        line({ poItemId: 'pi-A', poNumber: 'HC-PO-2609-1', itemCode: 'A' }),
        line({ poItemId: 'pi-B', poNumber: 'HC-PO-2609-2', itemCode: 'B' }),
      ],
      [],
      'sup-1',
    );
    expect(res.picks).toEqual([]);
    expect(res.refused).toBe('multiple_pos');
  });

  test('most lines on one PO -> draft, the stray line left for the operator', () => {
    const res = matchGrnScanToPoLines(
      null,
      [scan({ itemCode: 'A', qty: 1 }), scan({ itemCode: 'B', qty: 2 }), scan({ itemCode: 'NOPE', qty: 1 })],
      [line({ poItemId: 'pi-A', itemCode: 'A' }), line({ poItemId: 'pi-B', itemCode: 'B' })],
      [],
      'sup-1',
    );
    expect(res.refused).toBeNull();
    expect(res.picks).toEqual([{ poItemId: 'pi-A', qty: 1 }, { poItemId: 'pi-B', qty: 2 }]);
    expect(res.unmatched).toHaveLength(1);
  });
});

// DO-2609-097 (Hookka, 2026-09-30): one delivery order, no header P.O., each row
// printing its own PO. Row 1 is a fair/service item whose PO (ART-HOK-002) is not
// ours. The old read dropped the per-row POs, item-matched row 1 onto a
// customer's ELEPHANE line on HC-PO-2609-263, and received none of the five
// JAGER rows. Shapes copied from production.
describe('matchGrnScanToPoLines — a PO number printed per row', () => {
  const hookkaOpen: OpenPoLine[] = [
    line({ poItemId: 'pi-263-K', poNumber: 'HC-PO-2609-263', itemCode: 'ELEPHANE-(K)', supplierSku: 'HOK-2003-(K)', remaining: 1 }),
    line({ poItemId: 'pi-263-Q', poNumber: 'HC-PO-2609-263', itemCode: 'ELEPHANE-(Q)', supplierSku: 'HOK-2003-(Q)', remaining: 2 }),
    line({ poItemId: 'pi-148', poNumber: 'HC-PO-2609-148', itemCode: 'JAGER-(Q)', supplierSku: '1013-(Q)', remaining: 1 }),
    line({ poItemId: 'pi-150', poNumber: 'HC-PO-2609-150', itemCode: 'JAGER-(Q)', supplierSku: '1013-(Q)', remaining: 1 }),
    line({ poItemId: 'pi-152', poNumber: 'HC-PO-2609-152', itemCode: 'JAGER-(Q)', supplierSku: '1013-(Q)', remaining: 1 }),
    line({ poItemId: 'pi-192', poNumber: 'HC-PO-2609-192', itemCode: 'JAGER-(K)', supplierSku: '1013-(K)', remaining: 1 }),
    line({ poItemId: 'pi-193', poNumber: 'HC-PO-2609-193', itemCode: 'JAGER-(SS)', supplierSku: '1013-(SS)', remaining: 1 }),
  ];
  const hookkaBindings: SupplierSkuBinding[] = [{ supplierSku: '2003-(K)', acItemCode: null, itemCode: 'ELEPHANE-(K)' }];
  const do097 = (withRowPo: boolean): ScannedGrnLine[] => [
    ['2003-(K)', 'ART-HOK-002'],
    ['1013-(Q)', 'HC-PO-2609-148'],
    ['1013-(Q)', 'HC-PO-2609-150'],
    ['1013-(Q)', 'HC-PO-2609-152'],
    ['1013-(K)', 'HC-PO-2609-192'],
    ['1013-(SS)', 'HC-PO-2609-193'],
  ].map(([itemCode, poNo]) => scan({ itemCode, qty: 1, poNo: withRowPo ? poNo : null }));

  test('each row lands on its own PO; the fair item is never put on a customer PO', () => {
    const res = matchGrnScanToPoLines(null, do097(true), hookkaOpen, hookkaBindings, 'sup-1');
    expect(res.refused).toBeNull();
    expect(res.picks).toEqual([
      { poItemId: 'pi-148', qty: 1 },
      { poItemId: 'pi-150', qty: 1 },
      { poItemId: 'pi-152', qty: 1 },
      { poItemId: 'pi-192', qty: 1 },
      { poItemId: 'pi-193', qty: 1 },
    ]);
    expect(res.picks.map((p) => p.poItemId)).not.toContain('pi-263-K');
    expect(res.unmatched).toEqual([
      { line: do097(true)[0], reason: 'po_not_open', candidatePoItemIds: [] },
    ]);
    expect(res.matchedPoNumbers).toEqual([
      'HC-PO-2609-148', 'HC-PO-2609-150', 'HC-PO-2609-152', 'HC-PO-2609-192', 'HC-PO-2609-193',
    ]);
  });

  test('the same document read without the row POs is refused, not half-received', () => {
    const res = matchGrnScanToPoLines(null, do097(false), hookkaOpen, hookkaBindings, 'sup-1');
    expect(res.picks).toEqual([]);
    expect(res.refused).not.toBeNull();
  });

  test('a row with no PO beside rows that name theirs is left for the operator', () => {
    const lines = [...do097(true).slice(1), scan({ itemCode: '2003-(K)', qty: 1 })];
    const res = matchGrnScanToPoLines(null, lines, hookkaOpen, hookkaBindings, 'sup-1');
    expect(res.picks).toHaveLength(5);
    expect(res.picks.map((p) => p.poItemId)).not.toContain('pi-263-K');
    expect(res.unmatched).toEqual([{ line: lines[5], reason: 'no_po_number', candidatePoItemIds: [] }]);
  });

  test('a printed PO that is not open (already received) is never item-matched elsewhere', () => {
    const open = hookkaOpen.filter((l) => l.poNumber !== 'HC-PO-2609-148');
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '1013-(Q)', qty: 1, poNo: 'HC-PO-2609-148' })], open, [], 'sup-1');
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0].reason).toBe('po_not_open');
  });

  test('a row PO narrows an otherwise ambiguous item code to that PO', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: '1013-(Q)', qty: 1, poNo: 'hc po 2609 150' })], hookkaOpen, [], 'sup-1');
    expect(res.picks).toEqual([{ poItemId: 'pi-150', qty: 1 }]);
  });
});

describe('resolveScannedSupplier', () => {
  const suppliers = [
    { id: 'hookka', code: '400-H004', name: 'HOOKKA INDUSTRIES SDN. BHD.' },
    { id: 'diglant', code: '400-D001', name: 'DIGLANT SDN BHD' },
    { id: 'home-a', code: null, name: 'HOME LIVING FURNITURE SDN BHD' },
    { id: 'home-b', code: null, name: 'HOME LIVING TRADING' },
  ];

  test('name normalisation drops punctuation, (M) and the legal suffix', () => {
    expect(normalizeSupplierName('Hookka Industries (M) Sdn. Bhd.')).toBe('HOOKKAINDUSTRIES');
  });

  test('exact name, code, and letterhead with a registration number', () => {
    expect(resolveScannedSupplier('Hookka Industries Sdn Bhd', suppliers)).toBe('hookka');
    expect(resolveScannedSupplier('400-H004', suppliers)).toBe('hookka');
    expect(resolveScannedSupplier('DIGLANT SDN BHD (1234567-X)', suppliers)).toBe('diglant');
  });

  test('unknown, blank or ambiguous -> null', () => {
    expect(resolveScannedSupplier('SOMEONE ELSE SDN BHD', suppliers)).toBeNull();
    expect(resolveScannedSupplier(null, suppliers)).toBeNull();
    expect(resolveScannedSupplier('HOME LIVING', suppliers)).toBeNull();
  });
});

describe('describeUnmatchedScanLines (BUG-61: the draft says what to add)', () => {
  test('null when every scanned line matched', () => {
    expect(describeUnmatchedScanLines([], [])).toBeNull();
  });

  test('names each left-off line with its qty and why', () => {
    const note = describeUnmatchedScanLines([
      { line: scan({ itemCode: 'AMN-SF9050', description: 'SOFA 2B(RHF)', qty: 2 }), reason: 'no_open_po_line', candidatePoItemIds: [] },
      { line: scan({ itemCode: 'HB-01', qty: 1, poNo: 'ART-HOK-002' }), reason: 'po_not_open', candidatePoItemIds: [] },
      { line: scan({ barcode: '955000111', qty: 3 }), reason: 'ambiguous', candidatePoItemIds: ['a', 'b'] },
    ], []);
    expect(note).toBe(
      'AMN-SF9050 SOFA 2B(RHF) x2 (no open PO line); '
      + 'HB-01 x1 (PO ART-HOK-002 is not one of our POs); 955000111 x3 (more than one PO line fits).',
    );
  });

  test('caps a long list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      line: scan({ itemCode: `X${i}`, qty: 1 }), reason: 'no_open_po_line' as const, candidatePoItemIds: [],
    }));
    expect(describeUnmatchedScanLines(many, [], 10)).toMatch(/X9 x1 \(no open PO line\); and 2 more\.$/);
  });
});

describe('resolvePrintedPo: suppliers print our PO without the company prefix', () => {
  const pos = [{ poNumber: 'HC-PO-2609-223' }, { poNumber: 'HC-PO-010080' }, { poNumber: 'HC-PO-2609-251' }];

  test('exact, and a unique tail of 6+ digits', () => {
    expect(resolvePrintedPo('hc po 2609 223', pos, true)?.poNumber).toBe('HC-PO-2609-223');
    expect(resolvePrintedPo('PO-2609-223', pos, true)?.poNumber).toBe('HC-PO-2609-223');
    expect(resolvePrintedPo('PO: 2609-251', pos, true)?.poNumber).toBe('HC-PO-2609-251');
    expect(resolvePrintedPo('PO-010080', pos, true)?.poNumber).toBe('HC-PO-010080');
  });

  test('short, foreign or ambiguous numbers resolve to nothing', () => {
    expect(resolvePrintedPo('251', pos, true)).toBeNull();
    expect(resolvePrintedPo('S/O1791', pos, true)).toBeNull();
    expect(resolvePrintedPo('KLPO10138-HC5324', pos, true)).toBeNull();
    expect(resolvePrintedPo(null, pos, true)).toBeNull();
    const twoCompanies = [{ poNumber: 'HC-PO-2609-223' }, { poNumber: 'XX-PO-2609-223' }];
    expect(resolvePrintedPo('PO-2609-223', twoCompanies, true)).toBeNull();
  });

  test('without allowTail only the exact number resolves', () => {
    expect(resolvePrintedPo('PO-2609-223', pos, false)).toBeNull();
    expect(resolvePrintedPo('HC-PO-2609-223', pos, false)?.poNumber).toBe('HC-PO-2609-223');
  });
});

describe('a delivery order that names its PO but describes the items differently', () => {
  // Dorsettloft DO-2610-009: rows print "PO-010080" (our HC-PO-010080) and
  // describe sets ("3SEATER (2+1)") that are not our PO line codes.
  const po010080: OpenPoLine[] = [
    line({ poItemId: 'pi-2A', poNumber: 'HC-PO-010080', itemCode: '9058-2A(LHF)', supplierSku: 'DSL-9058 SOFA 2A(LHF)', remaining: 1 }),
    line({ poItemId: 'pi-1A', poNumber: 'HC-PO-010080', itemCode: '9058-1A(RHF)', supplierSku: 'DSL-9058 SOFA 1A(RHF)', remaining: 1 }),
    line({ poItemId: 'pi-2S', poNumber: 'HC-PO-010080', itemCode: '9058-2S', supplierSku: 'DSL-9058 SOFA 2S', remaining: 1 }),
    line({ poItemId: 'pi-done', poNumber: 'HC-PO-010080', itemCode: '8051-1S', remaining: 0 }),
    line({ poItemId: 'pi-other', poNumber: 'HC-PO-2610-001', itemCode: 'X', remaining: 4 }),
  ];
  const do009 = [
    scan({ itemCode: 'DSL9058(30")-3SEATER (2+1)', qty: 1, poNo: 'PO-010080' }),
    scan({ itemCode: 'DSL9058(30")-1EFL+1B', qty: 1, poNo: 'PO-010080' }),
    scan({ itemCode: 'DSL8051(30")-1 SEATER', qty: 1, poNo: 'PO-010080' }),
  ];

  test('drafts every line still owed on that PO, flagged for the operator', () => {
    const res = matchGrnScanToPoLines('S/O1791', do009, po010080, [], 'sup-1');
    expect(res.poFallback).toBe('HC-PO-010080');
    expect(res.picks).toEqual([
      { poItemId: 'pi-2A', qty: 1 },
      { poItemId: 'pi-1A', qty: 1 },
      { poItemId: 'pi-2S', qty: 1 },
    ]);
    expect(res.matchedPoNumbers).toEqual(['HC-PO-010080']);
  });

  test('no draft from the PO number alone when the supplier is unknown', () => {
    const res = matchGrnScanToPoLines('S/O1791', do009, po010080, [], null);
    expect(res.poFallback).toBeNull();
    expect(res.picks).toEqual([]);
  });

  test('no draft from two named POs when the delivery order qty is not what they owe', () => {
    // 1 listed against HC-PO-010080 (owes 3), 1 against HC-PO-2610-001 (owes 4).
    const lines = [do009[0], scan({ itemCode: 'Y', qty: 1, poNo: 'PO-2610-001' })];
    const res = matchGrnScanToPoLines(null, lines, po010080, [], 'sup-1');
    expect(res.poFallback).toBeNull();
    expect(res.picks).toEqual([]);
  });

  test('an item hit on the named PO is a normal draft, not the whole PO', () => {
    const lines = [...do009, scan({ itemCode: 'DSL-9058 SOFA 2S', qty: 1, poNo: 'PO-010080' })];
    const res = matchGrnScanToPoLines(null, lines, po010080, [], 'sup-1');
    expect(res.poFallback).toBeNull();
    expect(res.picks).toEqual([{ poItemId: 'pi-2S', qty: 1 }]);
  });

  test('the draft note lists the delivery order as read', () => {
    expect(listScanLines(do009)).toBe('DSL9058(30")-3SEATER (2+1) x1; DSL9058(30")-1EFL+1B x1; DSL8051(30")-1 SEATER x1.');
  });
});

describe('a delivery order whose POs are marked Received says so', () => {
  // NB Furniture NBF2610-095: received by hand on HC-GRN-2610-011, so its POs
  // are no longer open. Nothing is drafted; each row says why.
  const allPos = [
    { poNumber: 'HC-PO-2609-223', status: 'RECEIVED' },
    { poNumber: 'HC-PO-2609-251', status: 'RECEIVED' },
    { poNumber: 'HC-PO-2610-009', status: 'SUBMITTED' },
  ];

  test('rows on received POs are refused with the PO and its status', () => {
    const lines = [
      scan({ itemCode: 'SB10-KHB(H)(9MM)(L-4")-LSD013', qty: 2, poNo: 'PO-2609-223' }),
      scan({ itemCode: 'SB10-KHB(H)(9MM)-LSD013', qty: 2, poNo: '2609-251' }),
      scan({ itemCode: 'SB10-B11EC', qty: 1, poNo: 'KLPO10138-HC5324' }),
    ];
    const res = matchGrnScanToPoLines(null, lines, [line({ poNumber: 'HC-PO-2610-009' })], [], 'sup-1');
    expect(res.picks).toEqual([]);
    expect(res.poFallback).toBeNull();
    expect(describeUnmatchedScanLines(res.unmatched, allPos)).toBe(
      'SB10-KHB(H)(9MM)(L-4")-LSD013 x2 (PO HC-PO-2609-223 is marked Received); '
      + 'SB10-KHB(H)(9MM)-LSD013 x2 (PO HC-PO-2609-251 is marked Received); '
      + 'SB10-B11EC x1 (PO KLPO10138-HC5324 is not one of our POs).',
    );
  });
});

// NB Furniture NBF2610-256 (2026-10-07) printed our POs with the ship-to
// location in place of "HC-PO": SRW-2610-021 is HC-PO-2610-021 into SRW
// WAREHOUSE, KL-2609-352 is HC-PO-2609-352 into KL WAREHOUSE. Every row was
// refused as "not one of our POs" although supplier, items and qty all agreed.
describe('a PO printed with the ship-to location in front (NBF2610-256)', () => {
  const open: OpenPoLine[] = [
    line({ poItemId: 'pi-cody', poNumber: 'HC-PO-2610-021', itemCode: 'CODY-(Q)', supplierSku: 'NB-KHJ57(Q)', remaining: 1, locationCode: 'SRW WAREHOUSE' }),
    line({ poItemId: 'pi-jager', poNumber: 'HC-PO-2609-352', itemCode: 'JAGER-(K)', remaining: 1, locationCode: 'KL WAREHOUSE' }),
    line({ poItemId: 'pi-nb01', poNumber: 'HC-PO-2609-352', itemCode: 'NB01-(K)', remaining: 1, locationCode: 'KL WAREHOUSE' }),
  ];
  const do256 = [
    scan({ itemCode: 'SB10-KHL(L)(D)(L-2")-KHJ57(MH-10")', qty: 1, poNo: 'SRW-2610-021' }),
    scan({ itemCode: 'SB12-KHB(C)-NB01(MH-12")', qty: 1, poNo: 'KL-2609-352' }),
    scan({ itemCode: 'SB12-KHB(H)(9MM)-LSD013', qty: 1, poNo: 'KL-2609-352' }),
  ];

  test('resolves both POs and drafts what they owe, since the quantities agree', () => {
    const res = matchGrnScanToPoLines(null, do256, open, [], 'sup-1');
    expect(res.poFallback).toBe('HC-PO-2610-021, HC-PO-2609-352');
    expect(res.picks).toEqual([
      { poItemId: 'pi-cody', qty: 1 },
      { poItemId: 'pi-jager', qty: 1 },
      { poItemId: 'pi-nb01', qty: 1 },
    ]);
  });

  test('a location that is not where the PO ships is still not our PO', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: 'X', qty: 1, poNo: 'KL-2610-021' })], open, [], 'sup-1');
    expect(res.picks).toEqual([]);
    expect(res.unmatched.map((u) => u.reason)).toEqual(['po_not_open']);
  });

  test('never for an unknown supplier', () => {
    const res = matchGrnScanToPoLines(null, do256, open, [], null);
    expect(res.picks).toEqual([]);
    expect(res.unmatched.map((u) => u.reason)).toEqual(['po_not_open', 'po_not_open', 'po_not_open']);
  });

  test('a part delivery across two POs is left to the operator', () => {
    const res = matchGrnScanToPoLines(null, do256.slice(0, 2), open, [], 'sup-1');
    expect(res.poFallback).toBeNull();
    expect(res.picks).toEqual([]);
  });

  test('an item hit still drafts only the matched row', () => {
    const lines = [scan({ itemCode: 'NB-KHJ57(Q)', qty: 1, poNo: 'SRW-2610-021' }), do256[1]];
    const res = matchGrnScanToPoLines(null, lines, open, [], 'sup-1');
    expect(res.poFallback).toBeNull();
    expect(res.picks).toEqual([{ poItemId: 'pi-cody', qty: 1 }]);
  });
});

// BUG-108 (2026-10-12, Sim): DO-2610/034 printed "PO-HC-PO-2609-169", our whole
// number behind a "PO-" label. Neither exact nor tail matched, so the slip was
// refused as "not one of our POs".
describe('our whole PO number printed behind a label (DO-2610/034)', () => {
  const open: OpenPoLine[] = [
    line({ poItemId: 'pi-9050', poNumber: 'HC-PO-2609-169', itemCode: '9050-1EPL+1B', remaining: 1 }),
    line({ poItemId: 'pi-other', poNumber: 'HC-PO-2609-170', itemCode: 'X', remaining: 2 }),
  ];
  const do034 = [scan({
    itemCode: 'SF9050',
    description: 'SF9050 - 1EPL + 1B (32") * COL: HR805-10 * SEAT 32 / LEG 1" * BOTTOM COVER UMBRELLA FABRIC',
    qty: 1,
    poNo: 'PO-HC-PO-2609-169',
  })];

  test('resolves to that PO, with or without allowTail', () => {
    const pos = [{ poNumber: 'HC-PO-2609-169' }, { poNumber: 'HC-PO-2609-170' }];
    expect(resolvePrintedPo('PO-HC-PO-2609-169', pos, true)?.poNumber).toBe('HC-PO-2609-169');
    expect(resolvePrintedPo('PO: HC-PO-2609-169', pos, false)?.poNumber).toBe('HC-PO-2609-169');
    expect(resolvePrintedPo('PO-HC-PO-2609-16', pos, true)).toBeNull();
  });

  test('drafts what the PO owes for a known supplier', () => {
    const res = matchGrnScanToPoLines(null, do034, open, [], 'sup-1');
    expect(res.poFallback).toBe('HC-PO-2609-169');
    expect(res.picks).toEqual([{ poItemId: 'pi-9050', qty: 1 }]);
  });

  test('a received PO says so instead of "not one of our POs"', () => {
    const res = matchGrnScanToPoLines(null, do034, [open[1]], [], 'sup-1');
    expect(res.picks).toEqual([]);
    expect(describeUnmatchedScanLines(res.unmatched, [{ poNumber: 'HC-PO-2609-169', status: 'RECEIVED' }]))
      .toMatch(/\(PO HC-PO-2609-169 is marked Received\)\.$/);
  });
});

// DEV-68 (2026-10-12, Sim): Hookka DO-2610-030 row "JAGER (Q) PC151-01 / GAP 11""
// was left off GRN HC-GRN-2610-067 as "more than one PO line fits": PO
// HC-PO-2609-320 holds HOK-1013-(Q) twice, fabric PC151-01 and PC151-02.
describe('same item code on several PO lines: the printed spec breaks the tie (DO-2610-030)', () => {
  const jager = (poItemId: string, poNumber: string, description2: string) =>
    line({ poItemId, poNumber, supplierId: 'sup-hok', itemCode: 'HOK-1013-(Q)', remaining: 1, description2 });
  const a320 = jager('pi-320a', 'HC-PO-2609-320', 'PC151-01 / DIVAN 8" + LEG 2" / GAP 11" / T.Heights 21"');
  const b320 = jager('pi-320b', 'HC-PO-2609-320', 'PC151-02 / DIVAN 8" + LEG 2" / GAP 11" / T.Heights 21"');
  const l319 = jager('pi-319', 'HC-PO-2609-319', 'PC151-01 / DIVAN 8" + LEG 2" / GAP 10" / T.Heights 20" / SPECIAL: HB Fully Cover');
  const l321 = jager('pi-321', 'HC-PO-2609-321', 'PC151-01 / DIVAN 8" + NO LEG / GAP 8" / T.Heights 16"');
  // As the scan read it (GRN 2610-067 note): item name in front, "2" LEG" word order.
  const row = '1013-(Q) JAGER BEDFRAME (5FT) (152X190CM) PC151-01 / DIVAN 8" + 2" LEG / GAP 11" / T.Heights 21"';

  test('anchored to PO 320: the PC151-01 line, not PC151-02', () => {
    const res = matchGrnScanToPoLines(null, [scan({ itemCode: 'HOK-1013-(Q)', description: row, poNo: 'HC-PO-2609-320' })], [a320, b320], [], 'sup-hok');
    expect(res.picks).toEqual([{ poItemId: 'pi-320a', qty: 1 }]);
    expect(res.unmatched).toEqual([]);
  });

  test('no row PO, four same-code lines across POs: still the PO 320 PC151-01 line', () => {
    expect(pickBySpec(row, [l319, l321, a320, b320])?.poItemId).toBe('pi-320a');
  });

  test('a tie or no printed spec stays ambiguous', () => {
    expect(pickBySpec('JAGER BEDFRAME', [a320, b320])).toBeNull();
    expect(pickBySpec(null, [a320, b320])).toBeNull();
    expect(pickBySpec(row, [a320, { ...a320, poItemId: 'pi-twin' }])).toBeNull();
  });

  test('whole words only: "GAP 1" does not count as "GAP 11"', () => {
    const gap1 = jager('pi-gap1', 'HC-PO-2609-330', 'PC151-03 / GAP 1"');
    const gap12 = jager('pi-gap12', 'HC-PO-2609-330', 'PC151-03 / GAP 12"');
    expect(pickBySpec('PC151-03 / GAP 11"', [gap1, gap12])).toBeNull();
  });
});

// HC-0120 (2026-10-19, Sim): DIGLANT DGSN26002266 delivered 7 mattresses (plus
// 12 free pillows) on HC-PO-2610-084, which still owed 15 lines of one each.
// DIGLANT prints its own codes (T1MAMWA0MK ...), so no row matched by code and
// the draft took all 15. Rows now match the PO by product name; what no name
// matches is reported, and a whole-PO draft needs the qty to agree.
describe("a named PO whose delivery order prints the supplier's own codes (DGSN26002266)", () => {
  const mk = (n: number, itemCode: string, materialName: string): OpenPoLine =>
    line({ poItemId: `pi-${n}`, poNumber: 'HC-PO-2610-084', itemCode, materialName, remaining: 1 });
  // HC-PO-2610-084 as read from production on 2026-10-19.
  const open: OpenPoLine[] = [
    mk(1, 'AKEMI ULTIMATE MATT (K)', 'AKEMI ULTIMATE MATTRESS (183X190X36CM)'),
    mk(2, 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATTRESS (152X190CM)'),
    mk(3, 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATTRESS (152X190CM)'),
    mk(4, 'AKEMI ULTIMATE MATT (K)', 'AKEMI ULTIMATE MATTRESS (183X190X36CM)'),
    mk(5, 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATTRESS (152X190CM)'),
    mk(6, 'AKEMI ARMOUR MATT (K)', 'AKEMI ARMOUR MATTRESS (183X190X30CM)'),
    mk(7, 'AKEMI BULWARK MATT (K)', 'AKEMI BULWARK MATTRESS (183X190X36CM)'),
    mk(8, 'AKEMI ULTIMATE MATT (K)', 'AKEMI ULTIMATE MATTRESS (183X190X36CM)'),
    mk(9, 'AKEMI BULWARK MATT (K)', 'AKEMI BULWARK MATTRESS (183X190X36CM)'),
    mk(10, 'AKEMI NOBILITY MATT (Q)', 'AKEMI NOBILITY MATTRESS (152X190X25CM)'),
    mk(11, 'AKEMI NOBILITY MATT (Q)', 'AKEMI NOBILITY MATTRESS (152X190X25CM)'),
    mk(12, 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATTRESS (152X190CM)'),
    mk(13, 'AKEMI ULTIMATE MATT (K)', 'AKEMI ULTIMATE MATTRESS (183X190X36CM)'),
    mk(14, 'AKEMI IMMORTAL MATT (K)', 'AKEMI IMMORTAL MATTRESS (183X190X36CM)'),
    mk(15, 'AKEMI BASTION MATT (Q)', 'AKEMI BASTION MATTRESS (152X190X25CM)'),
  ];
  // DGSN26002266 as read by the scanner (scm.grns.notes on HC-GRN-2610-134).
  const do266 = [
    scan({ itemCode: 'T1MAMWA0MK', description: 'Mattress Akemi Medi+Health Bulwark K King 183x190x36cm', qty: 1 }),
    scan({ itemCode: 'T1MAMWA0MK', description: 'Seremban Akemi Solo Aeon Sereman 2 14/4-26/4/26 Mattress Akemi Medi+Health Bulwark K King 183x190x36cm', qty: 1 }),
    scan({ itemCode: 'T1MPSIA0MQ', description: 'Mattress Happi Sleep Solitude Q Queen 153x190x30cm', qty: 1 }),
    scan({ itemCode: 'T1MPSIA0MQ', description: 'Sabah Akemi MegaHome @ Sabah International Convention Center 2/10/2026 to 4/10/2026 Mattress Happi Sleep Solitude Q Queen 153x190x30cm', qty: 1 }),
    scan({ itemCode: 'T1MPSIA0MQ', description: 'Penang Akemi HomeDec @ Setia Spice Convention Center 2/10/2026 to 4/10/2026 Mattress Happi Sleep Solitude Q Queen 153x190x30cm', qty: 1 }),
    scan({ itemCode: 'T1MPSIA0MQ', description: 'Johor Akemi Perfect Living @ MVEC Southkey 2/10/2026 to 4/10/2026 Mattress Happi Sleep Solitude Q Queen 153x190x30cm', qty: 1 }),
    scan({ itemCode: 'T1MAMHA0MK', description: 'Mattress Akemi Medi+Health Immortal K King 183x190x36cm', qty: 1 }),
    scan({ itemCode: 'AFKPAK25A23J29W', description: 'GWP Pillow Acc : Akemi Sleep Essentials 7 Holes Fibrefil Pil 48cm x 74cm', qty: 4 }),
    scan({ itemCode: 'UFHPHS13B25J29E', description: 'Happi Sleep Easy Sleep Pillow 48x74cm', qty: 8 }),
  ];

  test('drafts the 7 mattresses delivered, one PO line each, and leaves the pillows out', () => {
    const res = matchGrnScanToPoLines('PO2610084', do266, open, [], 'sup-1');
    expect(res.poFallback).toBeNull();
    expect(res.picks).toEqual([
      { poItemId: 'pi-7', qty: 1 }, { poItemId: 'pi-9', qty: 1 },
      { poItemId: 'pi-2', qty: 1 }, { poItemId: 'pi-3', qty: 1 }, { poItemId: 'pi-5', qty: 1 }, { poItemId: 'pi-12', qty: 1 },
      { poItemId: 'pi-14', qty: 1 },
    ]);
    expect(res.nameMatches.map((m) => m.itemCode)).toEqual([
      'AKEMI BULWARK MATT (K)', 'AKEMI BULWARK MATT (K)',
      'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATT (Q)', 'HAPPI SLEEP SOLITUDE MATT (Q)',
      'AKEMI IMMORTAL MATT (K)',
    ]);
    expect(res.namedPos).toEqual(['HC-PO-2610-084']);
    expect(res.unmatched.map((u) => [u.line.itemCode, u.reason])).toEqual([
      ['AFKPAK25A23J29W', 'not_on_po'],
      ['UFHPHS13B25J29E', 'not_on_po'],
    ]);
  });

  test('a row naming more of one item than the PO owes clamps to what it owes', () => {
    const res = matchGrnScanToPoLines('PO2610084', [scan({ description: 'Akemi Immortal K King', qty: 3 })], open, [], 'sup-1');
    expect(res.picks).toEqual([{ poItemId: 'pi-14', qty: 1 }]);
  });

  test('rows no name matches, with a qty that is not what the PO owes, make no draft', () => {
    const lines = [scan({ itemCode: 'T1X', qty: 7 }), scan({ itemCode: 'T1Y', qty: 12 })];
    const res = matchGrnScanToPoLines('PO2610084', lines, open, [], 'sup-1');
    expect(res.picks).toEqual([]);
    expect(res.poFallback).toBeNull();
    expect(res.qtyMismatch).toEqual([{ poNumber: 'HC-PO-2610-084', listed: 19, owed: 15 }]);
  });

  test('rows no name matches, listing exactly what the PO owes, still draft the PO', () => {
    const res = matchGrnScanToPoLines('PO2610084', [scan({ itemCode: 'T1X', qty: 15 })], open, [], 'sup-1');
    expect(res.poFallback).toBe('HC-PO-2610-084');
    expect(res.qtyMismatch).toBeNull();
    expect(res.picks).toHaveLength(15);
  });
});

// HC-0119 (2026-10-19, Sim): DGSN26002269, one mattress plus 2 free pillows on
// HC-PO-2610-162, which owes just that mattress.
describe('a single-item PO with a free gift on the delivery order (DGSN26002269)', () => {
  const open = [line({ poItemId: 'pi-elev', poNumber: 'HC-PO-2610-162', itemCode: 'AKEMI ELEVATION MATT (K)', materialName: 'AKEMI ELEVATION MATTRESS (183X190X30CM)', remaining: 1 })];
  const do269 = [
    scan({ itemCode: 'T1MAMLA0MK', description: 'Mattress Akemi Medi+Health Elevation K King 183x190x40cm', qty: 1 }),
    scan({ itemCode: 'AFKPAK25A23J29W', description: 'GWP Pillow Acc : Akemi Sleep Essentials 7 Holes Fibrefil Pil 48cm x 74cm', qty: 2 }),
  ];

  test('drafts the mattress and reports the pillow as not on the PO', () => {
    const res = matchGrnScanToPoLines('HC-PO-2610-162', do269, open, [], 'sup-1');
    expect(res.picks).toEqual([{ poItemId: 'pi-elev', qty: 1 }]);
    expect(describeUnmatchedScanLines(res.unmatched, [])).toBe(
      'AFKPAK25A23J29W GWP Pillow Acc : Akemi Sleep Essentials 7 Holes Fibrefil Pil 48cm x 74cm x2 (not on the PO).',
    );
  });
});

describe('nameMatchItem', () => {
  const po = [
    line({ itemCode: '9058-2S', materialName: 'SOFA MAYBATCH 2S' }),
    line({ itemCode: '9058-1A(RHF)', materialName: 'SOFA MAYBATCH 1A(RHF)' }),
    line({ itemCode: '8051-1S', materialName: 'SOFA PRESTIGE 1S' }),
  ];
  test('pieces sharing every word never match by name', () => {
    expect(nameMatchItem('DSL9058 MAYBATCH 3SEATER (2+1)', po)).toBeNull();
  });
  test('a word only one item has matches it', () => {
    expect(nameMatchItem('Prestige 1 seater', po)).toBe('8051-1S');
  });
  test('a row naming two items matches neither', () => {
    expect(nameMatchItem('Prestige with Maybatch cushion', [po[0], po[2]])).toBeNull();
  });
  test('no printed text, no match', () => {
    expect(nameMatchItem(null, po)).toBeNull();
  });
});
