import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const grnInserts: Row[] = [];

const base = fakeSb({
  grns: [],
  grn_items: [],
  mfg_products: [],
  purchase_orders: [],
  purchase_order_items: [],
  warehouses: [{ id: 'wh-1', company_id: 1, is_default: true, code: 'KL' }],
  inventory_movements: [],
  entity_audit_log: [],
  app_config: [],
});

const sb = Object.assign(
  {
    ...base,
    from(table: string) {
      const b = base.from(table);
      if (table === 'grns') {
        const origInsert = b.insert.bind(b);
        b.insert = (payload: Row | Row[]) => {
          for (const r of Array.isArray(payload) ? payload : [payload]) {
            if (r && typeof r === 'object' && 'grn_number' in r) grnInserts.push(r);
          }
          return origInsert(payload);
        };
      }
      return b;
    },
  },
  { rpc: async () => ({ data: true, error: null }) },
);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { grns } = await import('./grns');

const POSTER = { ...CALLER, permissions: [], position_capabilities: ['scm.grn.post'] };

async function createPosted(sessionUser: unknown = POSTER) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', sessionUser as User);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', grns);
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      supplierId: 'sup-1',
      warehouseId: 'wh-1',
      items: [{
        materialKind: 'mfg_product', itemCode: 'X-1', materialName: 'Widget',
        qtyReceived: 1, qtyAccepted: 1, unitPriceSen: 10000, unitCostSen: 10000,
      }],
    }),
  });
}

describe('GRN create is atomic — inserted DRAFT, never a phantom POSTED', () => {
  it('inserts a create-as-posted GRN with status DRAFT and null posted_at', async () => {
    await createPosted().catch(() => undefined);
    expect(grnInserts.length).toBeGreaterThan(0);
    const header = grnInserts[grnInserts.length - 1]!;
    expect(header.status).toBe('DRAFT');
    expect(header.posted_at).toBeNull();
  });

  it('refuses create-as-posted for a caller without Post GRN, before inserting anything', async () => {
    const before = grnInserts.length;
    const res = await createPosted({ ...CALLER, permissions: [], position_capabilities: ['scm.do.load'] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('capability_required');
    expect(grnInserts.length).toBe(before);
  });
});
