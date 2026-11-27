import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

function makeSb() {
  return Object.assign(
    fakeSb({
      warehouses: [
        { id: 'wh-1', company_id: 1 },
        { id: 'wh-2', company_id: 1 },
      ],
      stock_transfers: [
        {
          id: 'st-1', transfer_no: 'HC-ST-2611-001', status: 'POSTED', company_id: 1,
          from_warehouse_id: 'wh-1', to_warehouse_id: 'wh-2', transfer_date: '2026-11-01',
          notes: null, posted_at: '2026-11-01T00:00:00Z', cancelled_at: null,
          created_at: '2026-11-01T00:00:00Z', created_by: null,
        },
      ],
      stock_transfer_lines: [
        { id: 'li-1', stock_transfer_id: 'st-1', item_code: 'SKU-1', product_name: 'Sofa', variant_key: '', qty: 2, notes: null, created_at: '2026-11-01T00:00:00Z' },
      ],
      v_inventory_lots_open: [
        { warehouse_id: 'wh-1', item_code: 'SKU-1', variant_key: '', qty_remaining: 5, company_id: 1 },
      ],
      inventory_movements: [],
      entity_audit_log: [],
      app_config: [],
    }),
    { rpc: async () => ({ data: true, error: null }) },
  );
}

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

let sb = makeSb();

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const OVERRIDE = 'scm.stock_transfer.allow_short';

const { stockTransfers } = await import('./stock-transfers');

function call(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>, perms: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { ...CALLER, permissions: perms } as never);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', stockTransfers);
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const create = (qty: number, perms: string[], extra: Record<string, unknown> = {}) => call('POST', '/', {
  fromWarehouseId: 'wh-1', toWarehouseId: 'wh-2',
  items: [{ itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty }],
  ...extra,
}, perms);

const newTransfers = () => sb.tables.stock_transfers.filter((r) => r.id !== 'st-1') as Row[];

describe('POST stock-transfers — qty above what the source warehouse holds', () => {
  it('409s with the shortage and writes nothing when the caller may not override', async () => {
    sb = makeSb();
    const res = await create(9, []);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'insufficient_stock',
      canOverride: false,
      shortages: [{ itemCode: 'SKU-1', variantKey: '', requested: 9, available: 5 }],
    });
    expect(newTransfers()).toHaveLength(0);
  });

  it('still warns a holder of the override who did not ask for it, and says they may', async () => {
    sb = makeSb();
    const res = await create(9, [OVERRIDE]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'insufficient_stock', canOverride: true });
    expect(newTransfers()).toHaveLength(0);
  });

  it('ignores allowShortStock from a caller without the permission', async () => {
    sb = makeSb();
    const res = await create(9, [], { allowShortStock: true });
    expect(res.status).toBe(409);
    expect(newTransfers()).toHaveLength(0);
  });

  it('posts when the holder confirms, and the audit row names the short item', async () => {
    sb = makeSb();
    const res = await create(9, [OVERRIDE], { allowShortStock: true });
    expect(res.status).toBe(201);
    expect(newTransfers()).toHaveLength(1);
    const audit = sb.tables.entity_audit_log.at(-1) as Row;
    expect(String(audit.note)).toContain('short stock (override)');
    expect(String(audit.note)).toContain('SKU-1: requested 9, only 5 available');
  });

  it('posts without any warning when the stock is there (boundary: exactly what is held)', async () => {
    sb = makeSb();
    const res = await create(5, []);
    expect(res.status).toBe(201);
    expect(newTransfers()).toHaveLength(1);
  });

  it('adds lines of the same item together before comparing', async () => {
    sb = makeSb();
    const res = await call('POST', '/', {
      fromWarehouseId: 'wh-1', toWarehouseId: 'wh-2',
      items: [{ itemCode: 'SKU-1', variantKey: '', qty: 3 }, { itemCode: 'SKU-1', variantKey: '', qty: 3 }],
    }, []);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ shortages: [{ requested: 6, available: 5 }] });
  });
});

describe('PATCH stock-transfers/:id — short-stock override on an item edit', () => {
  it('409s for a caller without the permission (available = open 5 + the 2 this transfer already took)', async () => {
    sb = makeSb();
    const res = await call('PATCH', '/st-1', { items: [{ itemCode: 'SKU-1', variantKey: '', qty: 9 }] }, []);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ canOverride: false, shortages: [{ requested: 9, available: 7 }] });
  });

  it('applies the edit when the holder confirms', async () => {
    sb = makeSb();
    const res = await call('PATCH', '/st-1', { items: [{ itemCode: 'SKU-1', variantKey: '', qty: 9 }], allowShortStock: true }, [OVERRIDE]);
    expect(res.status).toBe(200);
    const line = sb.tables.stock_transfer_lines.find((r) => r.stock_transfer_id === 'st-1') as Row;
    expect(line.qty).toBe(9);
  });
});
