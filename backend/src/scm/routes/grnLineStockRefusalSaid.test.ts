import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const REFUSAL = 'movement sink refused';

function makeSb() {
  const base = fakeSb({
    grns: [{ id: 'grn-1', grn_number: 'GRN-2611-001', status: 'POSTED', company_id: 1, purchase_order_id: null, warehouse_id: 'wh-1', exchange_rate: 1 }],
    grn_items: [
      { id: 'li-1', company_id: 1, grn_id: 'grn-1', purchase_order_item_id: null, item_code: 'BED-A', material_name: 'Bed A', item_group: 'bedframe', variants: null, qty_received: 2, qty_accepted: 2, unit_price_sen: 10000, discount_sen: 0, line_total_sen: 20000, version: 1 },
    ],
    purchase_order_items: [],
    inventory_movements: [],
    inventory_balances: [{ warehouse_id: 'wh-1', item_code: 'BED-A', variant_key: '', qty_on_hand: 50, company_id: 1 }],
    v_inventory_lots_open: [{ warehouse_id: 'wh-1', item_code: 'BED-A', variant_key: '', qty_remaining: 50, company_id: 1 }],
    warehouses: [{ id: 'wh-1', code: 'KL', company_id: 1, is_default: true }],
    entity_audit_log: [],
    app_config: [],
  });
  const realFrom = base.from;
  (base as { from: unknown }).from = (t: string) => {
    const q = realFrom(t);
    if (t === 'inventory_movements') {
      q.insert = () => ({ then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: REFUSAL } }).then(res) });
    }
    return q;
  };
  return Object.assign(base, { rpc: async () => ({ data: true, error: null }) });
}

let sb = makeSb();
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { grns } = await import('./grns');

function app() {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  a.route('/', grns);
  return a;
}

describe('posted GRN line writes report a refused stock write', () => {
  it('a line added to a posted receipt answers 201 with movementErrors', async () => {
    sb = makeSb();
    const res = await app().request('/grn-1/items', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemCode: 'BED-A', materialName: 'Bed A', qty: 3, unitPriceSen: 10000 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { item?: unknown; movementErrors?: string[] };
    expect(body.item).toBeTruthy();
    expect(body.movementErrors?.join(' ')).toContain(REFUSAL);
  });

  it('a qty edit on a posted receipt answers with movementErrors', async () => {
    sb = makeSb();
    const res = await app().request('/grn-1/items/li-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok?: boolean; movementErrors?: string[] };
    expect(body.ok).toBe(true);
    expect(body.movementErrors?.join(' ')).toContain(REFUSAL);
  });
});
