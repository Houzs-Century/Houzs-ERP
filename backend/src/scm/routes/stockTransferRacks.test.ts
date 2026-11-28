import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const KL = '11111111-1111-4111-8111-111111111111';
const PJ = '22222222-2222-4222-8222-222222222222';
const R_KL = 'aaaaaaaa-0000-4000-8000-000000000001';
const R_PJ = 'bbbbbbbb-0000-4000-8000-000000000001';

const rpcCalls: string[] = [];

function makeSb() {
  rpcCalls.length = 0;
  return Object.assign(
    fakeSb({
      warehouses: [
        { id: KL, code: 'WH-KL', company_id: 1 },
        { id: PJ, code: 'SR-PJ', company_id: 1 },
      ],
      warehouse_racks: [
        { id: R_KL, rack: 'L5.2', warehouse_id: KL, company_id: 1 },
        { id: R_PJ, rack: 'CA4', warehouse_id: PJ, company_id: 1 },
      ],
      warehouse_rack_items: [
        { id: 'ri-1', rack_id: R_KL, item_code: 'SKU-1', qty: 2, company_id: 1 },
      ],
      stock_transfers: [],
      stock_transfer_lines: [],
      v_inventory_lots_open: [],
      inventory_movements: [],
      entity_audit_log: [],
      app_config: [],
      doc_number_counters: [],
    }),
    {
      rpc: async (fn: string) => {
        rpcCalls.push(fn);
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        return { data: 1, error: null };
      },
    },
  );
}

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

let sb = makeSb();

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { stockTransfers } = await import('./stock-transfers');

async function create(items: Array<Record<string, unknown>>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', stockTransfers);
  return app.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromWarehouseId: KL, toWarehouseId: PJ, items }),
  });
}

const item = (o: Record<string, unknown>) => ({ itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty: 1, ...o });

describe('POST stock-transfers — optional racks', () => {
  it('refuses a From rack that holds less than the line moves, before writing anything', async () => {
    sb = makeSb();
    const res = await create([item({ qty: 3, fromRackId: R_KL })]);
    expect(res.status).toBe(409);
    expect(res.headers.get('Idempotency-Outcome')).toBe('no-write');
    expect(await res.json()).toMatchObject({ error: 'rack_short', message: expect.stringContaining('L5.2 holds only 2 of SKU-1') });
    expect(sb.tables.stock_transfers).toHaveLength(0);
    expect(rpcCalls.filter((f) => f.startsWith('fn_stock_transfer'))).toEqual([]);
  });

  it('refuses a To rack that belongs to the From warehouse', async () => {
    sb = makeSb();
    const res = await create([item({ toRackId: R_KL })]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'rack_not_in_warehouse' });
    expect(sb.tables.stock_transfers).toHaveLength(0);
  });

  it('refuses a rack value that is not a rack id', async () => {
    sb = makeSb();
    const res = await create([item({ fromRackId: 'L5.2' })]);
    expect(res.status).toBe(400);
    expect(res.headers.get('Idempotency-Outcome')).toBe('no-write');
    expect(await res.json()).toMatchObject({ error: 'invalid_rack' });
  });

  it('a line with racks saves them and posts through the racked function', async () => {
    sb = makeSb();
    const res = await create([item({ qty: 2, fromRackId: R_KL, toRackId: R_PJ })]);
    expect(res.status).toBe(201);
    expect(sb.tables.stock_transfer_lines[0]).toMatchObject({ from_rack_id: R_KL, to_rack_id: R_PJ });
    expect(rpcCalls).toContain('fn_stock_transfer_apply_racked');
    expect(rpcCalls).not.toContain('fn_stock_transfer_apply');
  });

  it('a transfer with no rack posts exactly as before', async () => {
    sb = makeSb();
    const res = await create([item({ qty: 5 })]);
    expect(res.status).toBe(201);
    expect(sb.tables.stock_transfer_lines[0]).not.toHaveProperty('from_rack_id');
    expect(rpcCalls).toContain('fn_stock_transfer_apply');
    expect(rpcCalls).not.toContain('fn_stock_transfer_apply_racked');
  });
});
