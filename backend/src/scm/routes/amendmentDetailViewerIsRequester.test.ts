/* GET /so-amendments/:id and GET /po-amendments/:id say whether the CALLER
 * raised the amendment.
 *
 * requested_by is a scm.staff uuid and the browser's scm-auth bridge has no
 * staff id, so the detail pages' own "did I raise this?" compare was always
 * false: the requester never saw Withdraw, only approvers did. 2026-10-05,
 * HC-SO-011143/A1: Syu could not withdraw the phantom pillow request BUG-53
 * had raised in her name, and the Owner had to. The server resolves the
 * caller's staff row the same way PATCH /:id/withdraw does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

let sb = fakeSb({});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { soAmendments } = await import('./so-amendments');
const { poAmendments } = await import('./po-amendments');

const SYU_USER = 41;
const SYU_STAFF = 'staff-syu';
const OWNER_USER = 1;

const tables = (): Record<string, Row[]> => ({
  staff: [
    { id: SYU_STAFF, user_id: SYU_USER },
    { id: 'staff-owner', user_id: OWNER_USER },
  ],
  so_amendments: [{
    id: 'so-a1', so_doc_no: 'HC-SO-011143', amendment_no: 'HC-SO-011143/A1', status: 'REQUESTED',
    lane: 'LINES', reason: 'add on storage charges', requested_by: SYU_STAFF, company_id: 1,
  }],
  so_amendment_lines: [],
  mfg_sales_orders: [{ doc_no: 'HC-SO-011143', status: 'READY_TO_SHIP', revision: 2, company_id: 1 }],
  mfg_sales_order_items: [],
  purchase_order_items: [],
  purchase_orders: [{ id: 'po-1', po_number: 'HC-PO-009780', status: 'SUBMITTED', revision: 1, company_id: 1 }],
  po_amendments: [{
    id: 'po-a1', po_id: 'po-1', po_number: 'HC-PO-009780', amendment_no: 'HC-PO-009780/A1', status: 'REQUESTED',
    reason: null, requested_by: SYU_STAFF, company_id: 1,
  }],
  po_amendment_lines: [],
});

function app(houzsUserId: number) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('companyId', 1);
    /* The route's supabaseAuth derives houzsUser from the session `user`. */
    c.set('user', {
      id: houzsUserId, email: 'caller@houzs.test', name: 'Caller', permissions: ['*'], permissions_set: new Set(['*']),
    } as unknown as User);
    await next();
  });
  a.route('/so', soAmendments);
  a.route('/po', poAmendments);
  return a;
}

const flag = async (res: Response) => {
  expect(res.status).toBe(200);
  return ((await res.json()) as { viewerIsRequester?: unknown }).viewerIsRequester;
};

beforeEach(() => {
  sb = fakeSb(tables());
});

describe.each([
  ['GET /so-amendments/:id', '/so/so-a1'],
  ['GET /po-amendments/:id', '/po/po-a1'],
])('%s — viewerIsRequester', (_label, path) => {
  it('is true for the person who raised it', async () => {
    expect(await flag(await app(SYU_USER).request(path))).toBe(true);
  });

  it('is false for anyone else, however senior', async () => {
    expect(await flag(await app(OWNER_USER).request(path))).toBe(false);
  });

  it('is false when the caller has no staff row', async () => {
    expect(await flag(await app(999).request(path))).toBe(false);
  });
});
