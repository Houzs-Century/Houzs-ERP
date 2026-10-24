import { describe, it, expect } from 'vitest';
import { findIncompleteSofaSets } from '../src/scm/lib/sofa-batch-guard';

/* HC-0146: a sofa module that is already out on another delivery is not "left
 * behind" by a DO that ships the rest of the set.
 *
 * HC-SO-011007 as production held it on 2026-10-22: 9058-1A(LHF), 9058-1NA and
 * 9058-1A(RHF) shipped on HC-DO-2610-240 (LOADED), and the corner 9058-CNR,
 * same batch HC-PO-2609-226, was still at the warehouse. stock_status stays
 * READY after a line ships, so the guard counted the three shipped modules as
 * set members and refused the DO for the corner. */

type Row = Record<string, unknown>;

function makeSb(tables: Record<string, Row[]>) {
  const makeBuilder = (table: string): unknown => {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => {
      const rows = (tables[table] ?? []).filter(
        (r) => eqs.every(([k, v]) => r[k] === v) && ins.every(([k, vs]) => vs.includes(r[k] as never)),
      );
      return { data: rows, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (onFulfilled: (v: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled);
        }
        return (...args: unknown[]) => {
          if (prop === 'eq') eqs.push([String(args[0]), args[1]]);
          if (prop === 'in') ins.push([String(args[0]), (args[1] ?? []) as unknown[]]);
          return builder;
        };
      },
    });
    return builder;
  };
  return { from: (table: string) => makeBuilder(table) };
}

const SO = 'HC-SO-011007';
const line = (id: string, code: string) =>
  ({ id, doc_no: SO, item_code: code, item_group: 'sofa', stock_status: 'READY', cancelled: false, qty: 1 });
const LHF = line('lhf', '9058-1A(LHF)');
const NA = line('na', '9058-1NA');
const RHF = line('rhf', '9058-1A(RHF)');
const CNR = line('cnr', '9058-CNR');

const products = ['9058-1A(LHF)', '9058-1NA', '9058-1A(RHF)', '9058-CNR']
  .map((code) => ({ code, category: 'SOFA', company_id: 1 }));

const onDo = (id: string, soItemId: string, status: string) =>
  ({ id, so_item_id: soItemId, qty: 1, parent: { status } });

describe('findIncompleteSofaSets — modules already shipped are not left behind (HC-0146)', () => {
  it('lets the corner ship alone when the other modules are on a LOADED delivery', async () => {
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LHF, NA, RHF, CNR],
      delivery_order_items: [onDo('d1', 'lhf', 'LOADED'), onDo('d2', 'na', 'LOADED'), onDo('d3', 'rhf', 'LOADED')],
    });

    expect(await findIncompleteSofaSets(sb, ['cnr'], 1)).toEqual([]);
  });

  it('still refuses when a module sits only on a DRAFT or CANCELLED delivery', async () => {
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LHF, NA, RHF, CNR],
      delivery_order_items: [onDo('d1', 'lhf', 'LOADED'), onDo('d2', 'na', 'DRAFT'), onDo('d3', 'rhf', 'CANCELLED')],
    });

    expect(await findIncompleteSofaSets(sb, ['cnr'], 1))
      .toEqual([{ docNo: SO, missingItemCodes: ['9058-1NA', '9058-1A(RHF)'] }]);
  });

  it('counts a returned module as back at the warehouse', async () => {
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LHF, NA, RHF, CNR],
      delivery_order_items: [onDo('d1', 'lhf', 'DELIVERED'), onDo('d2', 'na', 'DELIVERED'), onDo('d3', 'rhf', 'DELIVERED')],
      delivery_return_items: [{ do_item_id: 'd2', qty_returned: 1, parent: { status: 'RECEIVED' } }],
    });

    expect(await findIncompleteSofaSets(sb, ['cnr'], 1))
      .toEqual([{ docNo: SO, missingItemCodes: ['9058-1NA'] }]);
  });

  it('still refuses a first delivery that leaves part of the set behind', async () => {
    const sb = makeSb({
      mfg_products: products,
      mfg_sales_order_items: [LHF, NA, RHF, CNR],
    });

    expect(await findIncompleteSofaSets(sb, ['lhf', 'na', 'rhf'], 1))
      .toEqual([{ docNo: SO, missingItemCodes: ['9058-CNR'] }]);
  });
});
