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
    id: 'po-1', po_number: 'PO-2611-001', status: 'SUBMITTED', company_id: 1, updated_at: LOADED, version: 1,
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

/* The database half (mig 20261110T2000). Two Saves fired together both read the
   row before either writes, so both pass the token compare above; only the
   compare-and-set on `version` can let exactly one through. */
describe('PO header PATCH: two Saves at the same instant', () => {
  it('exactly one succeeds, and the stored notes are the winner\'s', async () => {
    const [a, b] = await Promise.all([
      patch({ expectedUpdatedAt: LOADED, notes: 'buyer A' }),
      patch({ expectedUpdatedAt: LOADED, notes: 'buyer B' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(((await loser.json()) as { error: string }).error).toBe('po_version_conflict');
    expect(po().notes).toBe(a.status === 200 ? 'buyer A' : 'buyer B');
    expect(sb.tables.entity_audit_log).toHaveLength(1);
  });

  it('each successful Save moves the version on by one', async () => {
    const first = await patch({ expectedUpdatedAt: LOADED, notes: 'one' });
    const { purchaseOrder } = (await first.json()) as { purchaseOrder: Row };
    expect(purchaseOrder.version).toBe(2);
    const second = await patch({ expectedUpdatedAt: purchaseOrder.updated_at, notes: 'two' });
    expect(second.status).toBe(200);
    expect(po().version).toBe(3);
  });

  it('a Save whose version was claimed after its read is refused before any write', async () => {
    /* Another Save claims the next version between this one's read and its
       first write: the exact window the token compare cannot see. */
    const realFrom = sb.from;
    let raced = false;
    sb.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'purchase_orders' || raced) return q;
      const realUpdate = q.update.bind(q);
      q.update = (p: Row) => { raced = true; po().version = 7; return realUpdate(p); };
      return q;
    }) as typeof sb.from;
    try {
      const res = await patch({ expectedUpdatedAt: LOADED, notes: 'late' });
      expect(raced).toBe(true);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('po_version_conflict');
      expect(po().notes).toBe('original');
      expect(po().updated_at).toBe(LOADED);
    } finally {
      sb.from = realFrom;
    }
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
