import { describe, expect, test } from 'vitest';
import {
  findNotReadySoLines,
  itemsNotReadyResponse,
  notReadyLines,
  type SoLineReadinessRow,
} from './do-not-ready-lines';
import routeSrc from '../routes/delivery-orders-mfg.ts?raw';

/* BUG-59 (Azza, HC-SO-009191 -> HC-DO-2610-095): a DO was cut from SO lines
   whose Stock read PENDING, with no dialog. The short-stock pre-flight only
   asks whether the warehouse holds the SKU, never whether THIS order's line has
   stock set aside. */

const row = (over: Partial<SoLineReadinessRow>): SoLineReadinessRow => ({
  id: 'li-1',
  doc_no: 'HC-SO-009191',
  item_code: 'AKEMI IMMORTAL MATT (K)',
  item_group: 'mattress',
  description: 'AKEMI IMMORTAL MATTRESS',
  stock_status: 'READY',
  warehouse_id: 'wh-kl',
  ...over,
});

const processed = new Set(['HC-SO-009191']);
const noDisplay = new Map();

describe('notReadyLines', () => {
  test('a READY line is not flagged', () => {
    expect(notReadyLines([row({})], processed, noDisplay)).toEqual([]);
  });

  test('a PENDING line is flagged with a plain reason', () => {
    const out = notReadyLines([row({ stock_status: 'PENDING' })], processed, noDisplay);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ soItemId: 'li-1', status: 'PENDING', itemCode: 'AKEMI IMMORTAL MATT (K)' });
    expect(out[0]!.reason).toMatch(/No stock has been set aside/);
  });

  test('a PARTIAL line is flagged', () => {
    expect(notReadyLines([row({ stock_status: 'PARTIAL' })], processed, noDisplay)[0]?.status).toBe('PARTIAL');
  });

  test('an order with no processing date says so', () => {
    const out = notReadyLines([row({ stock_status: 'PENDING' })], new Set(), noDisplay);
    expect(out[0]!.reason).toMatch(/no processing date/);
  });

  test('a line standing in a display warehouse is flagged even when stored READY', () => {
    const display = new Map([['wh-kl', { id: 'wh-kl', code: 'KL DISPLAY', name: 'KL Display', type: 'display' }]]);
    const out = notReadyLines([row({ stock_status: 'READY' })], processed, display);
    expect(out[0]!.reason).toMatch(/KL DISPLAY/);
  });

  test('service lines (dispose, delivery fee) are never flagged', () => {
    const out = notReadyLines(
      [row({ item_code: 'DISPOSE', item_group: 'service', stock_status: 'PENDING' })],
      processed,
      noDisplay,
    );
    expect(out).toEqual([]);
  });
});

/* A thenable PostgREST stand-in: every builder call returns itself, awaiting it
   yields the table's rows. Records the filters so company scope is checked. */
function fakeSb(tables: Record<string, Array<Record<string, unknown>> | Error>) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  const sb = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const op of ['select', 'in', 'eq', 'order', 'range']) {
        b[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return b; };
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        const t = tables[table];
        return Promise.resolve(t instanceof Error ? { data: null, error: { message: t.message } } : { data: t ?? [], error: null }).then(resolve);
      };
      return b;
    },
  };
  return { sb, calls };
}

describe('findNotReadySoLines', () => {
  test('reads the picked lines, scoped to the company, and flags the PENDING one', async () => {
    const { sb, calls } = fakeSb({
      mfg_sales_order_items: [row({ id: 'a' }), row({ id: 'b', item_code: 'AERO-MP (K)', stock_status: 'PENDING' })],
      mfg_sales_orders: [{ doc_no: 'HC-SO-009191', processing_date: '2026-09-29' }],
      warehouses: [],
    });
    const out = await findNotReadySoLines(sb, ['a', 'b', ''], 1);
    expect(out.map((l) => l.soItemId)).toEqual(['b']);
    expect(calls.some((c) => c.table === 'mfg_sales_order_items' && c.op === 'eq' && c.args[0] === 'company_id' && c.args[1] === 1)).toBe(true);
  });

  test('no linked lines means no read and nothing flagged', async () => {
    const { sb, calls } = fakeSb({});
    expect(await findNotReadySoLines(sb, ['', ''], 1)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a failed read flags nothing rather than refusing the delivery', async () => {
    const { sb } = fakeSb({ mfg_sales_order_items: new Error('boom') });
    expect(await findNotReadySoLines(sb, ['a'], 1)).toEqual([]);
  });
});

describe('the 409 and the routes', () => {
  test('the response carries a stable error code and the lines', () => {
    const lines = notReadyLines([row({ stock_status: 'PENDING' })], processed, noDisplay);
    const body = itemsNotReadyResponse(lines);
    expect(body.error).toBe('items_not_ready');
    expect(body.lines).toBe(lines);
  });

  test('both create paths ask, and both honour confirmNotReady', () => {
    const src = routeSrc as string;
    expect(src.match(/if \(!body\.confirmNotReady\) \{\s*const notReady = await findNotReadySoLines/g)).toHaveLength(2);
    expect(src.match(/return c\.json\(itemsNotReadyResponse\(notReady\), 409\)/g)).toHaveLength(2);
  });
});
