/* The red count on the "Sales Order Amendment" sidebar entry (owner 2026-09-09:
 * "根据目前还有多少单需要被审批 — 在需要审批人员账号显示").
 *
 * The number has one job and two ways to be useless:
 *
 *  · TOO BIG. If it counted every open amendment rather than the ones this
 *    caller can sign, a purchaser would carry logistics' backlog on their menu
 *    forever. It never goes down no matter what they approve, so they stop
 *    reading it — and the badge is then worse than nothing, because the real
 *    number is hidden inside a wrong one.
 *
 *  · SHOWN TO THE WRONG PEOPLE. "在需要审批人员账号显示" is enforced by the count
 *    itself: someone with no approve key gets 0, and the badge renders nothing
 *    at 0. There is deliberately no second visibility rule in the frontend to
 *    keep in step with this one.
 *
 * Both are decided here, in SQL, from the same LANE_APPROVE_KEY table the
 * approval gate reads — so the badge and the button can never disagree about
 * whose work it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({ so_amendments: [] });

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { soAmendments } = await import('./so-amendments');

/* Four open rows across both lanes plus a legacy one, and two terminal rows
   that must never be counted. */
const ROWS = (): Row[] => [
  { id: 'a1', lane: 'LINES',    status: 'REQUESTED',   company_id: 1 },
  { id: 'a2', lane: 'LINES',    status: 'REQUESTED',   company_id: 1 },
  { id: 'a3', lane: 'DELIVERY', status: 'REQUESTED',   company_id: 1 },
  { id: 'a4', lane: null,       status: 'REQUESTED',   company_id: 1 },
  { id: 'a5', lane: 'LINES',    status: 'SO_APPROVED', company_id: 1 },
  { id: 'a6', lane: 'DELIVERY', status: 'REJECTED',    company_id: 1 },
];

/** Build an app whose caller holds exactly `permissions`.
 *
 *  The keys go on `user`, not on a pre-set `houzsUser`: the router's own
 *  supabaseAuth middleware DERIVES houzsUser from `user` and overwrites whatever
 *  was there, so seeding houzsUser directly is silently discarded — every gate
 *  then reads an empty permission set and every count comes back 0, which looks
 *  exactly like a broken query. */
function appFor(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', {
      id: 7, email: 'desk@houzs.test', name: 'Desk', permissions,
    } as unknown as User);
    await next();
  });
  app.route('/', soAmendments);
  return app;
}

async function countFor(permissions: string[]): Promise<number> {
  const res = await appFor(permissions).request('/pending-count');
  expect(res.status).toBe(200);
  return ((await res.json()) as { count: number }).count;
}

beforeEach(() => { sb.tables.so_amendments = ROWS(); });

describe('GET /so-amendments/pending-count', () => {
  it('counts only the lane the caller can actually sign', async () => {
    // Purchasing signs LINES: two open rows, and not logistics' one.
    expect(await countFor(['scm.amendment.approve_lines'])).toBe(2);
    // Logistics signs DELIVERY: one, and not purchasing's two.
    expect(await countFor(['scm.amendment.approve_delivery'])).toBe(1);
  });

  it('adds both lanes for someone who signs both', async () => {
    expect(
      await countFor(['scm.amendment.approve_lines', 'scm.amendment.approve_delivery']),
    ).toBe(3);
  });

  it('answers 0 for someone who cannot approve — the badge never renders', async () => {
    // Raising an amendment is not signing one. A salesperson who can create
    // must not carry a number they can do nothing about.
    expect(await countFor(['scm.amendment.create'])).toBe(0);
    expect(await countFor([])).toBe(0);
  });

  it('counts the legacy lane-NULL backlog for the legacy key holder', async () => {
    // mig 0225: legacy rows are a CLOSED set that still needs clearing, and
    // their gate is the old key. `lane IS NULL` needs its own predicate — an
    // .in() over lane names would never match NULL.
    expect(await countFor(['scm.amendment.approve_so'])).toBe(1);
    expect(await countFor(['scm.amendment.approve_lines', 'scm.amendment.approve_so'])).toBe(3);
  });

  it('never counts a resolved amendment', async () => {
    // a5 is applied and a6 refused; neither is anybody's outstanding work.
    sb.tables.so_amendments = ROWS().filter((r) => r.status !== 'REQUESTED');
    expect(await countFor(['scm.amendment.approve_lines', 'scm.amendment.approve_delivery'])).toBe(0);
  });
});
