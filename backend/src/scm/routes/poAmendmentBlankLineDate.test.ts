// A blank per-line delivery date on a PO amendment must store NULL, not "".
//
// POST /po-amendments builds its line rows inside `submittedLines.map(...)` and
// wrote `new_delivery_date: l.newDeliveryDate ?? null`. `??` is NULLISH, so an
// unfilled <input type="date"> — which posts "" — reached
// po_amendment_lines.new_delivery_date (`date`, mig 0194:87). Postgres answers
// `invalid input syntax for type date: ""`, and this handler then DELETES the
// header row it had already inserted (the roll-back that keeps the one-open
// gate from wedging), so the whole amendment save is lost. Same shape as the
// 2026-08-17 production 500 on the PO header.
//
// Why it is worth a test rather than a browser fix: PoAmendCreateModal happens
// to send `d.deliveryDate || null` today, so the only guard standing between a
// blank and the 500 is a line of frontend code. The mobile surface and any
// direct API caller do not run it.
//
// The fake PostgREST does not type-check columns, so this suite cannot
// reproduce the 500 itself — it pins what the handler SENDS.
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

/* Module scope, not inside a test body: this router imports po-revision and
   so-revision behind it, and charging that transform to testTimeout is what
   made this branch's first regression suite pass alone and time out in the
   full run. A top-level await runs during COLLECTION, which no test timeout
   bounds. */
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
    /* The bug shipped "" here. NULL is the whole assertion — a blank means
       "no date on this line", never today and never a rejected insert. */
    expect(storedLine().new_delivery_date).toBeNull();
    expect(sb.tables.po_amendments).toHaveLength(1);
  });

  it('still carries a real line date through', async () => {
    const res = await create({ newDeliveryDate: '2026-10-20' });
    expect(res.status).toBe(201);
    expect(storedLine().new_delivery_date).toBe('2026-10-20');
  });
});
