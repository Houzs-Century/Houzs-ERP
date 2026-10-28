// The Stock Transfer detail page was read-only by design (no draft stage,
// stock already posted on create). The owner asked first for a notes-only
// Edit, then for item/qty/SKU to be editable too, with a hard stop against
// pushing a warehouse's stock negative. This drives the REAL PATCH /:id
// through the fake PostgREST client and asserts:
//   - header + line notes save without touching qty/item (notes-only path)
//   - a full item/qty/SKU replace (`items`) re-applies movements and the
//     line rows actually change
//   - a replace that would take the source warehouse negative 409s BEFORE
//     any write (reversal, line delete/insert) happens
//   - items can only be edited while POSTED
//   - a transfer belonging to another company 404s instead of leaking a write
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

function makeSb() {
  return Object.assign(
    fakeSb({
      stock_transfers: [
        {
          id: 'st-1', transfer_no: 'HC-ST-2609-006', status: 'POSTED', company_id: 1,
          from_warehouse_id: 'wh-1', to_warehouse_id: 'wh-2', transfer_date: '2026-09-01',
          notes: 'original note', posted_at: '2026-09-01T00:00:00Z', cancelled_at: null,
          created_at: '2026-09-01T00:00:00Z', created_by: null,
        },
        {
          id: 'st-2', transfer_no: 'HC-ST-2609-007', status: 'POSTED', company_id: 2,
          from_warehouse_id: 'wh-1', to_warehouse_id: 'wh-2', transfer_date: '2026-09-01',
          notes: 'other company', posted_at: '2026-09-01T00:00:00Z', cancelled_at: null,
          created_at: '2026-09-01T00:00:00Z', created_by: null,
        },
        {
          id: 'st-3', transfer_no: 'HC-ST-2609-008', status: 'CANCELLED', company_id: 1,
          from_warehouse_id: 'wh-1', to_warehouse_id: 'wh-2', transfer_date: '2026-09-01',
          notes: 'was cancelled', posted_at: '2026-09-01T00:00:00Z', cancelled_at: '2026-09-02T00:00:00Z',
          created_at: '2026-09-01T00:00:00Z', created_by: null,
        },
      ],
      stock_transfer_lines: [
        { id: 'li-1', stock_transfer_id: 'st-1', item_code: 'SKU-1', product_name: 'Sofa', variant_key: '', qty: 2, notes: 'old line note', created_at: '2026-09-01T00:00:00Z' },
      ],
      // Open lots left at the SOURCE warehouse after the original OUT already
      // took 2 units of SKU-1 (say 8 were on hand, 2 shipped, 6 remain open).
      v_inventory_lots_open: [
        { warehouse_id: 'wh-1', item_code: 'SKU-1', variant_key: '', qty_remaining: 6, company_id: 1 },
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

const transfer = (id: string) => sb.tables.stock_transfers.find((r) => r.id === id) as Row;
const lines = (id: string) => sb.tables.stock_transfer_lines.filter((r) => r.stock_transfer_id === id) as Row[];

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { stockTransfers } = await import('./stock-transfers');

async function patch(id: string, body: Record<string, unknown>, companyId = 1) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', companyId);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', stockTransfers);
  return app.request(`/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH stock-transfers/:id — notes-only edit', () => {
  it('saves the header notes', async () => {
    const res = await patch('st-1', { notes: 'Repack done' });
    expect(res.status).toBe(200);
    expect(transfer('st-1').notes).toBe('Repack done');
  });

  it('refuses an empty body', async () => {
    const res = await patch('st-1', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'nothing_to_update' });
  });

  it('notes still save on a CANCELLED transfer (no items touched)', async () => {
    const res = await patch('st-3', { notes: 'late correction' });
    expect(res.status).toBe(200);
    expect(transfer('st-3').notes).toBe('late correction');
  });

  it('404s on another company\'s transfer and writes nothing', async () => {
    const res = await patch('st-2', { notes: 'should not land' }, 1);
    expect(res.status).toBe(404);
    expect(transfer('st-2').notes).toBe('other company');
  });
});

describe('PATCH stock-transfers/:id — item/qty/SKU replace', () => {
  it('replaces the line list and re-applies movements', async () => {
    sb = makeSb();
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty: 3, notes: 'recount' }],
    });
    expect(res.status).toBe(200);
    const ls = lines('st-1');
    expect(ls).toHaveLength(1);
    expect(ls[0]!.qty).toBe(3);
    expect(ls[0]!.notes).toBe('recount');
  });

  it('lets the SKU itself change', async () => {
    sb = makeSb();
    sb.tables.v_inventory_lots_open.push({ warehouse_id: 'wh-1', item_code: 'SKU-2', variant_key: '', qty_remaining: 10, company_id: 1 });
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-2', productName: 'Armchair', variantKey: '', qty: 1 }],
    });
    expect(res.status).toBe(200);
    const ls = lines('st-1');
    expect(ls).toHaveLength(1);
    expect(ls[0]!.item_code).toBe('SKU-2');
  });

  it('409s a qty that would push the source warehouse negative, and writes nothing', async () => {
    sb = makeSb();
    // Old line already has 2; current open is 6 → available after reversal is 8.
    // Ask for 9 → must refuse.
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-1', variantKey: '', qty: 9 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'insufficient_stock',
      shortages: [{ itemCode: 'SKU-1', variantKey: '', requested: 9, available: 8 }],
    });
    // Untouched: still the original line.
    const ls = lines('st-1');
    expect(ls).toHaveLength(1);
    expect(ls[0]!.qty).toBe(2);
  });

  it('allows exactly the available boundary (old qty + current open)', async () => {
    sb = makeSb();
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-1', variantKey: '', qty: 8 }],
    });
    expect(res.status).toBe(200);
    expect(lines('st-1')[0]!.qty).toBe(8);
  });

  it('refuses an item edit on a CANCELLED transfer', async () => {
    sb = makeSb();
    const res = await patch('st-3', {
      items: [{ itemCode: 'SKU-1', variantKey: '', qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_posted' });
  });

  it('rejects a non-positive qty and writes nothing', async () => {
    sb = makeSb();
    const res = await patch('st-1', { items: [{ itemCode: 'SKU-1', variantKey: '', qty: 0 }] });
    expect(res.status).toBe(400);
    expect(lines('st-1')[0]!.qty).toBe(2);
  });

  // Same (item_code, variant_key, qty) as before — only notes/display name
  // differ. Must NOT go through reverse+delete+insert+reapply (that would
  // needlessly touch inventory_movements for a line that never moved
  // differently, and would mint a NEW line id, silently orphaning anything
  // keyed on the old one). Asserted by the line id staying put.
  it('a same-bucket items edit (notes only) updates in place — no reverse/reapply, id unchanged', async () => {
    sb = makeSb();
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty: 2, notes: 'checked twice' }],
    });
    expect(res.status).toBe(200);
    const ls = lines('st-1');
    expect(ls).toHaveLength(1);
    expect(ls[0]!.id).toBe('li-1');
    expect(ls[0]!.notes).toBe('checked twice');
    expect(ls[0]!.qty).toBe(2);
  });

  it('a same-bucket edit skips the stock check entirely — even a qty that LOOKS short is fine because nothing is moving', async () => {
    sb = makeSb();
    // Drain the open lots to 0 — a real qty change of 2 would now 409, but
    // asking for the SAME qty (2) must still succeed: nothing is reversed or
    // re-applied, so there is nothing to check availability for.
    sb.tables.v_inventory_lots_open = [];
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-1', variantKey: '', qty: 2, notes: 'still fine' }],
    });
    expect(res.status).toBe(200);
    expect(lines('st-1')[0]!.id).toBe('li-1');
  });
});

// DEV-15: the detail page's Edit can now add and remove lines, so the replace
// must accept a line list whose length differs from what was saved.
describe('PATCH stock-transfers/:id — adding / removing lines', () => {
  it('adds a line to a saved transfer', async () => {
    sb = makeSb();
    sb.tables.v_inventory_lots_open.push({ warehouse_id: 'wh-1', item_code: 'SKU-2', variant_key: '', qty_remaining: 10, company_id: 1 });
    const res = await patch('st-1', {
      items: [
        { itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty: 2, notes: 'old line note' },
        { itemCode: 'SKU-2', productName: 'Armchair', variantKey: '', qty: 3 },
      ],
    });
    expect(res.status).toBe(200);
    const ls = lines('st-1');
    expect(ls).toHaveLength(2);
    expect(ls.map((l) => [l.item_code, l.qty])).toEqual([['SKU-1', 2], ['SKU-2', 3]]);
  });

  it('removes a line from a saved transfer', async () => {
    sb = makeSb();
    sb.tables.stock_transfer_lines.push({ id: 'li-2', stock_transfer_id: 'st-1', item_code: 'SKU-2', product_name: 'Armchair', variant_key: '', qty: 1, notes: null, created_at: '2026-09-01T00:00:01Z' });
    const res = await patch('st-1', {
      items: [{ itemCode: 'SKU-1', productName: 'Sofa', variantKey: '', qty: 2 }],
    });
    expect(res.status).toBe(200);
    const ls = lines('st-1');
    expect(ls).toHaveLength(1);
    expect(ls[0]!.item_code).toBe('SKU-1');
  });

  it('409s an added line on the same bucket when the combined qty exceeds what is available', async () => {
    sb = makeSb();
    // Existing SKU-1 line keeps 2; a second SKU-1 line of 7 makes 9 > 8 available.
    const res = await patch('st-1', {
      items: [
        { itemCode: 'SKU-1', variantKey: '', qty: 2 },
        { itemCode: 'SKU-1', variantKey: '', qty: 7 },
      ],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'insufficient_stock',
      shortages: [{ itemCode: 'SKU-1', requested: 9, available: 8 }],
    });
    expect(lines('st-1')).toHaveLength(1);
  });
});
