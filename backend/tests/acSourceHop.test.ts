/**
 * THE HOP IS A RULE ABOUT THE BOOK'S EDGES, AND IT HAD NO TEST.
 *
 * While `bookSourceOf` lived inline in `check-ac-erp-reconcile.mjs` the only
 * evidence it worked was a production run's summary line — which is exactly the
 * kind of evidence `docs/bugs/0768-the-121-purchase-invoices-…` was written
 * about: that run also printed 78 refusals reading `undefined:` and printed the
 * same 78 documents twice, and neither was visible from reading the code.
 *
 * What these pin is the direction each unknown falls in. `[]` means UNPROVEN
 * and the caller counts the document as a difference; anything else is a claim
 * about which purchase order a line came from, and a wrong claim there either
 * hides a real defect or invents one.
 */
import { describe, expect, test } from 'vitest';
import { bookSourceOf, sourceCoverage } from '../scripts/lib/ac-source-hop.mjs';

type Line = {
  dtlKey: string; itemKey: string;
  fromDocType?: string | null; fromDocNo?: string | null;
};

const grLine = (dtlKey: string, itemKey: string, po: string | null) => ({
  dtlKey, itemKey, fromDocType: po ? 'PO' : '', fromDocNo: po ?? '',
});

/* PI-1's lines, and the receipt GR-1 they were billed off. */
const book = {
  PI: {
    byDtlKey: new Map<string, Line>([
      ['p1', { dtlKey: 'p1', itemKey: 'CHAIR', fromDocType: 'GR', fromDocNo: 'GR-1' }],
      ['p2', { dtlKey: 'p2', itemKey: 'TABLE', fromDocType: 'GR', fromDocNo: 'GR-1' }],
      ['p3', { dtlKey: 'p3', itemKey: 'LAMP', fromDocType: 'GR', fromDocNo: 'GR-1' }],
      ['p4', { dtlKey: 'p4', itemKey: 'DESK', fromDocType: 'PO', fromDocNo: 'PO-DIRECT' }],
      ['p5', { dtlKey: 'p5', itemKey: 'SOFA', fromDocType: '', fromDocNo: '' }],
      ['p6', { dtlKey: 'p6', itemKey: 'BED', fromDocType: 'GR', fromDocNo: 'GR-MISSING' }],
    ]),
  },
  GR: {
    lines: new Map<string, ReturnType<typeof grLine>[]>([
      ['GR-1', [
        grLine('g1', 'CHAIR', 'PO-A'),
        grLine('g2', 'TABLE', 'PO-B'),
        grLine('g3', 'TABLE', 'PO-C'),   // same item, a SECOND order
        grLine('g4', 'TABLE', 'PO-B'),   // and a repeat of the first
        grLine('g5', 'LAMP', null),      // received against nothing
      ]],
    ]),
  },
};

const sourceOf = bookSourceOf(book as never, 'PI');

describe('bookSourceOf — one hop up, through the receipt', () => {
  test('the book names the order itself: no hop, nothing to guess', () => {
    expect(sourceOf('PI-1', 'p4')).toEqual([{ type: 'PO', docNo: 'PO-DIRECT' }]);
  });

  test('one receipt line matches the item: exactly one order', () => {
    expect(sourceOf('PI-1', 'p1')).toEqual([{ type: 'PO', docNo: 'PO-A' }]);
  });

  test('SEVERAL orders for the same item: all of them, deduplicated', () => {
    // The receipt took TABLE against PO-B twice and PO-C once. The book does
    // not say which the invoice line was billed off, so both are returned and
    // neither is chosen — docs/bugs/0690.
    expect(sourceOf('PI-1', 'p2')).toEqual([
      { type: 'PO', docNo: 'PO-B' },
      { type: 'PO', docNo: 'PO-C' },
    ]);
  });

  test('the receipt names no order for that item: UNPROVEN, not "no source"', () => {
    expect(sourceOf('PI-1', 'p3')).toEqual([]);
  });

  test('the line names no source at all: unproven', () => {
    expect(sourceOf('PI-1', 'p5')).toEqual([]);
  });

  test('the receipt is not in the snapshot: unproven, NEVER the receipt itself', () => {
    // Returning `{type:'GR', docNo:'GR-MISSING'}` would answer a different
    // question, and the rule's type gate would then refuse for the wrong reason.
    expect(sourceOf('PI-1', 'p6')).toEqual([]);
  });

  test('a line key the book does not have: unproven', () => {
    expect(sourceOf('PI-1', 'nope')).toEqual([]);
  });

  test('a type the book does not carry: unproven, never a throw', () => {
    expect(bookSourceOf(book as never, 'XX')('X-1', 'p1')).toEqual([]);
  });
});

describe('sourceCoverage — what the ERP ACTUALLY holds', () => {
  test('the document numbers, trimmed', () => {
    const c = sourceCoverage({ PO: { docs: [{ ac_no: ' PO-A ' }, { ac_no: 'PO-B' }] } }, 'PO');
    expect(c && [...c].sort()).toEqual(['PO-A', 'PO-B']);
  });

  test('rows with no AutoCount number do not become an empty-string member', () => {
    const c = sourceCoverage({ PO: { docs: [{ ac_no: 'PO-A' }, { ac_no: null }, {}] } } as never, 'PO');
    expect(c && [...c]).toEqual(['PO-A']);
  });

  test('NO rows at all is null, not an empty set', () => {
    // An empty set would say "we hold none of them", which makes every line
    // look like a migration gap. null makes the rule refuse instead.
    expect(sourceCoverage({ PO: { docs: [] } }, 'PO')).toBeNull();
    expect(sourceCoverage({}, 'PO')).toBeNull();
    expect(sourceCoverage({ PO: { docs: [{ ac_no: '' }] } }, 'PO')).toBeNull();
  });
});
