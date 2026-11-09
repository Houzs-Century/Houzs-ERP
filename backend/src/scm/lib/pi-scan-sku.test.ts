/* HOOKKA prints its own numeric codes for our model-named SKUs (production, company 1,
 * 2026-11-09): 1013-(Q) is JAGER-(Q), 1007-(Q) CODY-(Q), 2038(A)-(Q) CELENE (A)-(Q),
 * 2008(A)-(K) TRION (A) (HB STR)-(K), 5540-* 8030-*, 5536-* 9058-*, 5530-* 9028-*. */
import { describe, expect, test } from 'vitest';
import { buildPiReview, mergeRebuiltLines, suggestBills, type BillableLine, type PiReviewLine } from './pi-scan-check';
import type { PiScanExtract } from './pi-scan-extract';
import { codeByDescription, codeByPrefix, modelPrefixes, proposeGrnLines, skuOfRow, type ProposableLine } from './pi-scan-sku';

const OURS = ['JAGER-(Q)', 'JAGER-(K)', 'CODY-(Q)', 'CODY-(K)', 'CELENE-(Q)', 'CELENE (A)-(Q)', 'CELENE (A)-(K)', 'TRION (A) (HB STR)-(K)', 'TRION (A) (HB STR)-(Q)', '8030-1A(LHF)', '8030-1S', '8030-2A(RHF)', '9058-1NA', '9028-1A(LHF)', 'FENRIR-(Q)'];

describe('a model prefix learned from any bound size of the model', () => {
  const prefixes = modelPrefixes([
    { supplierSku: '1007-(K)', itemCode: 'CODY-(K)' },
    { supplierSku: '2038(A)-(K)', itemCode: 'CELENE (A)-(K)' },
    { supplierSku: '2008(A)-(Q)', itemCode: 'TRION (A) (HB STR)-(Q)' },
    { supplierSku: '5540-2A(RHF)', itemCode: '8030-2A(RHF)' },
    { supplierSku: '5536-1NA', itemCode: '9058-1NA' },
    { supplierSku: '1005', itemCode: 'FENRIR-(Q)' },
  ]);
  test('the pairs teach 1007 = CODY, 2038 = CELENE, 2008(A) = TRION (A) (HB STR), 5540 = 8030, 5536 = 9058', () => {
    expect([...prefixes].map(([k, v]) => [k, [...v]])).toEqual([
      ['1007', ['CODY']], ['2038', ['CELENE']], ['2008(A)', ['TRION(A)(HBSTR)']], ['5540', ['8030']], ['5536', ['9058']],
    ]);
  });
  test('another size or piece of the same model maps to ours', () => {
    expect(codeByPrefix('1007-(Q)', prefixes, OURS)).toBe('CODY-(Q)');
    expect(codeByPrefix('2038(A)-(Q)', prefixes, OURS)).toBe('CELENE (A)-(Q)');
    expect(codeByPrefix('2008(A)-(K)', prefixes, OURS)).toBe('TRION (A) (HB STR)-(K)');
    expect(codeByPrefix('5540-1A(LHF)', prefixes, OURS)).toBe('8030-1A(LHF)');
    expect(codeByPrefix('5540-1S', prefixes, OURS)).toBe('8030-1S');
  });
  test('a code no learned prefix covers, or that translates to no SKU of ours, maps to nothing', () => {
    expect(codeByPrefix('1013-(Q)', prefixes, OURS)).toBeNull();
    expect(codeByPrefix('5530-1A(LHF)', prefixes, OURS)).toBeNull();
    expect(codeByPrefix('10070-(Q)', prefixes, OURS)).toBeNull();
    expect(codeByPrefix('5540-9Z', prefixes, OURS)).toBeNull();
  });
});

describe('the model name printed, with the size from the code', () => {
  test('1013-(Q) JAGER BEDFRAME (5FT) is JAGER-(Q), not the king', () => {
    expect(codeByDescription('1013-(Q)', 'JAGER BEDFRAME (5FT) (152X190CM) FABRIC: KN 06', OURS)).toBe('JAGER-(Q)');
    expect(codeByDescription('1013-(K)', 'JAGER BEDFRAME (6FT)', OURS)).toBe('JAGER-(K)');
  });
  test('the most specific model wins: CELENE (A) over CELENE', () => {
    expect(codeByDescription('2038(A)-(Q)', 'CELENE (A) BEDFRAME (5FT)', OURS)).toBe('CELENE (A)-(Q)');
  });
  test('a size no SKU of that model has, or no size at all for a sized SKU, ties nothing', () => {
    expect(codeByDescription('1007-(SK)', 'CODY BEDFRAME', OURS)).toBeNull();
    expect(codeByDescription('1005', 'FENRIR BEDFRAME', OURS)).toBeNull();
    expect(codeByDescription('1005', 'FENRIR BEDFRAME (5FT)', OURS)).toBe('FENRIR-(Q)');
  });
  test('skuOfRow: our own code first, then a learned prefix, then the name', () => {
    const prefixes = modelPrefixes([{ supplierSku: '1007-(K)', itemCode: 'CODY-(K)' }]);
    expect(skuOfRow('9058-1NA', null, prefixes, OURS)).toBe('9058-1NA');
    expect(skuOfRow('1007-(Q)', 'SOMETHING ELSE', prefixes, OURS)).toBe('CODY-(Q)');
    expect(skuOfRow('1013-(Q)', 'JAGER BEDFRAME (5FT)', prefixes, OURS)).toBe('JAGER-(Q)');
  });
});

describe('an invoice no receipt anchors: propose the supplier\'s open receipt lines', () => {
  const line = (grnItemId: string, grnNumber: string, itemCode: string, receivedAt: string | null): ProposableLine => ({ grnItemId, grnNumber, itemCode, receivedAt });
  test('the one receipt holding most of the invoice\'s rows wins, though the SKU is also on another', () => {
    const lines = [
      line('a1', 'GRN-A', 'JAGER-(Q)', '2026-10-20'), line('a2', 'GRN-A', 'CODY-(Q)', '2026-10-20'),
      line('b1', 'GRN-B', 'JAGER-(Q)', '2026-10-01'),
    ];
    const left = new Map([['a1', 1], ['a2', 1], ['b1', 1]]);
    const out = proposeGrnLines([{ key: 'r1', itemCode: 'JAGER-(Q)', qty: 1 }, { key: 'r2', itemCode: 'CODY-(Q)', qty: 1 }], lines, left);
    expect(Object.fromEntries(out)).toEqual({ r1: 'a1', r2: 'a2' });
  });
  test('as many rows on two receipts: the older one', () => {
    const lines = [line('a1', 'GRN-A', 'JAGER-(Q)', '2026-10-20'), line('b1', 'GRN-B', 'JAGER-(Q)', '2026-10-01')];
    const out = proposeGrnLines([{ key: 'r1', itemCode: 'JAGER-(Q)', qty: 1 }], lines, new Map([['a1', 1], ['b1', 1]]));
    expect(out.get('r1')).toBe('b1');
  });
  test('two receipts equally good (as many rows, the same day): no pick', () => {
    const lines = [line('a1', 'GRN-A', 'JAGER-(Q)', '2026-10-01T09:00:00Z'), line('b1', 'GRN-B', 'JAGER-(Q)', '2026-10-01T15:00:00Z')];
    const out = proposeGrnLines([{ key: 'r1', itemCode: 'JAGER-(Q)', qty: 1 }], lines, new Map([['a1', 1], ['b1', 1]]));
    expect(out.size).toBe(0);
  });
  test('a line already spent is not proposed twice', () => {
    const lines = [line('a1', 'GRN-A', 'JAGER-(Q)', '2026-10-01')];
    const out = proposeGrnLines([{ key: 'r1', itemCode: 'JAGER-(Q)', qty: 1 }, { key: 'r2', itemCode: 'JAGER-(Q)', qty: 1 }], lines, new Map([['a1', 1]]));
    expect(Object.fromEntries(out)).toEqual({ r1: 'a1' });
  });
});

const bill = (grnItemId: string, grnNumber: string, itemCode: string, receivedAt: string, supplierSku: string | null = null): BillableLine => ({ grnItemId, grnNumber, supplierId: 'hookka', poNumber: 'HC-PO-1', itemCode, supplierSku, description: null, remaining: 1, unitPriceSen: 100_00, receivedAt });
const row = (itemCode: string, description: string): PiReviewLine => ({ key: itemCode, grnItemId: null, grnNumber: null, qty: 1, suggested: false, ai: false, read: { itemCode, description, qty: 1, unitPrice: 100, lineTotal: 100 } });

describe('INV-2610-097: HOOKKA codes on an invoice no receipt anchors', () => {
  const open = [
    bill('j1', 'GRN-090', 'JAGER-(Q)', '2026-10-28'), bill('c1', 'GRN-090', 'CODY-(Q)', '2026-10-28'), bill('s1', 'GRN-090', '8030-1S', '2026-10-28'),
    bill('j2', 'GRN-012', 'JAGER-(Q)', '2026-10-02'),
    bill('k1', 'GRN-012', 'CODY-(K)', '2026-10-02', '1007-(K)'), bill('r1', 'GRN-012', '8030-2A(RHF)', '2026-10-02', '5540-2A(RHF)'),
  ];
  const prefixes = modelPrefixes(open.map((l) => ({ supplierSku: l.supplierSku, itemCode: l.itemCode })));
  test('each row finds its SKU and the receipt holding most of the invoice, marked to check', () => {
    const lines = [row('1013-(Q)', 'JAGER BEDFRAME (5FT) (152X190CM)'), row('1007-(Q)', 'CODY BEDFRAME (5FT)'), row('5540-1S', 'SOFA 1 SEATER')];
    suggestBills(lines, open, [], new Map(), prefixes);
    expect(lines.map((l) => [l.grnItemId, l.suggested, l.ai])).toEqual([['j1', true, false], ['c1', true, false], ['s1', true, false]]);
  });
});

describe('the AI answer ties what the rules left, marked as an AI match', () => {
  const parsed: PiScanExtract = { supplierName: 'HOOKKA INDUSTRIES SDN BHD', supplierCode: null, invoiceNumber: 'INV-2610-050', invoiceDate: '2026-10-30', poNo: null, doNo: 'DO-2610-044', salesTax: null, totalAmount: null, lines: [
    { itemCode: '2137-(K)', articleNo: null, description: 'BEDFRAME 6FT', qty: 1, unitPrice: 100, salesTax: null, lineTotal: 100 },
  ] };
  const open = [bill('b1', 'GRN-044', 'BREEVA-(K)', '2026-10-28')];
  test('without an answer the row stays to choose; with one it is tied and marked', () => {
    expect(buildPiReview(parsed, 'hookka', null, open, [], { families: new Map(), prefixes: new Map() }, null).lines[0]!.grnItemId).toBeNull();
    const r = buildPiReview(parsed, 'hookka', null, open, [], { families: new Map(), prefixes: new Map() }, new Map([['2137-(K)|BEDFRAME 6FT', 'BREEVA-(K)']]));
    expect(r.lines[0]).toMatchObject({ grnItemId: 'b1', suggested: true, ai: true });
  });
});

describe('a waiting copy rebuilt by the newer matching', () => {
  const tied = (key: string, grnItemId: string): PiReviewLine => ({ ...row(key, `d ${key}`), key: `${key}-new`, grnItemId, suggested: true });
  test('tied rows stay, an untied row takes the newer tie, a removed row stays removed', () => {
    const kept = [{ ...row('A', 'd A'), grnItemId: 'old-a' }, row('B', 'd B'), row('C', 'd C')];
    const rebuilt = [tied('A', 'new-a'), tied('B', 'new-b'), row('C', 'd C'), tied('D', 'new-d')];
    expect(mergeRebuiltLines(kept, rebuilt).map((l) => [l.read?.itemCode, l.grnItemId])).toEqual([['A', 'old-a'], ['B', 'new-b'], ['C', null]]);
  });
});
