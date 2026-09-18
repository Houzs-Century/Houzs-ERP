/* The bound purchase orders on each row of GET /so-amendments.
 *
 * Both PO Amendments queues (desktop PoAmendments.tsx, and the phone queue) show
 * an SO amendment as a "From SO amendment" row only when its `bound_pos` is
 * non-empty. So a `bound_pos` that is EMPTY because a read failed looks exactly
 * like "this order has no purchase order": the row leaves purchasing's queue and
 * nothing says why. These tests pin that a failure of any of the three reads
 * behind the field fails the list instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

let sb = fakeSb({});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { soAmendments } = await import('./so-amendments');

const AMENDMENTS = (): Row[] => [
  { id: 'a1', so_doc_no: 'HC-SO-012442', amendment_no: 'HC-SO-012442/A1', status: 'REQUESTED', lane: 'LINES', reason: null, requested_by: null, created_at: '2026-09-14T06:58:00Z', updated_at: null, company_id: 1 },
  { id: 'a2', so_doc_no: 'HC-SO-012713', amendment_no: 'HC-SO-012713/A1', status: 'REQUESTED', lane: 'LINES', reason: null, requested_by: null, created_at: '2026-09-11T13:47:00Z', updated_at: null, company_id: 1 },
  { id: 'a3', so_doc_no: 'HC-SO-004928', amendment_no: 'HC-SO-004928/A2', status: 'SO_APPROVED', lane: null, reason: null, requested_by: null, created_at: '2026-09-10T11:35:00Z', updated_at: null, company_id: 1 },
];

const ORDERS = (): Row[] => [
  { doc_no: 'HC-SO-012442', ref: null, customer_so_no: null, company_id: 1 },
  { doc_no: 'HC-SO-012713', ref: null, customer_so_no: null, company_id: 1 },
  { doc_no: 'HC-SO-004928', ref: null, customer_so_no: null, company_id: 1 },
];

/* HC-SO-012442 is bought on two POs; HC-SO-012713 shares one of them; HC-SO-004928
   was never purchased. */
const SO_LINES = (): Row[] => [
  { id: 'l1', doc_no: 'HC-SO-012442', company_id: 1 },
  { id: 'l2', doc_no: 'HC-SO-012442', company_id: 1 },
  { id: 'l3', doc_no: 'HC-SO-012713', company_id: 1 },
  { id: 'l4', doc_no: 'HC-SO-004928', company_id: 1 },
];
const PO_LINES = (): Row[] => [
  { id: 'pl1', purchase_order_id: 'po-1', so_item_id: 'l1', company_id: 1 },
  { id: 'pl2', purchase_order_id: 'po-2', so_item_id: 'l2', company_id: 1 },
  { id: 'pl3', purchase_order_id: 'po-2', so_item_id: 'l3', company_id: 1 },
];
const POS = (): Row[] => [
  { id: 'po-1', po_number: 'HC-PO-2609-001', status: 'SUBMITTED', company_id: 1 },
  { id: 'po-2', po_number: 'HC-PO-2609-002', status: 'SUBMITTED', company_id: 1 },
];

const tables = () => ({
  so_amendments: AMENDMENTS(),
  mfg_sales_orders: ORDERS(),
  mfg_sales_order_items: SO_LINES(),
  purchase_order_items: PO_LINES(),
  purchase_orders: POS(),
});

function app() {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', { id: 7, email: 'desk@houzs.test', name: 'Desk', permissions: ['*'] } as unknown as User);
    await next();
  });
  a.route('/', soAmendments);
  return a;
}

type ListRow = { id: string; bound_pos: Array<{ id: string; po_number: string; status: string }> };

const boundPoNumbers = (rows: ListRow[]) =>
  Object.fromEntries(rows.map((r) => [r.id, r.bound_pos.map((p) => p.po_number).sort()]));

beforeEach(() => {
  sb = fakeSb(tables());
});

describe('GET /so-amendments — bound_pos', () => {
  it('carries every PO an order\'s lines were bought on, and none for an order never purchased', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { amendments: ListRow[] }).amendments;
    expect(boundPoNumbers(rows)).toEqual({
      a1: ['HC-PO-2609-001', 'HC-PO-2609-002'],
      a2: ['HC-PO-2609-002'],
      a3: [],
    });
  });

  /* PostgREST fails the WHOLE read when a selected column is missing (42703) —
     the fake's way of making one read fail while the others answer. */
  it.each([
    ['the SO line read', { mfg_sales_order_items: ['doc_no'] }],
    ['the PO line read', { purchase_order_items: ['so_item_id'] }],
    ['the purchase order read', { purchase_orders: ['po_number'] }],
  ])('a failed %s fails the list instead of reading as "no purchase order"', async (_label, missing) => {
    sb = fakeSb(tables(), missing);
    const res = await app().request('/');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('load_failed');
  });
});
