// Sister review P3 follow-up: the stock allocator now gives a held Sales Order
// no stock, so putting an SO on hold, or taking it off, has to start an
// allocation sweep or the stock stays where it was until some unrelated write.
// Drives the REAL shared hold handler through the fake PostgREST client.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { fakeSb } from '../lib/fake-postgrest';

const enqueue = vi.fn(async (_sb: unknown, _reason: string) => {});
const defer = vi.fn((_c: unknown, _sb: unknown, _where: string) => {});
vi.mock('../lib/stock-allocation-job', () => ({
  enqueueStockAllocationRecompute: (sb: unknown, reason: string) => enqueue(sb, reason),
  deferAllocationRecompute: (c: unknown, sb: unknown, where: string) => defer(c, sb, where),
}));

const { mountHoldRoute } = await import('./document-hold-routes');

const sb = fakeSb({ mfg_sales_orders: [], purchase_orders: [] });

function app(doc: 'so' | 'po') {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u-1' } as never);
    await next();
  });
  mountHoldRoute(a, doc);
  return a;
}

const hold = (doc: 'so' | 'po', key: string, onHold: boolean) => app(doc).request(`/${key}/hold`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onHold, reason: 'customer asked' }),
});

beforeEach(() => {
  enqueue.mockClear();
  defer.mockClear();
  sb.tables.mfg_sales_orders = [{ doc_no: 'SO-1', status: 'CONFIRMED', company_id: 1, on_hold: false }];
  sb.tables.purchase_orders = [{ id: 'po-1', po_number: 'PO-1', status: 'SUBMITTED', company_id: 1, on_hold: false }];
});

describe('SO hold starts a stock-allocation sweep', () => {
  it('putting a Sales Order on hold queues a sweep and starts one', async () => {
    const res = await hold('so', 'SO-1', true);
    expect(res.status).toBe(200);
    expect(sb.tables.mfg_sales_orders[0]!.on_hold).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(sb, 'so-hold:SO-1');
    expect(defer).toHaveBeenCalledTimes(1);
  });

  it('taking it off hold does the same', async () => {
    sb.tables.mfg_sales_orders[0]!.on_hold = true;
    const res = await hold('so', 'SO-1', false);
    expect(res.status).toBe(200);
    expect(sb.tables.mfg_sales_orders[0]!.on_hold).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(sb, 'so-hold:SO-1');
    expect(defer).toHaveBeenCalledTimes(1);
  });

  it('a failed queue write does not turn the written hold into an error', async () => {
    enqueue.mockRejectedValueOnce(new Error('queue down'));
    const res = await hold('so', 'SO-1', true);
    expect(res.status).toBe(200);
    expect(defer).toHaveBeenCalledTimes(1);
  });

  it('another company\'s order is not found and starts nothing', async () => {
    sb.tables.mfg_sales_orders[0]!.company_id = 2;
    const res = await hold('so', 'SO-1', true);
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a Purchase Order hold does not touch allocation', async () => {
    const res = await hold('po', 'po-1', true);
    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
  });
});
