/* The resolver behind both the submit route's stored lane and the lane preview
 * (owner 2026-09-15, option B of 「可以给我选项选择approver?」). Three things are
 * worth pinning beyond the pure rule in shared/amendment-lane.test.ts:
 *
 *  1. WHERE EACH IDENTITY COMES FROM. An existing line is judged by the ORDER's
 *     row (item_code + item_group), an added line by the CATALOGUE category of
 *     its code in the order's company — the two reads whose absence produced
 *     docs/bugs/0816 and 0895.
 *  2. A FAILED READ IS null, NOT AN EMPTY IDENTITY. An empty identity classifies
 *     as LINES, which is exactly the mis-route; the caller must refuse instead.
 *  3. THE PRICE CARVE-OUT (owner 2026-09-21) is 2990's alone and compares the
 *     requested values against the SAME stored row, so a price-only change lands
 *     on PRICE while a spec change (even one that also moves the price) stays on
 *     LINES.
 */
import { describe, expect, it } from 'vitest';
import { resolveAmendmentLaneSplit, summarizeLaneSplit } from './amendment-lane-resolve';

type Row = Record<string, unknown> & { _table: string };

const makeSb = (rows: Row[], failTable?: string) => ({
  from(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => rows
      .filter((r) => r._table === table)
      .filter((r) => eqs.every(([col, v]) => r[col] === v))
      .filter((r) => ins.every(([col, vs]) => vs.includes(r[col])));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake PostgREST builder
    const builder: any = {
      select: () => builder,
      eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
      in: (col: string, vs: unknown[]) => { ins.push([col, [...vs]]); return builder; },
      filter: () => builder,
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => void) =>
        resolve(table === failTable ? { data: null, error: { message: 'boom' } } : { data: run(), error: null }),
    };
    return builder;
  },
});

// The stored SO lines carry their money/spec fields so the price-only carve-out
// has something to compare a requested change against.
const rows = (): Row[] => [
  { _table: 'mfg_sales_order_items', id: 'li-bed', doc_no: 'HC-SO-1', item_code: 'CODY-(K)', item_group: 'bedframe', qty: 1, unit_price_sen: 25000, variants: null, remark: null, discount_sen: 0 },
  { _table: 'mfg_sales_order_items', id: 'li-dispose', doc_no: 'HC-SO-1', item_code: 'DISPOSE', item_group: 'service', qty: 1, unit_price_sen: 10000, variants: null, remark: null, discount_sen: 0 },
  { _table: 'mfg_sales_order_items', id: 'li-other-order', doc_no: 'HC-SO-2', item_code: 'DISPOSE', item_group: 'service', qty: 1, unit_price_sen: 10000, variants: null, remark: null, discount_sen: 0 },
  { _table: 'mfg_products', code: 'TRANSPORTATION CHARGES', company_id: 1, category: 'SERVICE' },
  { _table: 'mfg_products', code: 'TRANSPORTATION CHARGES', company_id: 2, category: 'OTHERS' },
  { _table: 'mfg_products', code: 'CODY-(Q)', company_id: 1, category: 'BEDFRAME' },
];

describe('resolveAmendmentLaneSplit', () => {
  it('judges an existing line by the ORDER row: a bare-code service line goes to DELIVERY, a bedframe to LINES', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 1, {}, [
      { salesOrderItemId: 'li-dispose' },
      { salesOrderItemId: 'li-bed' },
    ], false);
    expect(split).not.toBeNull();
    expect(split!.lanes).toEqual(['LINES', 'DELIVERY']);
    expect(split!.perLane.DELIVERY.lines).toEqual([{ salesOrderItemId: 'li-dispose' }]);
    expect(split!.perLane.LINES.lines).toEqual([{ salesOrderItemId: 'li-bed' }]);
  });

  it('judges an ADDED line by its catalogue category in the order\'s company (HC-SO-012757/A1)', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 1, {}, [
      { newItemCode: 'TRANSPORTATION CHARGES' },
      { newItemCode: 'CODY-(Q)' },
    ], false);
    expect(split!.perLane.DELIVERY.lines).toEqual([{ newItemCode: 'TRANSPORTATION CHARGES' }]);
    expect(split!.perLane.LINES.lines).toEqual([{ newItemCode: 'CODY-(Q)' }]);
  });

  it('never reads another company\'s catalogue row', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 2, {}, [
      { newItemCode: 'TRANSPORTATION CHARGES' },
    ], false);
    expect(split!.lanes).toEqual(['LINES']);
  });

  it('reads line identities from THIS order only — a line id on another order is unknown, so LINES', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 1, {}, [
      { salesOrderItemId: 'li-other-order' },
    ], false);
    expect(split!.lanes).toEqual(['LINES']);
  });

  it('routes header keys through the lane table alongside the lines', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 1,
      { customerDeliveryDate: '2026-10-01', processingDate: '2026-09-20' }, [], false);
    expect(split!.perLane.DELIVERY.headerKeys).toEqual(['customerDeliveryDate']);
    expect(split!.perLane.LINES.headerKeys).toEqual(['processingDate']);
  });

  it('answers null when either read fails, never an empty identity', async () => {
    expect(await resolveAmendmentLaneSplit(makeSb(rows(), 'mfg_sales_order_items'), 'HC-SO-1', 1, {}, [
      { salesOrderItemId: 'li-dispose' },
    ], false)).toBeNull();
    expect(await resolveAmendmentLaneSplit(makeSb(rows(), 'mfg_products'), 'HC-SO-1', 1, {}, [
      { newItemCode: 'TRANSPORTATION CHARGES' },
    ], false)).toBeNull();
  });

  it('asks the catalogue nothing when no line is added', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows(), 'mfg_products'), 'HC-SO-1', 1, {}, [
      { salesOrderItemId: 'li-bed' },
    ], false);
    expect(split!.lanes).toEqual(['LINES']);
  });
});

describe('resolveAmendmentLaneSplit — PRICE lane (2990, owner 2026-09-21)', () => {
  it('carves a price-only change on a product line into PRICE when enabled', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 2, {}, [
      { salesOrderItemId: 'li-bed', changeType: 'SPEC', newUnitPriceSen: 0 },
    ], true);
    expect(split!.lanes).toEqual(['PRICE']);
    expect(split!.perLane.PRICE.lines).toEqual([{ salesOrderItemId: 'li-bed', changeType: 'SPEC', newUnitPriceSen: 0 }]);
  });

  it('keeps a change that also moves the SKU on LINES (not price-only)', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 2, {}, [
      { salesOrderItemId: 'li-bed', changeType: 'SPEC', newItemCode: 'CODY-(Q)', newUnitPriceSen: 0 },
    ], true);
    expect(split!.lanes).toEqual(['LINES']);
  });

  it('a service line stays DELIVERY even when only its price moved', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 2, {}, [
      { salesOrderItemId: 'li-dispose', changeType: 'SPEC', newUnitPriceSen: 5000 },
    ], true);
    expect(split!.lanes).toEqual(['DELIVERY']);
  });

  it('is OFF when the price lane is not enabled (HOUZS): a price-only change stays LINES', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 1, {}, [
      { salesOrderItemId: 'li-bed', changeType: 'SPEC', newUnitPriceSen: 0 },
    ], false);
    expect(split!.lanes).toEqual(['LINES']);
  });

  it('an ADD is never price-only — it is a whole new line, classified by its code', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 2, {}, [
      { newItemCode: 'CODY-(Q)', changeType: 'ADD', newUnitPriceSen: 0 },
    ], true);
    expect(split!.lanes).toEqual(['LINES']);
  });
});

describe('summarizeLaneSplit', () => {
  it('reports counts and header keys per lane, not the lines themselves', async () => {
    const split = await resolveAmendmentLaneSplit(makeSb(rows()), 'HC-SO-1', 1,
      { customerDeliveryDate: '2026-10-01' }, [{ salesOrderItemId: 'li-bed' }, { newItemCode: 'TRANSPORTATION CHARGES' }], false);
    expect(summarizeLaneSplit(split!)).toEqual({
      lanes: ['LINES', 'DELIVERY'],
      perLane: {
        LINES: { lineCount: 1, headerKeys: [] },
        DELIVERY: { lineCount: 1, headerKeys: ['customerDeliveryDate'] },
        PRICE: { lineCount: 0, headerKeys: [] },
      },
    });
  });
});
