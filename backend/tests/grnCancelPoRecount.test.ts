/* BUG-64. A GRN was saved POSTED, a line edit recounted its PO line to
 * received_qty=1, then a data repair (after PR #4403) put it back to DRAFT with
 * no recount. Cancelling the DRAFT took the short-circuit that skipped the PO
 * recount, so the PO kept received_qty=1 and the bound SO bedframe stayed READY.
 * The recount counts only POSTED/CLOSED lines, so running it on a DRAFT cancel
 * can never over-reverse. Harness copied from migratedNoStockReversal.test.ts. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { cancelGrnCommand } from '../src/scm/routes/grns';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row | Row[]) { return this.insert(v); }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const sb = {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      /* true = the audit sink is writable. The pre-flight must not be the
         reason a cancel stops, or this suite would prove nothing about stock. */
      rpc: async () => ({ data: true, error: null }),
    };
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/grns/:id/cancel', async (c) => cancelGrnCommand(c, c.get('supabase' as never)));
  return app;
}

function fixture(status: 'DRAFT' | 'POSTED') {
  const tables: Record<string, Row[]> = {
    grns: [{
      id: 'grn-1', company_id: CO, status, grn_number: 'HC-GRN-2610-002',
      warehouse_id: 'wh-1', migrated_no_stock: false,
    }],
    grn_items: [{
      id: 'gi-1', grn_id: 'grn-1', purchase_order_item_id: 'poi-1', qty_accepted: 1,
      item_code: 'ELEPHANE-(K)', material_name: 'Elephane bedframe', unit_price_sen: 10_000,
      item_group: 'BEDFRAME', variants: null, invoiced_qty: 0, returned_qty: 0,
    }],
    // STALE: left at 1 by the earlier POSTED recount; this GRN is the only one on the PO.
    purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 1, received_qty: 1, so_item_id: 'soi-1' }],
    purchase_orders: [{ id: 'po-1', status: 'PARTIALLY_RECEIVED', received_at: null }],
    inventory_balances: [{ warehouse_id: 'wh-1', item_code: 'ELEPHANE-(K)', variant_key: '', qty: 5 }],
    inventory_movements: [],
    stock_allocation_recompute_queue: [],
  };
  return tables;
}

describe('PATCH /grns/:id/cancel — PO recount and SO re-walk (BUG-64)', () => {
  test('cancelling a DRAFT recounts a stale PO received_qty and queues the allocation re-walk', async () => {
    const tables = fixture('DRAFT');
    const res = await harness(tables).request('/grns/grn-1/cancel', { method: 'PATCH' });

    expect(res.status).toBe(200);
    expect(tables.grns[0]!.status).toBe('CANCELLED');
    expect(tables.purchase_order_items[0]!.received_qty).toBe(0);
    expect(tables.purchase_orders[0]!.status).toBe('SUBMITTED');
    expect(tables.stock_allocation_recompute_queue).toHaveLength(1);
    // Still no stock movement: a draft never posted any.
    expect(tables.inventory_movements).toEqual([]);
  });

  test('cancelling a migrated POSTED receipt still queues the re-walk after its recount', async () => {
    const tables = fixture('POSTED');
    tables.grns[0]!.migrated_no_stock = true;
    const res = await harness(tables).request('/grns/grn-1/cancel', { method: 'PATCH' });

    expect(res.status).toBe(200);
    expect(tables.purchase_order_items[0]!.received_qty).toBe(0);
    expect(tables.inventory_movements).toEqual([]);
    expect(tables.stock_allocation_recompute_queue).toHaveLength(1);
  });
});
