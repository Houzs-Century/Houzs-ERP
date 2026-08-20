// Owner 2026-08-20 (§8 GAP-1): the GRN header PATCH had NO downstream lock — a
// GRN that already has a Purchase Invoice / Purchase Return could have its
// supplier or costing basis (currency / exchange rate / allocation method)
// changed, silently diverging from the PI that was billed against it. Now those
// four columns freeze once a live PI/PR exists; received date / notes / warehouse
// stay editable. This drives the REAL header PATCH through the fake PostgREST
// client with a downstream PI present (a grn_items line with invoiced_qty > 0,
// which is what grnHasDownstream keys on) and asserts both halves.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = Object.assign(
  fakeSb({
    grns: [{
      id: 'grn-1', grn_number: 'GRN-2608-001', status: 'POSTED', company_id: 1,
      supplier_id: 'sup-1', received_at: '2026-08-10', delivery_note_ref: 'DN-1',
      warehouse_id: 'wh-1', notes: 'original', currency: 'MYR', exchange_rate: 1,
      allocation_method: 'value',
    }],
    // A line already invoiced downstream → grnHasDownstream() is true.
    grn_items: [{ id: 'li-1', company_id: 1, grn_id: 'grn-1', invoiced_qty: 3, returned_qty: 0 }],
    entity_audit_log: [],
    app_config: [],
  }),
  { rpc: async () => ({ data: true, error: null }) },
);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const grn = () => (sb.tables.grns[0] ?? {}) as Row;

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { grns } = await import('./grns');

async function patch(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', grns);
  return app.request('/grn-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH grn header — inherited-field lock with a downstream PI', () => {
  it('lets own-stage fields (notes) save even with a PI present', async () => {
    const res = await patch({ notes: 'updated remark' });
    expect(res.status).toBe(200);
    expect(grn().notes).toBe('updated remark');
  });

  it('refuses a supplier change (the PI was billed against it) and writes nothing', async () => {
    const res = await patch({ supplierId: 'sup-2' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'grn_header_inherited_locked' });
    expect(grn().supplier_id).toBe('sup-1');
  });

  it('refuses a currency change with a PI present', async () => {
    const res = await patch({ currency: 'USD' });
    expect(res.status).toBe(409);
    expect(grn().currency).toBe('MYR');
  });
});
