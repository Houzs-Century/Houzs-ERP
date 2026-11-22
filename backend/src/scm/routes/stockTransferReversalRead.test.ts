// Symptom / Cause / Fix: a reversal that cannot even read the movements it should take back answers ok:false with failed:0. The edit and
// cancel paths checked only `failed > 0`, so a failed read was taken as "nothing to reverse": the edit re-applied
// the transfer on top of movements never taken back (stock moved twice), and the cancel reported success while the
// stock stayed moved. The cancel's in-band failure also came back as a bare string, which the screen spread one
// character per line.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

function makeSb() {
  return Object.assign(
    fakeSb(
      {
        stock_transfers: [{
          id: 'st-1', transfer_no: 'HC-ST-2609-006', status: 'POSTED', company_id: 1,
          from_warehouse_id: 'wh-1', to_warehouse_id: 'wh-2', transfer_date: '2026-09-01',
          notes: null, posted_at: '2026-09-01T00:00:00Z', cancelled_at: null,
          created_at: '2026-09-01T00:00:00Z', created_by: null,
        }],
        stock_transfer_lines: [
          { id: 'li-1', stock_transfer_id: 'st-1', item_code: 'SKU-1', product_name: 'Sofa', variant_key: '', qty: 2, notes: null, created_at: '2026-09-01T00:00:00Z' },
        ],
        v_inventory_lots_open: [
          { warehouse_id: 'wh-1', item_code: 'SKU-1', variant_key: '', qty_remaining: 6, company_id: 1 },
        ],
        inventory_movements: [],
        entity_audit_log: [],
        app_config: [],
      },
      // The read the reversal makes fails, as a transient PostgREST error would.
      { inventory_movements: ['movement_type'] },
    ),
    { rpc: async () => ({ data: true, error: null }) },
  );
}

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

let sb = makeSb();
const lines = () => sb.tables.stock_transfer_lines.filter((r) => r.stock_transfer_id === 'st-1') as Row[];

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { stockTransfers } = await import('./stock-transfers');

function app() {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  a.route('/', stockTransfers);
  return a;
}

describe('stock transfer: a reversal that could not read its movements', () => {
  it('stops an item edit before the lines are replaced or re-applied', async () => {
    sb = makeSb();
    const res = await app().request('/st-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty: 3 }] }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'reversal_incomplete' });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.qty).toBe(2);
  });

  it('reports the cancel\'s failed reversal as a list the screen can show', async () => {
    sb = makeSb();
    const res = await app().request('/st-1/cancel', { method: 'PATCH' });
    const body = await res.json() as { reversalErrors?: unknown };
    expect(Array.isArray(body.reversalErrors)).toBe(true);
    expect((body.reversalErrors as string[])[0]).toMatch(/movement_type/);
  });
});

/* Symptom: a cancelled stock transfer whose stock did not come back could not be retried.
   Cause: a second cancel answered 409 already_cancelled.
   Fix: Cancel again re-runs the idempotent reversal; the detail says stockNotBack while stock is still owed. */
describe('stock transfer: a cancel whose stock did not come back can be finished', () => {
  it('Cancel again re-runs the reversal, and the detail says when it is still owed', async () => {
    const missing: Record<string, string[]> = { inventory_movements: ['movement_type'] };
    sb = Object.assign(fakeSb({
      stock_transfers: [{
        id: 'st-1', transfer_no: 'HC-ST-2609-006', status: 'POSTED', company_id: 1,
        from_warehouse_id: 'wh-1', to_warehouse_id: 'wh-2', transfer_date: '2026-09-01',
        notes: null, posted_at: '2026-09-01T00:00:00Z', cancelled_at: null, created_at: '2026-09-01T00:00:00Z', created_by: null,
      }],
      stock_transfer_lines: [],
      inventory_movements: [
        { id: 'm-out', movement_type: 'OUT', warehouse_id: 'wh-1', item_code: 'SKU-1', variant_key: '', qty: 2, source_doc_type: 'STOCK_TRANSFER', source_doc_id: 'st-1', source_doc_no: 'HC-ST-2609-006', company_id: 1 },
        { id: 'm-in', movement_type: 'IN', warehouse_id: 'wh-2', item_code: 'SKU-1', variant_key: '', qty: 2, unit_cost_sen: 100, source_doc_type: 'STOCK_TRANSFER', source_doc_id: 'st-1', source_doc_no: 'HC-ST-2609-006', company_id: 1 },
      ],
      entity_audit_log: [], app_config: [],
    }, missing), { rpc: async () => ({ data: true, error: null }) });

    const first = await app().request('/st-1/cancel', { method: 'PATCH' });
    expect(((await first.json()) as { reversalErrors?: string[] }).reversalErrors?.length).toBe(1);
    expect(sb.tables.stock_transfers[0]!.status).toBe('CANCELLED');

    /* The read works again. The detail offers the finish, and Cancel again moves the stock back. */
    delete missing.inventory_movements;
    const detail = await app().request('/st-1');
    expect(((await detail.json()) as { stockNotBack?: boolean }).stockNotBack).toBe(true);
    const again = await app().request('/st-1/cancel', { method: 'PATCH' });
    expect(again.status).toBe(200);
    const body = await again.json() as { resumed?: boolean; reversal?: { reversed: number }; reversalErrors?: unknown };
    expect(body.resumed).toBe(true);
    expect(body.reversal?.reversed).toBe(2);
    expect(body.reversalErrors).toBeUndefined();
    const after = await app().request('/st-1');
    expect(((await after.json()) as { stockNotBack?: boolean }).stockNotBack).toBe(false);
  });
});
