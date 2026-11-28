/* docs/bugs/README.md "A best-effort side effect" (audit 2026-11-28, H1 + H2).
 *
 * writeMovements never throws: it returns { ok:false, reason }. Two GRN routes
 * discarded that result:
 *   - DELETE /:id/items/:itemId removed the line and answered 204 while the
 *     reversing OUT had failed, so the received stock stayed on hand;
 *   - PATCH /:id saved the new warehouse on the header while the OUT old / IN new
 *     relocation had failed, so the GRN named warehouse B with the goods in A.
 *
 * Driven through the real `grns` router with a fake PostgREST client whose
 * inventory_movements INSERT can be made to fail. runScmPgCommand is replaced by
 * its contract (a non-2xx response rolls every write back), which is what the
 * delete relies on. */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../src/scm/lib/pg-supabase-transaction', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Hono context
  runScmPgCommand: async (c: any, command: (sb: unknown) => Promise<Response>) => {
    const tables = c.get('tables') as Record<string, Row[]>;
    const snapshot = JSON.parse(JSON.stringify(tables)) as Record<string, Row[]>;
    const res = await command(c.get('supabase'));
    if (!res.ok) for (const k of Object.keys(tables)) tables[k] = snapshot[k] ?? [];
    return res;
  },
}));
vi.mock('../src/scm/lib/stock-allocation-job', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  scheduleStockAllocationAfterCommand: async () => undefined,
  recomputeAllocationAfterSave: async () => undefined,
}));

const { grns } = await import('../src/scm/routes/grns');

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private tables: Record<string, Row[]>, private table: string, private failInsert: Set<string>) {}
  private get rows(): Row[] { return (this.tables[this.table] ||= []); }
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
  not() { return this; } like() { return this; } ilike() { return this; } or() { return this; }
  private run(): { data: Row[]; error: { message: string } | null } {
    if (this.op === 'insert') {
      if (this.failInsert.has(this.table)) return { data: [], error: { message: 'movement sink refused' } };
      this.rows.push(...this.inserted);
      return { data: this.inserted, error: null };
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return { data: hit, error: null };
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error }); }
  single() {
    const r = this.run();
    return Promise.resolve({ data: r.data[0] ?? null, error: r.error ?? (r.data.length ? null : { message: 'no rows' }) });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, failInsert: string[]) {
  const fail = new Set(failInsert);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tables' as never, tables as never);
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery(tables, t, fail),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.route('/grns', grns);
  return app;
}

function fixture(): Record<string, Row[]> {
  return {
    grns: [{
      id: 'grn-1', company_id: CO, status: 'POSTED', grn_number: 'GRN-2611-001',
      warehouse_id: 'wh-a', migrated_no_stock: false, currency: 'MYR', exchange_rate: 1,
      supplier_id: 'sup-1',
    }],
    grn_items: [{
      id: 'gi-1', grn_id: 'grn-1', company_id: CO, purchase_order_item_id: null, qty_accepted: 3,
      qty_received: 3, item_code: 'MATT-A', material_name: 'Mattress A', unit_price_sen: 10_000,
      item_group: 'MATTRESS', variants: null, invoiced_qty: 0, returned_qty: 0,
    }],
    warehouses: [
      { id: 'wh-a', company_id: CO, code: 'A', is_default: true },
      { id: 'wh-b', company_id: CO, code: 'B', is_default: false },
    ],
    inventory_balances: [{ warehouse_id: 'wh-a', item_code: 'MATT-A', variant_key: '', qty: 10 }],
    inventory_movements: [],
  };
}

describe('DELETE /grns/:id/items/:itemId on a POSTED GRN (H1)', () => {
  test('a refused reversing OUT fails the request and the line stays', async () => {
    const tables = fixture();
    const res = await harness(tables, ['inventory_movements']).request('/grns/grn-1/items/gi-1', { method: 'DELETE' });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'stock_reversal_failed' });
    expect(tables.grn_items!.map((r) => r.id)).toEqual(['gi-1']);
    expect(tables.inventory_movements).toEqual([]);
  });

  test('when the OUT is written the line is removed', async () => {
    const tables = fixture();
    const res = await harness(tables, []).request('/grns/grn-1/items/gi-1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(tables.grn_items).toEqual([]);
    expect(tables.inventory_movements).toEqual([
      expect.objectContaining({ movement_type: 'OUT', warehouse_id: 'wh-a', item_code: 'MATT-A', qty: 3 }),
    ]);
  });
});

describe('PATCH /grns/:id warehouse change on a POSTED GRN (H2)', () => {
  const patch = (tables: Record<string, Row[]>, fail: string[]) => harness(tables, fail).request('/grns/grn-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ warehouseId: 'wh-b' }),
  });

  test('a refused relocation fails the request and the header keeps the old warehouse', async () => {
    const tables = fixture();
    const res = await patch(tables, ['inventory_movements']);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'relocate_failed' });
    expect(tables.grns![0]!.warehouse_id).toBe('wh-a');
    expect(tables.inventory_movements).toEqual([]);
  });

  test('when the relocation is written the header moves with it', async () => {
    const tables = fixture();
    const res = await patch(tables, []);

    expect(res.status).toBe(200);
    expect(tables.grns![0]!.warehouse_id).toBe('wh-b');
    expect(tables.inventory_movements!.map((m) => [m.movement_type, m.warehouse_id, m.qty])).toEqual([
      ['OUT', 'wh-a', 3],
      ['IN', 'wh-b', 3],
    ]);
  });
});
