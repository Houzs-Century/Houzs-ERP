// A status change is written only over the status the guards read.
//
// Before 2026-11-10 the DO and Consignment Note status PATCH wrote every
// non-cancel status with `.eq('id', id)` alone. A cancel landing between the
// guard read and the write (driver taps "Delivered" while the office cancels)
// was overwritten: the cancelled document read delivered while the cancel had
// already put its stock back. Sister fix: Conts-ERP #787.
//
// The race is reproduced by a fake whose UPDATE first lets a concurrent cancel
// commit, i.e. the row changes after the handler's read and before its write.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { cancelReversalRetryDue, patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';
import { patchConsignmentNoteStatusHandler } from '../src/scm/routes/consignment-notes';
import { todayMyt } from '../src/scm/lib/my-time';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private beforeUpdate: () => void) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } is() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    if (this.op === 'update') this.beforeUpdate();
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

function harness(table: string, row: Row, raceToCancelled: boolean) {
  const tables: Record<string, Row[]> = { [table]: [row] };
  const rpcCalls: string[] = [];
  let raced = false;
  const beforeUpdate = () => {
    if (raceToCancelled && !raced) { raced = true; tables[table]![0]!.status = 'CANCELLED'; }
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), beforeUpdate),
      rpc: async (name: string) => { rpcCalls.push(name); return { data: true, error: null }; },
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  app.patch('/consignment-notes/:id/status', patchConsignmentNoteStatusHandler as never);
  return { app, tables, rpcCalls };
}

const patch = (app: Hono, url: string, status: string) =>
  app.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });

const doRow = (status: string, updatedAt = '2026-11-10T00:00:00Z'): Row => ({
  id: 'do-1', do_number: 'HC-DO-1', company_id: CO, status, so_doc_no: null, warehouse_id: 'w1', updated_at: updatedAt,
});

describe('DO status PATCH — compare-and-set on the status the guards read', () => {
  test('a cancel landing mid-request is not overwritten by a late Delivered', async () => {
    const { app, tables } = harness('delivery_orders', doRow('DISPATCHED'), true);
    const res = await patch(app, '/delivery-orders/do-1/status', 'DELIVERED');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('status_changed');
    expect(tables.delivery_orders![0]!.status).toBe('CANCELLED');
    expect(tables.delivery_orders![0]!.delivered_at).toBeUndefined();
  });

  test('without a race the forward move still writes', async () => {
    const { app, tables } = harness('delivery_orders', doRow('DISPATCHED'), false);
    const res = await patch(app, '/delivery-orders/do-1/status', 'IN_TRANSIT');
    expect(res.status).toBe(200);
    expect(tables.delivery_orders![0]!.status).toBe('IN_TRANSIT');
  });
});

describe('DO Delivered fills the planning board Delivered date (sister-ERP gap review P14)', () => {
  test('a Delivered flip with no date stamps today\'s Malaysian day', async () => {
    const { app, tables } = harness('delivery_orders', { ...doRow('IN_TRANSIT'), customer_delivered_date: null }, false);
    const res = await patch(app, '/delivery-orders/do-1/status', 'DELIVERED');
    expect(res.status).toBe(200);
    expect(tables.delivery_orders![0]!.customer_delivered_date).toBe(todayMyt());
  });

  test('a day already typed on the board is kept', async () => {
    const { app, tables } = harness('delivery_orders', { ...doRow('IN_TRANSIT'), customer_delivered_date: '2026-11-01' }, false);
    expect((await patch(app, '/delivery-orders/do-1/status', 'DELIVERED')).status).toBe(200);
    expect(tables.delivery_orders![0]!.customer_delivered_date).toBe('2026-11-01');
  });

  test('a move that is not Delivered writes no date', async () => {
    const { app, tables } = harness('delivery_orders', { ...doRow('DISPATCHED'), customer_delivered_date: null }, false);
    expect((await patch(app, '/delivery-orders/do-1/status', 'IN_TRANSIT')).status).toBe(200);
    expect(tables.delivery_orders![0]!.customer_delivered_date).toBeNull();
  });
});

describe('DO cancel — a failed stock return can be retried', () => {
  test('re-cancelling a cancelled DO after the retry window re-runs the reversal', async () => {
    const { app, rpcCalls } = harness('delivery_orders', doRow('CANCELLED', new Date(Date.now() - 120_000).toISOString()), false);
    const res = await patch(app, '/delivery-orders/do-1/status', 'CANCELLED');
    expect(res.status).toBe(200);
    expect(rpcCalls).toContain('fn_reverse_do_out');
  });

  test('a double press inside the window does not run a second reversal', async () => {
    const { app, rpcCalls } = harness('delivery_orders', doRow('CANCELLED', new Date().toISOString()), false);
    const res = await patch(app, '/delivery-orders/do-1/status', 'CANCELLED');
    expect(res.status).toBe(200);
    expect(rpcCalls).not.toContain('fn_reverse_do_out');
  });

  test('cancelReversalRetryDue boundary', () => {
    expect(cancelReversalRetryDue(null, Date.now())).toBe(false);
    expect(cancelReversalRetryDue('2026-11-10T00:00:00Z', Date.parse('2026-11-10T00:00:59Z'))).toBe(false);
    expect(cancelReversalRetryDue('2026-11-10T00:01:00Z', Date.parse('2026-11-10T00:02:00Z'))).toBe(true);
  });
});

describe('Consignment Note status PATCH — compare-and-set on the status the guards read', () => {
  const noteRow = (status: string): Row => ({ id: 'cn-1', do_number: 'HC-CS-1', company_id: CO, status, warehouse_id: 'w1' });

  test('a cancel landing mid-request is not overwritten by a late Delivered', async () => {
    const { app, tables } = harness('consignment_delivery_orders', noteRow('DISPATCHED'), true);
    const res = await patch(app, '/consignment-notes/cn-1/status', 'DELIVERED');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('status_changed');
    expect(tables.consignment_delivery_orders![0]!.status).toBe('CANCELLED');
  });

  test('without a race the move still writes', async () => {
    const { app, tables } = harness('consignment_delivery_orders', noteRow('DISPATCHED'), false);
    const res = await patch(app, '/consignment-notes/cn-1/status', 'SIGNED');
    expect(res.status).toBe(200);
    expect(tables.consignment_delivery_orders![0]!.status).toBe('SIGNED');
  });
});
