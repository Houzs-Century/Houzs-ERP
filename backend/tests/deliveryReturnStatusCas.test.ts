/* A DELIVERY RETURN STATUS MOVE IS COMPARE-AND-SET.
 *
 * patchDeliveryReturnStatusHandler reads the current status, gates on it
 * (CANCELLED is final), then writes. Before this fix only the CANCELLED write
 * was conditional; RECEIVED / INSPECTED / REFUNDED wrote with `.eq('id')` alone.
 * So a REFUNDED that read RECEIVED, then lost the race to a cancel that drained
 * the stock, still landed — the return read REFUNDED with its goods taken back
 * out, the exact state `dr_cancelled_final` exists to forbid.
 *
 * The race is reproduced by a fake client that flips the row between the
 * handler's read and its write (the window a concurrent request lands in).
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryReturnStatusHandler } from '../src/scm/routes/delivery-returns';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' = 'select';
  private patch: Row = {};
  constructor(private rows: Row[], private afterRead: () => void) {}
  select() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  is() { return this; }
  not() { return this; }
  private run(): Row[] {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() {
    const h = this.run().map((r) => ({ ...r }));
    if (this.op === 'select') this.afterRead();
    return Promise.resolve({ data: h[0] ?? null, error: null });
  }
  single() {
    const h = this.run().map((r) => ({ ...r }));
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'PGRST116: no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/* `concurrent` runs once, right after the handler's FIRST status read — i.e.
   another request committing between this one's read and its write. */
function harness(rows: Row[], concurrent: (row: Row) => void = () => {}) {
  let fired = false;
  const afterRead = () => { if (!fired) { fired = true; concurrent(rows[0]); } };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery(t === 'delivery_returns' ? rows : [], afterRead),
      rpc: async () => ({ data: null, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, permissions: ['*'] } as never);
    await next();
  });
  app.patch('/delivery-returns/:id/status', patchDeliveryReturnStatusHandler as never);
  return app;
}

const patch = (app: Hono, status: string) =>
  app.request('/delivery-returns/dr-1/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  }, { DELIVERY_RETURN_MODE: 'two-step' }); // no database behind these fakes; deliveryReturnAtomic.test.ts covers atomic

const row = (status: string): Row => ({ id: 'dr-1', company_id: CO, return_number: 'DR-1', status, warehouse_id: 'wh-1' });

describe('delivery return status writes are compare-and-set', () => {
  test('a REFUNDED that lost the race to a cancel does not reactivate the return', async () => {
    const rows = [row('INSPECTED')];
    const app = harness(rows, (r) => { r.status = 'CANCELLED'; });
    const res = await patch(app, 'REFUNDED');
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, any>;
    expect(body.error).toBe('status_changed');
    expect(body.currentStatus).toBe('CANCELLED');
    expect(String(body.message)).toMatch(/changed by someone else/);
    expect(rows[0].status).toBe('CANCELLED');
    expect(rows[0].refunded_at).toBeUndefined();
  });

  test('a stale INSPECTED does not overwrite a REFUNDED that landed first', async () => {
    const rows = [row('RECEIVED')];
    const app = harness(rows, (r) => { r.status = 'REFUNDED'; });
    const res = await patch(app, 'INSPECTED');
    expect(res.status).toBe(409);
    expect(rows[0].status).toBe('REFUNDED');
  });

  test('a cancel that read RECEIVED but finds REFUNDED is refused, not applied over it', async () => {
    const rows = [row('RECEIVED')];
    const app = harness(rows, (r) => { r.status = 'REFUNDED'; });
    const res = await patch(app, 'CANCELLED');
    expect(res.status).toBe(409);
    expect(rows[0].status).toBe('REFUNDED');
  });

  test('two cancels racing: the loser echoes CANCELLED instead of failing', async () => {
    const rows = [row('RECEIVED')];
    const app = harness(rows, (r) => { r.status = 'CANCELLED'; });
    const res = await patch(app, 'CANCELLED');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.deliveryReturn).toEqual({ id: 'dr-1', status: 'CANCELLED' });
  });

  test('with no race the move still lands and stamps its timestamp', async () => {
    const rows = [row('INSPECTED')];
    const app = harness(rows);
    const res = await patch(app, 'REFUNDED');
    expect(res.status).toBe(200);
    expect(rows[0].status).toBe('REFUNDED');
    expect(typeof rows[0].refunded_at).toBe('string');
  });

  test('another company\'s return is still a 404', async () => {
    const rows = [{ ...row('INSPECTED'), company_id: 2 }];
    const app = harness(rows);
    const res = await patch(app, 'REFUNDED');
    expect(res.status).toBe(404);
    expect(rows[0].status).toBe('INSPECTED');
  });
});
