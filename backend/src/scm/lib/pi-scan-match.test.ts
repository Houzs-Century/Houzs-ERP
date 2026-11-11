import { describe, expect, test } from 'vitest';
import {
  normalizeDocRef,
  docRefsOf, docRefMatches, exchangeRefsOf, poRefsNote,
  normalizeCode,
  matchInvoiceLinesToGrnLines,
  type PiMatchGrnLine,
} from './pi-scan-match';
import type { PiScanLine } from './pi-scan-extract';

// The matcher is the safety-critical heart of the PI scanner: it decides which
// GRN lines an invoice bills, and it must NEVER over-bill a receipt line or
// invent a link. These pin that behaviour.

const line = (p: Partial<PiScanLine>): PiScanLine => ({
  itemCode: null, articleNo: null, description: null, qty: null,
  unitPrice: null, salesTax: null, lineTotal: null, ...p,
});
const grn = (p: Partial<PiMatchGrnLine> & { grnItemId: string }): PiMatchGrnLine => ({
  grnNumber: 'HC-GRN-2609-001', itemCode: 'CODE', remaining: 10, unitPriceSen: 0, ...p,
});

describe('normalizeDocRef', () => {
  test('uppercases and strips non-alphanumerics', () => {
    expect(normalizeDocRef('po-010070')).toBe('PO010070');
    expect(normalizeDocRef('DGSN 2600/1880')).toBe('DGSN26001880');
    expect(normalizeDocRef(null)).toBe('');
  });
});

describe('docRefMatches — anchors a scanned ref to our doc number', () => {
  test('the supplier bare PO No matches our HC- prefixed number (suffix)', () => {
    expect(docRefMatches('PO-010070', 'HC-PO-010070')).toBe(true);
  });
  test('an invoice naming several D.O. reaches each of them', () => {
    expect(docRefsOf('DO-2610-01, DO-2610-02 & DO-2610-03')).toEqual(['DO-2610-01', 'DO-2610-02', 'DO-2610-03']);
    expect(docRefsOf('DGSN26001880')).toEqual(['DGSN26001880']);
    expect(docRefsOf(null)).toEqual([]);
  });
  test('an exchange PO (HOOKKA INV-2610-097, "EX-") anchors to the order it replaces', () => {
    const printed = 'EX-PO-009744, EX-HC-PO-2609-151, EX-HC-PO-2609-226';
    expect(docRefsOf(printed)).toEqual(['PO-009744', 'HC-PO-2609-151', 'HC-PO-2609-226']);
    expect(docRefsOf('EX HC-PO-2609-151; EXCH-HC-PO-2609-226')).toEqual(['HC-PO-2609-151', 'HC-PO-2609-226']);
    expect(docRefMatches(docRefsOf(printed)[1], 'HC-PO-2609-151')).toBe(true);
    // A number that only starts with the letters is not marked.
    expect(docRefsOf('EXPO-1234567')).toEqual(['EXPO-1234567']);
    expect(exchangeRefsOf(printed)).toEqual(['PO-009744', 'HC-PO-2609-151', 'HC-PO-2609-226']);
    expect(exchangeRefsOf('HC-PO-2609-151')).toEqual([]);
    expect(poRefsNote(printed)).toEqual({ refs: 'PO-009744, HC-PO-2609-151, HC-PO-2609-226', exchange: 'The invoice marks PO-009744, HC-PO-2609-151, HC-PO-2609-226 as exchange (EX): replacement goods for those orders.' });
  });
  test('DO No matches delivery_note_ref exactly after normalization', () => {
    expect(docRefMatches('DGSN26001880', 'DGSN26001880')).toBe(true);
  });
  test('different numbers do not match', () => {
    expect(docRefMatches('PO-010070', 'HC-PO-010071')).toBe(false);
  });
  test('empty scanned ref never matches (an unread number must not anchor)', () => {
    expect(docRefMatches(null, 'HC-PO-010070')).toBe(false);
    expect(docRefMatches('', 'HC-PO-010070')).toBe(false);
  });
  test('a trivially short suffix does not match by accident', () => {
    expect(docRefMatches('070', 'HC-PO-010070')).toBe(false);
  });
});

describe('normalizeCode', () => {
  test('uppercases, trims and collapses whitespace', () => {
    expect(normalizeCode('  happi.s  mistcool   matt (q) ')).toBe('HAPPI.S MISTCOOL MATT (Q)');
    expect(normalizeCode(null)).toBe('');
  });
});

describe('matchInvoiceLinesToGrnLines', () => {
  test('exact item-code match, quantity within remaining -> one pick', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'SOFA-A', qty: 3 })],
      [grn({ grnItemId: 'g1', itemCode: 'SOFA-A', remaining: 5 })],
      new Map(),
    );
    expect(res.picks).toEqual([{ grnItemId: 'g1', qty: 3, grnNumber: 'HC-GRN-2609-001', invoiceLineIndex: 0 }]);
    expect(res.unmatched).toEqual([]);
    expect(res.matchedLineCount).toBe(1);
  });

  test('caps the pick at the GRN line remaining, and flags the shortfall (never over-bills)', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'SOFA-A', qty: 8 })],
      [grn({ grnItemId: 'g1', itemCode: 'SOFA-A', remaining: 5 })],
      new Map(),
    );
    expect(res.picks).toEqual([{ grnItemId: 'g1', qty: 5, grnNumber: 'HC-GRN-2609-001', invoiceLineIndex: 0 }]);
    expect(res.unmatched).toHaveLength(1);
    expect(res.unmatched[0]).toMatchObject({ reason: 'qty_short', billed: 5, invoiceLineIndex: 0 });
  });

  test('resolves the supplier Article No to our item code via the binding map', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ articleNo: 'DGSKU-99', qty: 2 })],
      [grn({ grnItemId: 'g1', itemCode: 'OUR-CODE', remaining: 4 })],
      new Map([['DGSKU-99', 'OUR-CODE']]),
    );
    expect(res.picks).toEqual([{ grnItemId: 'g1', qty: 2, grnNumber: 'HC-GRN-2609-001', invoiceLineIndex: 0 }]);
    expect(res.matchedLineCount).toBe(1);
  });

  test('a learned code naming another size is not used: a printed queen never bills a king (INV-2610-090)', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'DIVAN-(Q)', qty: 1 })],
      [grn({ grnItemId: 'gk', itemCode: 'DIVAN ONLY-(K)', remaining: 1 })],
      new Map([['DIVAN-(Q)', 'DIVAN ONLY-(K)']]),
    );
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0]).toMatchObject({ reason: 'no_code_match' });
  });

  test('a code that matches nothing is left unmatched, never guessed onto another line', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'UNKNOWN', qty: 1 })],
      [grn({ grnItemId: 'g1', itemCode: 'SOFA-A', remaining: 5 })],
      new Map(),
    );
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0]).toMatchObject({ reason: 'no_code_match', billed: 0 });
    expect(res.matchedLineCount).toBe(0);
  });

  test('a line with no readable quantity is unmatched (no_qty)', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'SOFA-A', qty: null })],
      [grn({ grnItemId: 'g1', itemCode: 'SOFA-A', remaining: 5 })],
      new Map(),
    );
    expect(res.picks).toEqual([]);
    expect(res.unmatched[0]).toMatchObject({ reason: 'no_qty' });
  });

  test('allocates across multiple GRN lines of the same code, FIFO by GRN number', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'SOFA-A', qty: 7 })],
      [
        grn({ grnItemId: 'g2', grnNumber: 'HC-GRN-2609-002', itemCode: 'SOFA-A', remaining: 4 }),
        grn({ grnItemId: 'g1', grnNumber: 'HC-GRN-2609-001', itemCode: 'SOFA-A', remaining: 5 }),
      ],
      new Map(),
    );
    // FIFO: HC-GRN-...001 first (5), then ...002 (2) to make 7.
    expect(res.picks).toEqual([
      { grnItemId: 'g1', qty: 5, grnNumber: 'HC-GRN-2609-001', invoiceLineIndex: 0 },
      { grnItemId: 'g2', qty: 2, grnNumber: 'HC-GRN-2609-002', invoiceLineIndex: 0 },
    ]);
    expect(res.unmatched).toEqual([]);
  });

  test('two invoice lines of the same code never over-allocate one GRN line', () => {
    const res = matchInvoiceLinesToGrnLines(
      [line({ itemCode: 'SOFA-A', qty: 4 }), line({ itemCode: 'SOFA-A', qty: 4 })],
      [grn({ grnItemId: 'g1', itemCode: 'SOFA-A', remaining: 5 })],
      new Map(),
    );
    // First line takes 4 of 5; second takes the last 1 and is flagged short.
    expect(res.picks).toEqual([
      { grnItemId: 'g1', qty: 4, grnNumber: 'HC-GRN-2609-001', invoiceLineIndex: 0 },
      { grnItemId: 'g1', qty: 1, grnNumber: 'HC-GRN-2609-001', invoiceLineIndex: 1 },
    ]);
    const totalBilled = res.picks.reduce((s, p) => s + p.qty, 0);
    expect(totalBilled).toBe(5); // never exceeds the remaining
    expect(res.unmatched).toHaveLength(1);
    expect(res.unmatched[0]).toMatchObject({ invoiceLineIndex: 1, reason: 'qty_short', billed: 1 });
  });
});
