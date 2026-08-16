// Which purchase orders may be a TRANSFER in AutoCount, and which must not.
//
// The whole risk of this decision is one-directional: transferring when the two
// sides do not agree line for line writes a WRONG purchase order into a
// licensed account book, while creating when a transfer was possible only loses
// a link. So every case that is not certainly 1:1 is asserted to fall back, and
// the fallback is what today already does.
import { describe, expect, test } from 'vitest';

import { poSourceRef, poTransferShape, type PoLineShape } from './po-transfer-shape';

const line = (over: Partial<PoLineShape> = {}): PoLineShape => ({
  id: 'poi-1',
  so_item_id: 'soi-1',
  allocationCount: 0,
  sourceAcDtlKey: 991,
  sourceSoDocNo: 'HC-SO-000021',
  ...over,
});

describe('a purchase order that maps 1:1 transfers', () => {
  test('every line names one sales-order line the book has a key for', () => {
    const shape = poTransferShape([
      line({ id: 'a', so_item_id: 'soi-1', sourceAcDtlKey: 991 }),
      line({ id: 'b', so_item_id: 'soi-2', sourceAcDtlKey: 992 }),
    ]);
    expect(shape).toEqual({ kind: 'transfer', dtlKeys: [991, 992], fromSoDocNo: 'HC-SO-000021' });
  });
});

describe('everything else is CREATED, and says why', () => {
  /* THE CASE THIS RULE EXISTS FOR — mig 0235, the owner's decision of
     2026-08-01. One qty-5 line covering two sales orders plus three for stock.
     A transfer would split it or drop the stock quantity. */
  test('a consolidated line falls back', () => {
    const shape = poTransferShape([line({ allocationCount: 3 })]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/consolidated/);
  });

  test('a stock line belongs to no sales order, so there is nothing to transfer from', () => {
    const shape = poTransferShape([line(), line({ id: 'b', so_item_id: null })]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/for stock/);
  });

  /* A transfer is addressed by the AutoCount key and by nothing else. A source
     line the book never received cannot be named. */
  test('a source line with no AutoCount key falls back', () => {
    const shape = poTransferShape([line({ sourceAcDtlKey: null })]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/no key/);
  });

  /* Two PO lines on one SO line is the consolidated case wearing different
     clothes, and transferring it would DOUBLE the quantity in the book. */
  test('two purchase lines naming the same sales line falls back', () => {
    const shape = poTransferShape([
      line({ id: 'a', sourceAcDtlKey: 991 }),
      line({ id: 'b', sourceAcDtlKey: 991 }),
    ]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/same sales-order line/);
  });

  /* A transfer has ONE source, because the drain has one anchor to wait on:
     the parent's AutoCount number. A purchase order consolidating two customers'
     orders is the ordinary case here and must not be forced into one. */
  test('lines from two different sales orders fall back', () => {
    const shape = poTransferShape([
      line({ id: 'a', sourceAcDtlKey: 991, sourceSoDocNo: 'HC-SO-A' }),
      line({ id: 'b', sourceAcDtlKey: 992, sourceSoDocNo: 'HC-SO-B' }),
    ]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/different sales orders/);
  });

  test('no lines at all', () => {
    expect(poTransferShape([]).kind).toBe('create');
  });
});

describe('the Ref a created purchase order carries', () => {
  test('the sales orders it was raised for', () => {
    expect(poSourceRef(['HC-SO-000021', 'HC-SO-000022'])).toBe('HC-SO-000021, HC-SO-000022');
  });

  /* STABLE, because an unstable Ref rewrites the account book's field on every
     edit for no reason. Deduplicated and sorted, so the same purchase order
     produces the same string whatever order the rows came back in. */
  test('deduplicated and sorted, so the same order always renders the same', () => {
    expect(poSourceRef(['HC-SO-B', 'HC-SO-A', 'HC-SO-B'])).toBe('HC-SO-A, HC-SO-B');
    expect(poSourceRef(['HC-SO-A', 'HC-SO-B'])).toBe(poSourceRef(['HC-SO-B', 'HC-SO-A']));
  });

  /* Nothing to say must be null, not "" — an empty string is a value and would
     blank whatever the account book holds. */
  test('nothing to say is null, never an empty string', () => {
    expect(poSourceRef([])).toBeNull();
    expect(poSourceRef([null, undefined, '  '])).toBeNull();
  });
});
