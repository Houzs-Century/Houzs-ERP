import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [],
  po_amendments: [],
  po_amendment_lines: [],
  staff: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { poAmendments } = await import('./po-amendments');

const PO = (): Row => ({
  id: 'po-1', po_number: 'HC-PO-2608-001', status: 'OPEN',
  supplier_id: 'sup-1', expected_at: '2026-09-01', notes: null, company_id: 1,
});

const CALLER = {
  id: 7, email: 'purchasing@houzs.test', name: 'Purchasing', permissions: ['*'],
} as unknown as User;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('companyId', 1);
  c.set('user', CALLER);
  await next();
});
app.route('/', poAmendments);

const create = (line: Record<string, unknown>) =>
  app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poId: 'po-1', lines: [{ purchaseOrderItemId: 'poi-1', changeType: 'DELIVERY', ...line }] }),
  });

const storedLine = () => (sb.tables.po_amendment_lines[0] ?? {}) as Row;

beforeEach(() => {
  sb.tables.purchase_orders = [PO()];
  sb.tables.po_amendments = [];
  sb.tables.po_amendment_lines = [];
  sb.tables.staff = [];
});

describe('POST po-amendment — blank line delivery date', () => {
  it('stores NULL for a cleared line date, and keeps the amendment', async () => {
    const res = await create({ newDeliveryDate: '' });
    expect(res.status).toBe(201);
    expect(storedLine().new_delivery_date).toBeNull();
    expect(sb.tables.po_amendments).toHaveLength(1);
  });

  it('still carries a real line date through', async () => {
    const res = await create({ newDeliveryDate: '2026-10-20' });
    expect(res.status).toBe(201);
    expect(storedLine().new_delivery_date).toBe('2026-10-20');
  });
});
