// ATOMICITY (2026-09-23): a create-as-posted GRN must be INSERTED as DRAFT, then
// flipped to POSTED by postGrnAndRollup (the one chokepoint that also writes
// stock IN + rolls up the PO received_qty). Inserting it POSTED first and posting
// in a separate step left a phantom POSTED GRN — status POSTED, no posted_at, no
// stock, PO still outstanding — whenever the request died in between
// (HC-GRN-2609-118, the 2026-09-22 Worker crashes). This drives the REAL create
// route and asserts the row is inserted DRAFT with a null posted_at.
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

// Wrap from('grns').insert to record every inserted header payload.
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

async function createPosted() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
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
      // A manual (no purchaseOrderItemId) priced line — skips the PO over-receipt
      // and zero-cost gates, so the create reaches its header insert cleanly.
      items: [{
        materialKind: 'mfg_product', itemCode: 'X-1', materialName: 'Widget',
        qtyReceived: 1, qtyAccepted: 1, unitPriceSen: 10000, unitCostSen: 10000,
      }],
    }),
  });
}

describe('GRN create is atomic — inserted DRAFT, never a phantom POSTED', () => {
  it('inserts a create-as-posted GRN with status DRAFT and null posted_at', async () => {
    // The post chokepoint may or may not run to completion under the fake; either
    // way the header must have been INSERTED as DRAFT, which is the fix.
    await createPosted().catch(() => undefined);
    expect(grnInserts.length).toBeGreaterThan(0);
    const header = grnInserts[grnInserts.length - 1]!;
    expect(header.status).toBe('DRAFT');
    expect(header.posted_at).toBeNull();
  });
});
