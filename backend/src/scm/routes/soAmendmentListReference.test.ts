/* The Reference column on the Sales Order Amendment queue (owner 2026-09-14:
 * 「要加上reference number」).
 *
 * GET /so-amendments carries each row's Sales Order reference RAW — `so_ref` and
 * `so_customer_so_no` — so the frontend can resolve the cell with customerRefOf,
 * the rule the Sales Order list already uses. Three things this read must not
 * get wrong: the value, the company it is read from, and a failed read passing
 * itself off as "no reference".
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
  { id: 'a2', so_doc_no: 'HC-SO-012442', amendment_no: 'HC-SO-012442/A2', status: 'REQUESTED', lane: 'DELIVERY', reason: null, requested_by: null, created_at: '2026-09-14T06:58:00Z', updated_at: null, company_id: 1 },
  { id: 'a3', so_doc_no: 'HC-SO-012713', amendment_no: 'HC-SO-012713/A1', status: 'REQUESTED', lane: 'LINES', reason: null, requested_by: null, created_at: '2026-09-11T13:47:00Z', updated_at: null, company_id: 1 },
  { id: 'a4', so_doc_no: 'HC-SO-004928', amendment_no: 'HC-SO-004928/A2', status: 'SO_APPROVED', lane: 'DELIVERY', reason: null, requested_by: null, created_at: '2026-09-11T11:35:00Z', updated_at: null, company_id: 1 },
];

const ORDERS = (): Row[] => [
  { doc_no: 'HC-SO-012442', ref: 'MR TAN / SUNWAY', customer_so_no: 'MR TAN / SUNWAY', company_id: 1 },
  { doc_no: 'HC-SO-012713', ref: null, customer_so_no: 'CUST-PO-7', company_id: 1 },
  { doc_no: 'HC-SO-004928', ref: null, customer_so_no: null, company_id: 1 },
  // Same number, another company: must never be the one read.
  { doc_no: 'HC-SO-012713', ref: 'OTHER COMPANY REF', customer_so_no: 'OTHER', company_id: 2 },
];

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

type ListRow = { id: string; so_ref: string | null; so_customer_so_no: string | null };

async function list(): Promise<ListRow[]> {
  const res = await app().request('/');
  expect(res.status).toBe(200);
  return ((await res.json()) as { amendments: ListRow[] }).amendments;
}

const byId = (rows: ListRow[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

beforeEach(() => {
  sb = fakeSb({ so_amendments: AMENDMENTS(), mfg_sales_orders: ORDERS() });
});

describe('GET /so-amendments — the Sales Order reference on each row', () => {
  it('carries the order\'s ref and customer_so_no, raw, on every amendment of that order', async () => {
    const rows = byId(await list());
    expect(rows.a1).toMatchObject({ so_ref: 'MR TAN / SUNWAY', so_customer_so_no: 'MR TAN / SUNWAY' });
    expect(rows.a2).toMatchObject({ so_ref: 'MR TAN / SUNWAY', so_customer_so_no: 'MR TAN / SUNWAY' });
    expect(rows.a3).toMatchObject({ so_ref: null, so_customer_so_no: 'CUST-PO-7' });
    expect(rows.a4).toMatchObject({ so_ref: null, so_customer_so_no: null });
  });

  it('reads the order in the active company, not a same-numbered order in another', async () => {
    const rows = byId(await list());
    expect(rows.a3?.so_customer_so_no).toBe('CUST-PO-7');
    expect(rows.a3?.so_ref).toBeNull();
  });

  it('a failed reference read fails the list instead of reading as "no reference"', async () => {
    // PostgREST fails the WHOLE read when a selected column is missing (42703).
    sb = fakeSb({ so_amendments: AMENDMENTS(), mfg_sales_orders: ORDERS() }, { mfg_sales_orders: ['customer_so_no'] });
    const res = await app().request('/');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('load_failed');
  });
});
