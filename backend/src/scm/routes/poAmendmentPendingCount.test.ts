/* The red count on the "PO Amendments" sidebar entry (owner 2026-09-09,
 * "PO Amendments 也一起加").
 *
 * Twin of soAmendmentPendingCount.test.ts, and the reason it is a separate
 * suite rather than a parametrised copy is the thing worth pinning: the PO side
 * has ONE approver key and no lanes, so its count is deliberately simpler. If
 * someone later "unifies" the two endpoints, the assertion that survives should
 * be this one — a PO amendment is not lane-split, and pretending otherwise
 * would invent a distinction the approval gate does not make.
 *
 * The rows that matter most here are the FOLLOW-UPS: an approved LINES-lane SO
 * amendment auto-raises PO amendments nobody asked for by hand. The count is
 * what says they arrived.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({ po_amendments: [] });

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { poAmendments } = await import('./po-amendments');

const ROWS = (): Row[] => [
  { id: 'p1', status: 'REQUESTED', company_id: 1, source_so_amendment_no: null },
  // Two auto-raised follow-ups from an approved SO amendment.
  { id: 'p2', status: 'REQUESTED', company_id: 1, source_so_amendment_no: 'SO-1/A1' },
  { id: 'p3', status: 'REQUESTED', company_id: 1, source_so_amendment_no: 'SO-1/A1' },
  { id: 'p4', status: 'APPROVED',  company_id: 1, source_so_amendment_no: null },
  { id: 'p5', status: 'REJECTED',  company_id: 1, source_so_amendment_no: null },
];

/** Permissions go on `user`: supabaseAuth DERIVES houzsUser from it and
 *  overwrites anything seeded directly, which would silently read as "no
 *  permissions" and make every count 0. */
function appFor(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', {
      id: 9, email: 'buyer@houzs.test', name: 'Buyer', permissions,
    } as unknown as User);
    await next();
  });
  app.route('/', poAmendments);
  return app;
}

async function countFor(permissions: string[]): Promise<number> {
  const res = await appFor(permissions).request('/pending-count');
  expect(res.status).toBe(200);
  return ((await res.json()) as { count: number }).count;
}

beforeEach(() => { sb.tables.po_amendments = ROWS(); });

describe('GET /po-amendments/pending-count', () => {
  it('counts every open amendment for someone who can confirm them', async () => {
    // Three REQUESTED — the manual one and both auto-raised follow-ups.
    expect(await countFor(['scm.po_amendment.approve'])).toBe(3);
  });

  it('DOES count for the `*` wildcard holder — same rule as the SO twin', async () => {
    // See the SO suite for why the badge honours the wildcard and the notice
    // does not. Owner ruling 2026-09-09, after a same-day round trip.
    expect(await countFor(['*'])).toBe(3);
  });

  it('answers 0 for someone who can only RAISE one', async () => {
    // Raising is not confirming. A number on a menu the reader cannot act on
    // never goes down for them, whatever they do.
    expect(await countFor(['scm.po_amendment.create'])).toBe(0);
    expect(await countFor([])).toBe(0);
  });

  it('never counts a resolved amendment', async () => {
    sb.tables.po_amendments = ROWS().filter((r) => r.status !== 'REQUESTED');
    expect(await countFor(['scm.po_amendment.approve'])).toBe(0);
  });
});
