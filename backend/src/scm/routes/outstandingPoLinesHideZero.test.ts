/* GET /outstanding/po-lines (Outstanding page, PO Chasing tab) — DEV-43: a line
 * with nothing left to receive must not appear on the chasing list. 'all' used
 * to return every line, so fully received (remaining 0) and over-received
 * (remaining < 0) lines showed up beside the ones still owed. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const state: { sb: unknown } = { sb: null };
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => state.sb }));

const CALLER = {
  id: 7, email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { outstanding } = await import('./outstanding');

/* View rows built with mig 20260912T1000's own remaining / is_outstanding rule. */
const line = (id: string, qty: number, received: number, status = 'PARTIALLY_RECEIVED'): Row => ({
  po_item_id: id, po_id: 'po-1', po_number: 'PO-1', po_date: '2026-10-01', status, company_id: 1,
  qty, received_qty: received, remaining_qty: qty - received,
  is_outstanding: !['RECEIVED', 'CANCELLED'].includes(status) && qty - received > 0,
});

async function getLines(mode: string) {
  state.sb = fakeSb({
    v_po_outstanding_lines: [line('owed', 5, 2), line('done', 3, 3), line('over', 2, 3)],
    purchase_orders: [{ id: 'po-1', company_id: 1 }],
    purchase_order_items: [
      { id: 'owed', purchase_order_id: 'po-1', company_id: 1 },
      { id: 'done', purchase_order_id: 'po-1', company_id: 1 },
      { id: 'over', purchase_order_id: 'po-1', company_id: 1 },
    ],
  });
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('companyCode', 'HOUZS');
    await next();
  });
  app.route('/', outstanding);
  const res = await app.request(`/po-lines?outstanding=${mode}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: Array<{ po_item_id: string }> };
  return body.rows.map((r) => r.po_item_id).sort();
}

describe('GET /outstanding/po-lines hides lines with 0 outstanding qty (DEV-43)', () => {
  it('All drops lines whose remaining qty is 0 or less', async () => {
    expect(await getLines('all')).toEqual(['owed']);
  });

  it('Outstanding keeps only lines still owed', async () => {
    expect(await getLines('true')).toEqual(['owed']);
  });

  it('Completed still lists the fully received lines', async () => {
    expect(await getLines('false')).toEqual(['done', 'over']);
  });
});
