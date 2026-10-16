/* Cancelling an SO releases its goods lines' stock allocation. The recompute
   only walks live SOs, so before this a cancelled order (prod: 2990-SO-2607-024)
   kept stock_status READY, stock_qty_ready 1 and its claimed sofa batch.
   SERVICE lines are READY from birth and stay untouched; an already-cancelled
   line is not rewritten. */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

type Row = Record<string, any>;

/* The cancel commits inside a real PG transaction; run it on the fake client. */
vi.mock('../src/scm/lib/pg-supabase-transaction', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runScmPgCommand: async (c: any, cmd: (sb: any) => Promise<Response>) => cmd(c.get('supabase')),
}));
vi.mock('../src/scm/lib/so-stock-allocation', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recomputeSoStockAllocation: async () => ({ ok: true }),
}));

import { patchMfgSalesOrderStatusHandler } from '../src/scm/routes/mfg-sales-orders';

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

const CO = 2;
const DOC = '2990-SO-2607-024';

function app(tables: Record<string, Row[]>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])), rpc: async () => ({ data: true, error: null }) } as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, '2990' as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.patch('/mfg-sales-orders/:docNo/status', patchMfgSalesOrderStatusHandler as never);
  return a;
}

const ready = (id: string, item_code: string, extra: Row = {}): Row => ({
  id, doc_no: DOC, company_id: CO, item_code, item_group: 'SOFA', cancelled: false,
  stock_status: 'READY', stock_qty_ready: 1, allocated_batch_no: '2990-PO-2607-018', ...extra,
});

describe('SO cancel releases line allocation', () => {
  test('goods lines reset; service and already-cancelled lines untouched', async () => {
    const t: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: DOC, company_id: CO, status: 'CONFIRMED', version: 1 }],
      mfg_sales_order_items: [
        ready('l1', 'XAMMAR-2A(RHF)'),
        ready('l2', 'XAMMAR-L(LHF)'),
        ready('svc', 'SVC-DELIVERY', { item_group: 'SERVICE', stock_qty_ready: 0, allocated_batch_no: null }),
        ready('dead', 'XAMMAR-1A', { cancelled: true }),
        ready('other-co', 'XAMMAR-2A(RHF)', { company_id: 1 }),
      ],
    };
    const res = await app(t).request(`/mfg-sales-orders/${DOC}/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'CANCELLED', version: 1 }),
    });
    expect(res.status).toBe(200);
    const byId = new Map(t.mfg_sales_order_items.map((l) => [l.id, l]));
    for (const id of ['l1', 'l2']) {
      expect(byId.get(id)).toMatchObject({ stock_status: 'PENDING', stock_qty_ready: 0, allocated_batch_no: null });
    }
    expect(byId.get('svc')!.stock_status).toBe('READY');
    expect(byId.get('dead')!.stock_status).toBe('READY');
    expect(byId.get('other-co')!.stock_status).toBe('READY');
  });
});
