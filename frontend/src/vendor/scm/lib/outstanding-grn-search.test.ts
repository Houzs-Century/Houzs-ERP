import { describe, expect, it } from 'vitest';
import { filterOutstandingGrnLines, searchTerms } from './outstanding-grn-search';
import type { OutstandingGrnItem } from './suppliers-queries';

const line = (o: Partial<OutstandingGrnItem>): OutstandingGrnItem => ({
  grnItemId: 'x',
  grnId: 'grn-65',
  grnDocNo: 'HC-GRN-2609-065',
  receivedAt: '2026-09-12',
  supplierId: 'sup-diglant',
  supplierCode: '400-D001',
  supplierName: 'DIGLANT MANUFACTURING SDN BHD.',
  purchaseOrderId: 'po-68',
  poDocNo: 'HC-PO-010068',
  itemCode: 'AKEMI EQUINOX MATT (K)',
  description: 'AKEMI EQUINOX MATTRESS (183x190x30CM)',
  itemGroup: 'mattress',
  qtyAccepted: 1,
  remaining: 1,
  unitPriceSen: 130000,
  variants: null,
  ...o,
});

const LINES = [
  line({ grnItemId: 'g65-1' }),
  line({
    grnItemId: 'g66-1', grnId: 'grn-66', grnDocNo: 'HC-GRN-2609-066', poDocNo: 'HC-PO-010069',
    itemCode: 'AKEMI IMMORTAL MATT (K)', description: 'AKEMI IMMORTAL MATTRESS (183x190x36CM)',
  }),
  line({
    grnItemId: 'g66-2', grnId: 'grn-66', grnDocNo: 'HC-GRN-2609-066', poDocNo: 'HC-PO-010069',
    itemCode: 'AKEMI MONARCH MATT (Q)', description: 'AKEMI MONARCH MATTRESS (153x190x30CM)',
  }),
  line({
    grnItemId: 'g70-1', grnId: 'grn-70', grnDocNo: 'HC-GRN-2609-070', poDocNo: null,
    supplierId: 'sup-happi', supplierCode: '400-H002', supplierName: 'HAPPI SLEEP SDN BHD',
    receivedAt: '2026-09-13',
    itemCode: 'HAPPI SLEEP SOLITUDE MATT (Q)', description: 'HAPPI SLEEP SOLITUDE MATTRESS (153x190x30CM)',
  }),
];

const ids = (q: string) => filterOutstandingGrnLines(LINES, q).map((l) => l.grnItemId);

describe('searchTerms', () => {
  it('lowercases and splits on any run of whitespace', () => {
    expect(searchTerms('  Diglant   IMMORTAL ')).toEqual(['diglant', 'immortal']);
  });
});

describe('filterOutstandingGrnLines', () => {
  it('returns the same array for an empty or blank query', () => {
    expect(filterOutstandingGrnLines(LINES, '')).toBe(LINES);
    expect(filterOutstandingGrnLines(LINES, '   ')).toBe(LINES);
  });

  it('a note number keeps every line of that note', () => {
    expect(ids('hc-grn-2609-066')).toEqual(['g66-1', 'g66-2']);
  });

  it('an item word keeps only the lines that carry it, not the rest of their note', () => {
    expect(ids('immortal')).toEqual(['g66-1']);
  });

  it('every word must match, and the words may come from different fields', () => {
    expect(ids('diglant mattress')).toEqual(['g65-1', 'g66-1', 'g66-2']);
    expect(ids('diglant solitude')).toEqual([]);
    expect(ids('happi (q)')).toEqual(['g70-1']);
  });

  it('finds a line by supplier code, PO number and the received date as the card prints it', () => {
    expect(ids('400-H002')).toEqual(['g70-1']);
    expect(ids('HC-PO-010068')).toEqual(['g65-1']);
    expect(ids('13/09/2026')).toEqual(['g70-1']);
  });

  it('finds a line by its Description 2', () => {
    const fabric = line({ grnItemId: 'sofa-1', itemGroup: 'sofa', itemCode: '5530-2A', description: null, variants: { fabricCode: 'PC151-12' } });
    expect(filterOutstandingGrnLines([...LINES, fabric], 'pc151-12').map((l) => l.grnItemId)).toEqual(['sofa-1']);
  });
});
