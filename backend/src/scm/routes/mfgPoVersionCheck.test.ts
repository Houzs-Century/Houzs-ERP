// Sister review G6: two buyers with the same PO open. The editor re-sends the
// whole header, so the second Save silently put back what the first had saved.
// The header PATCH now carries the updated_at the editor loaded and refuses a
// stale one. Drives the REAL header PATCH through the fake PostgREST client.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';
import { poVersionRefusal } from '../lib/po-version';

const sb = fakeSb({ purchase_orders: [], purchase_order_items: [], grns: [], app_config: [], entity_audit_log: [] });
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;
const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function patch(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('user', CALLER); c.set('companyId', 1); await next(); });
  app.route('/', mfgPurchaseOrders);
  return app.request('/po-1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const LOADED = '2026-11-01T02:00:00.123456+00:00';
const po = () => (sb.tables.purchase_orders[0] ?? {}) as Row;

beforeEach(() => {
  sb.tables.purchase_orders = [{
    id: 'po-1', po_number: 'PO-2611-001', status: 'SUBMITTED', company_id: 1, updated_at: LOADED,
    po_date: '2026-11-01', expected_at: '2026-11-10', currency: 'MYR', notes: 'original',
    supplier_id: 'sup-1', purchase_location_id: null,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  }];
  sb.tables.purchase_order_items = [];
  sb.tables.entity_audit_log = [];
});

describe('PO header PATCH: the loaded version must still be current', () => {
  it('the second buyer, holding the version from before the first Save, is refused and writes nothing', async () => {
    const first = await patch({ expectedUpdatedAt: LOADED, notes: 'buyer A' });
    expect(first.status).toBe(200);
    const second = await patch({ expectedUpdatedAt: LOADED, notes: 'original', supplierId: 'sup-1' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('po_version_conflict');
    expect(po().notes).toBe('buyer A');
  });

  it('a save without the loaded version is refused (428), not last-writer-wins', async () => {
    const res = await patch({ notes: 'no token' });
    expect(res.status).toBe(428);
    expect(((await res.json()) as { error: string }).error).toBe('po_version_required');
    expect(po().notes).toBe('original');
  });

  it('a version-only save claims the version without an audit row or a field change', async () => {
    const res = await patch({ expectedUpdatedAt: LOADED });
    expect(res.status).toBe(200);
    expect(po().notes).toBe('original');
    expect(po().updated_at).not.toBe(LOADED);
    expect(sb.tables.entity_audit_log).toHaveLength(0);
  });
});

describe('poVersionRefusal', () => {
  it('reads the same instant written two ways as current', () => {
    expect(poVersionRefusal({ expectedUpdatedAt: '2026-11-01T02:00:00.123Z' }, LOADED)).toBeNull();
  });
  it('a different instant is a conflict; a blank token is required', () => {
    expect(poVersionRefusal({ expectedUpdatedAt: '2026-11-01T02:00:01.123Z' }, LOADED)?.status).toBe(409);
    expect(poVersionRefusal({ expectedUpdatedAt: '' }, LOADED)?.status).toBe(428);
    expect(poVersionRefusal({ expectedUpdatedAt: 'garbage' }, LOADED)?.status).toBe(409);
  });
});
