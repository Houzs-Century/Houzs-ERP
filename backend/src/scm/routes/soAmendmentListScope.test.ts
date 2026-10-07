/* Who sees which SO amendment (DEV-40, owner 2026-10-06 — Nico: 「sales person
 * only see own request, like sales order」).
 *
 * Symptom: Adrian, a Sales Executive with no view-all grant, saw all 201
 * amendments on the queue. Cause: the list scoped through applySoScope, which
 * ORs in `open_to_all` — true on the ~2,580 AutoCount-imported orders — so every
 * rep saw every amendment on those. Fix: a scoped caller sees what they or their
 * downline raised, or what sits on an order they or their downline own or were
 * shared (salesScope.soOwnedInScope), and the list caps AFTER that filter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

let sb = fakeSb({});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { soAmendments } = await import('./so-amendments');

const CO = 1;
const MANAGER = 60;
const REP_A = 61;
const REP_B = 62;
const ORG = [
  { id: MANAGER, manager_id: null },
  { id: REP_A, manager_id: MANAGER },
  { id: REP_B, manager_id: null },
];

const ENV = {
  DB: {
    prepare: () => ({
      bind: (...ids: unknown[]) => ({
        all: async () => ({
          results: ORG.filter((u) => u.manager_id != null && ids.map(Number).includes(u.manager_id)).map((u) => ({ id: u.id })),
        }),
      }),
    }),
  },
} as unknown as Env;

const STAFF = (): Row[] => [
  { id: 'staff-a', user_id: REP_A },
  { id: 'staff-b', user_id: REP_B },
  { id: 'staff-mgr', user_id: MANAGER },
];

const ORDERS = (): Row[] => [
  { doc_no: 'SO-A', company_id: CO, salesperson_id: 'staff-a', access_staff_ids: ['staff-a'], open_to_all: false, ref: null, customer_so_no: null },
  // Imported, open to all, sold by rep B — the shape that leaked.
  { doc_no: 'SO-OPEN', company_id: CO, salesperson_id: 'staff-b', access_staff_ids: ['staff-b'], open_to_all: true, ref: null, customer_so_no: null },
  { doc_no: 'SO-SHARED', company_id: CO, salesperson_id: 'staff-b', access_staff_ids: ['staff-b', 'staff-a'], open_to_all: false, ref: null, customer_so_no: null },
];

const amendment = (id: string, soDocNo: string, requestedBy: string | null, createdAt = '2026-10-01T00:00:00Z'): Row => ({
  id, so_doc_no: soDocNo, amendment_no: `${soDocNo}/${id}`, status: 'REQUESTED', lane: 'LINES', reason: null,
  lane_flag_note: null, requested_by: requestedBy, created_at: createdAt, updated_at: null, company_id: CO,
});

const AMENDMENTS = (): Row[] => [
  amendment('on-own', 'SO-A', 'staff-office'),
  amendment('on-open-by-b', 'SO-OPEN', 'staff-b'),
  amendment('on-open-by-a', 'SO-OPEN', 'staff-a'),
  amendment('on-shared', 'SO-SHARED', 'staff-b'),
];

type Caller = { id: number; position_name: string; permissions: string[] };
const repA: Caller = { id: REP_A, position_name: 'Sales Executive', permissions: ['scm.access'] };
const repB: Caller = { id: REP_B, position_name: 'Sales Executive', permissions: ['scm.access'] };
const manager: Caller = { id: MANAGER, position_name: 'Sales Manager', permissions: ['scm.access'] };
const office: Caller = { id: 70, position_name: 'Logistic Admin', permissions: ['scm.access', 'scm.so.view_all'] };

function app(who: Caller) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('companyId', CO);
    c.set('user', { ...who, email: 'x@houzs.test', name: 'x', permissions_set: new Set(who.permissions) } as unknown as User);
    await next();
  });
  a.route('/', soAmendments);
  return a;
}

async function list(who: Caller): Promise<string[]> {
  const res = await app(who).request('/', undefined, ENV);
  expect(res.status).toBe(200);
  return ((await res.json()) as { amendments: Array<{ id: string }> }).amendments.map((r) => r.id).sort();
}

const detailStatus = async (who: Caller, id: string) => (await app(who).request(`/${id}`, undefined, ENV)).status;

beforeEach(() => {
  sb = fakeSb({ so_amendments: AMENDMENTS(), mfg_sales_orders: ORDERS(), staff: STAFF(), so_amendment_lines: [] });
});

describe('GET /so-amendments — a salesperson sees their own requests, not the open orders\'', () => {
  it('a rep sees amendments on own and shared orders and the ones they raised — not another rep\'s on an open order', async () => {
    expect(await list(repA)).toEqual(['on-open-by-a', 'on-own', 'on-shared']);
  });

  it('the order\'s salesperson sees every amendment on it, whoever raised it', async () => {
    expect(await list(repB)).toEqual(['on-open-by-a', 'on-open-by-b', 'on-shared']);
  });

  it('a manager sees their downline\'s', async () => {
    expect(await list(manager)).toEqual(['on-open-by-a', 'on-own', 'on-shared']);
  });

  it('a view-all caller sees the whole queue', async () => {
    expect(await list(office)).toEqual(['on-open-by-a', 'on-open-by-b', 'on-own', 'on-shared']);
  });

  it('caps after the filter: a rep\'s request older than 500 others still lists', async () => {
    const others = Array.from({ length: 520 }, (_, i) =>
      amendment(`other-${i}`, 'SO-OPEN', 'staff-b', `2026-10-02T00:${String(i % 60).padStart(2, '0')}:00Z`));
    sb = fakeSb({ so_amendments: [...others, amendment('old-own', 'SO-A', 'staff-a', '2026-01-01T00:00:00Z')], mfg_sales_orders: ORDERS(), staff: STAFF() });
    expect(await list(repA)).toEqual(['old-own']);
  });

  it('a failed ownership read fails the list instead of hiding the rep\'s own requests', async () => {
    sb = fakeSb({ so_amendments: AMENDMENTS(), mfg_sales_orders: ORDERS(), staff: STAFF() }, { mfg_sales_orders: ['access_staff_ids'] });
    const res = await app(repA).request('/', undefined, ENV);
    expect(res.status).toBe(500);
  });
});

describe('GET /so-amendments/:id — the same rule', () => {
  it('a rep cannot open another rep\'s amendment on an open order', async () => {
    expect(await detailStatus(repA, 'on-open-by-b')).toBe(404);
  });

  it('a rep opens what they raised and what sits on their own order', async () => {
    expect(await detailStatus(repA, 'on-open-by-a')).toBe(200);
    expect(await detailStatus(repA, 'on-own')).toBe(200);
  });

  it('a view-all caller opens anything', async () => {
    expect(await detailStatus(office, 'on-open-by-b')).toBe(200);
  });
});
