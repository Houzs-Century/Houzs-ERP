import { describe, expect, test } from 'vitest';

import { poSourceSoNos, poTransferShape, type PoLineShape } from './po-transfer-shape';

const line = (over: Partial<PoLineShape> = {}): PoLineShape => ({
  id: 'poi-1',
  so_item_id: 'soi-1',
  allocationCount: 0,
  sourceAcDtlKey: 991,
  sourceSoDocNo: 'HC-SO-000021',
  sourceSoInBook: true,
  itemCode: 'REGAL-KING',
  sourceItemCode: 'REGAL-KING',
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

  test('a source line with no AutoCount key falls back', () => {
    const shape = poTransferShape([line({ sourceAcDtlKey: null })]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/no key/);
  });

  test('two purchase lines naming the same sales line falls back', () => {
    const shape = poTransferShape([
      line({ id: 'a', sourceAcDtlKey: 991 }),
      line({ id: 'b', sourceAcDtlKey: 991 }),
    ]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/same sales-order line/);
  });

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

describe('the source order numbers a purchase order carries (UDF_SONo)', () => {
  test('the sales orders it was raised for', () => {
    expect(poSourceSoNos(['HC-SO-000021', 'HC-SO-000022'])).toBe('HC-SO-000021, HC-SO-000022');
  });

  test('deduplicated and sorted, so the same order always renders the same', () => {
    expect(poSourceSoNos(['HC-SO-B', 'HC-SO-A', 'HC-SO-B'])).toBe('HC-SO-A, HC-SO-B');
    expect(poSourceSoNos(['HC-SO-A', 'HC-SO-B'])).toBe(poSourceSoNos(['HC-SO-B', 'HC-SO-A']));
  });

  test('nothing to say is null, never an empty string', () => {
    expect(poSourceSoNos([])).toBeNull();
    expect(poSourceSoNos([null, undefined, '  '])).toBeNull();
  });
});

describe('a keyless line waits when its sales order is merely not in the book yet', () => {
  test('WAIT — no key, and the sales order has not reached the book', () => {
    const r = poTransferShape([line({ sourceAcDtlKey: null, sourceSoInBook: false })]);
    expect(r.kind).toBe('wait');
    if (r.kind === 'wait') expect(r.fromSoDocNo).toBe('HC-SO-000021');
  });

  test('CREATE — no key even though the sales order IS in the book', () => {
    const r = poTransferShape([line({ sourceAcDtlKey: null, sourceSoInBook: true })]);
    expect(r.kind).toBe('create');
  });

  test('CREATE — a keyless line for STOCK, which no sales order can supply', () => {
    const r = poTransferShape([line({ sourceAcDtlKey: null, so_item_id: null, sourceSoDocNo: null })]);
    expect(r.kind).toBe('create');
  });

  test('CREATE — two different sales orders, so there is no single anchor to wait on', () => {
    const r = poTransferShape([
      line({ id: 'a', sourceAcDtlKey: null, sourceSoInBook: false }),
      line({ id: 'b', so_item_id: 'soi-2', sourceAcDtlKey: null, sourceSoInBook: false, sourceSoDocNo: 'HC-SO-000022' }),
    ]);
    expect(r.kind).toBe('create');
  });

  test('TRANSFER is unchanged when the keys are there', () => {
    const r = poTransferShape([line()]);
    expect(r.kind).toBe('transfer');
    if (r.kind === 'transfer') expect(r.dtlKeys).toEqual([991]);
  });
});

/* docs/bugs/0672 SITE 13 — the transfer was decided on the KEY and never on the
 * PRODUCT.
 *
 * `poTransferShape` refuses a great deal: consolidated lines, stock lines,
 * keyless lines, a repeated key, more than one source document. Every one of
 * those is about CARDINALITY or PRESENCE. None of them asks whether the
 * purchase-order line and the sales-order line it names are the same product.
 *
 * A transfer is executed in the account book as `doc.DocTransfer(dtlKeys)`, and
 * the key is the ONLY handle — `composeEdit` even strips ItemCode off a keyed
 * line, so nothing in flight could reveal the mistake. A PO line for a TRION
 * that names a REGAL sales line therefore transfers the REGAL's book line into
 * a purchase order for TRIONs, in a licensed book, silently.
 *
 * The fallback is already built and already correct: `create` loses a link and
 * writes nothing wrong. This file's own header states the rule — "every case
 * that is not certainly 1:1 is asserted to fall back". Identity is part of 1:1.
 */
describe('a purchase order whose line names a DIFFERENT product does not transfer', () => {
  test('one disagreeing line is enough to fall back to create', () => {
    const shape = poTransferShape([
      line({ id: 'a', so_item_id: 'soi-1', sourceAcDtlKey: 991, itemCode: 'REGAL-KING', sourceItemCode: 'REGAL-KING' }),
      line({ id: 'b', so_item_id: 'soi-2', sourceAcDtlKey: 992, itemCode: 'TRION-KING', sourceItemCode: 'REGAL-QUEEN' }),
    ]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/different product|does not name the same/i);
  });

  test('agreement is compared the way a person reads a code', () => {
    const shape = poTransferShape([
      line({ itemCode: '  regal-king ', sourceItemCode: 'REGAL-KING' }),
    ]);
    expect(shape.kind).toBe('transfer');
  });

  test('a BLANK code on either side is not agreement — it is nothing to agree about', () => {
    expect(poTransferShape([line({ itemCode: 'REGAL-KING', sourceItemCode: null })]).kind).toBe('create');
    expect(poTransferShape([line({ itemCode: null, sourceItemCode: 'REGAL-KING' })]).kind).toBe('create');
  });

  test('the cardinality refusals still win when both apply, so the reason stays the loudest one', () => {
    const shape = poTransferShape([
      line({ id: 'a', so_item_id: null, itemCode: 'X', sourceItemCode: 'Y' }),
    ]);
    expect(shape.kind).toBe('create');
    expect(shape.kind === 'create' && shape.reason).toMatch(/for stock/i);
  });
});
