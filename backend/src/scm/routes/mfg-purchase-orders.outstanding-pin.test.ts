// PINS GET /mfg-purchase-orders/outstanding-so-items, so overlapping its reads
// (perf/do-create-and-picker) can be shown to change nothing: the pooled MRP
// shortage path, the degraded picked-cap path when MRP throws, and the header
// gates (cancelled / draft / on-hold / held orders). Snapshotted against the
// code before that change.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const head = (doc: string, status: string, extra: Row = {}): Row => ({
  doc_no: doc, debtor_name: `Cust ${doc}`, branding: 'Houzs', status, on_hold: false, so_date: '2026-10-01',
  customer_delivery_date: '2026-11-01', processing_date: null, sales_location: 'PJ', ref: null, customer_so_no: null, ...extra,
});
const line = (id: string, so: Row, code: string, qty: number, picked: number): Row => ({
  id, doc_no: so.doc_no, company_id: 1, item_code: code, description: code, item_group: 'ACCESSORY', qty,
  po_qty_picked: picked, unit_price_sen: 5000, variants: {}, line_suffix: null, cancelled: false,
  line_delivery_date: null, so,
});

function world(): Record<string, Row[]> {
  const a = head('SO-A', 'CONFIRMED');
  const b = head('SO-B', 'CONFIRMED', { ref: 'R-B', customer_so_no: 'C-B' });
  return {
    mfg_sales_order_items: [
      line('a1', a, 'PIL-1', 4, 1),
      line('a2', a, 'MAT-1', 2, 2),
      line('a3', a, 'UNBOUND-1', 3, 0),
      line('b1', b, 'PIL-1', 6, 0),
      line('c1', head('SO-C', 'DRAFT'), 'PIL-1', 2, 0),
      line('d1', head('SO-D', 'ON_HOLD'), 'PIL-1', 2, 0),
      line('e1', head('SO-E', 'CANCELLED'), 'PIL-1', 2, 0),
      line('f1', head('SO-F', 'CONFIRMED', { on_hold: true }), 'PIL-1', 2, 0),
      { ...line('g1', head('SO-G', 'CONFIRMED'), 'PIL-1', 2, 0), cancelled: true },
      { ...line('h1', head('SO-H', 'CONFIRMED'), 'PIL-1', 2, 0), company_id: 2 },
    ],
    supplier_material_bindings: [
      { item_code: 'PIL-1', material_kind: 'mfg_product', company_id: 1, is_main_supplier: false, supplier: { code: 'S2', name: 'Second' } },
      { item_code: 'MAT-1', material_kind: 'mfg_product', company_id: 1, is_main_supplier: true, supplier: { code: 'S1', name: 'First' } },
    ],
  };
}

const mrp = vi.hoisted(() => ({ result: null as unknown, fail: false }));
vi.mock('./mrp', async (orig) => ({
  ...(await orig<typeof import('./mrp')>()),
  computeMrp: vi.fn(async () => { if (mrp.fail) throw new Error('mrp down'); return mrp.result; }),
}));
vi.mock('../../services/agents/procurement-learning', async (orig) => ({
  ...(await orig<typeof import('../../services/agents/procurement-learning')>()),
  loadLeadBuffers: vi.fn(async () => ({})),
}));

let current = fakeSb(world());
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => current }));

const CALLER = {
  id: '7', email: 'ops@houzs.test', app_metadata: {},
  user_metadata: { name: 'Ops' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function get() {
  current = fakeSb(world());
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', current as unknown as Variables['supabase']);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  const res = await app.request('/outstanding-so-items', { method: 'GET' }, { DB: {} } as unknown as Env);
  return { status: res.status, body: await res.json() };
}

describe('GET /outstanding-so-items — pinned', () => {
  it('pooled MRP shortage decides which lines show and how much remains', async () => {
    mrp.fail = false;
    mrp.result = {
      skus: [{ lines: [{ soItemId: 'a1', shortageQty: 2 }, { soItemId: 'a2', shortageQty: 0 }, { soItemId: 'c1', shortageQty: 5 }] }],
      sofaSets: [{ soItemId: 'b1', shortageQty: 6 }],
    };
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toMatchSnapshot();
  });

  it('MRP failing degrades to qty - picked', async () => {
    mrp.fail = true;
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toMatchSnapshot();
  });
});
