/* PATCH /so-amendments/:id/lane — a SUPER ADMIN changing which desk approves an
 * open SO amendment (owner 2026-09-25). Pinned here:
 *
 *  · only the * wildcard may do it — an approver of any single lane cannot;
 *  · any of the three lanes, with a required note, and the row stays REQUESTED;
 *  · the same safety as the approver's handover: a goods change the PO must
 *    follow never leaves the Purchaser, and only a pure price / discount change
 *    on a product line may go to the Sales Director.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({ so_amendments: [], so_amendment_lines: [], mfg_sales_order_items: [], mfg_products: [], staff: [] });
const audits: Array<{ action: string; note?: string; fieldChanges: unknown }> = [];
const handed: Array<Record<string, unknown>> = [];

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));
vi.mock('../lib/so-audit', () => ({
  recordSoAudit: async (_sb: unknown, a: { action: string; note?: string; fieldChanges: unknown }) => { audits.push(a); },
}));
vi.mock('../../services/amendmentNotify', () => ({
  notifySoAmendmentResolved: async () => {},
  notifyPoAmendmentRaised: async () => {},
  notifySoAmendmentHandedOver: async (_env: unknown, o: Record<string, unknown>) => { handed.push(o); },
}));
vi.mock('../lib/validate-item-codes', async (orig) => ({
  ...(await orig<typeof import('../lib/validate-item-codes')>()),
  catalogCategoriesByCode: async () => new Map<string, string | null>(),
}));

const { soAmendments } = await import('./so-amendments');

const am = (id: string, doc: string, lane: string | null, extra: Row = {}): Row => ({
  id, so_doc_no: doc, amendment_no: `${doc}/A1`, lane, status: 'REQUESTED', version: 1, company_id: 1,
  lane_flag_note: null, requested_by: null, header_changes: null, ...extra,
});

const item = (id: string, doc: string, extra: Row = {}): Row => ({
  id, doc_no: doc, company_id: 1, item_code: 'FENRIR-(Q)', item_group: 'bedframe', qty: 1,
  unit_price_sen: 100, discount_sen: 0, variants: { fabric: 'PC151-06' }, remark: null, ...extra,
});

const line = (id: string, amendmentId: string, itemId: string | null, extra: Row = {}): Row => ({
  id, amendment_id: amendmentId, sales_order_item_id: itemId, change_type: 'SPEC', new_item_code: null,
  new_variants: null, new_qty: null, new_unit_price_sen: null, new_discount_sen: null, new_remark: null, ...extra,
});

beforeEach(() => {
  sb.tables.so_amendments = [
    am('p1', 'HC-SO-1', 'LINES'),                                   // price only: 1.00 -> 2,060.00
    am('q2', 'HC-SO-2', 'LINES'),                                   // qty change the PO follows
    am('s3', 'HC-SO-3', 'LINES'),                                   // price + colour
    am('d4', 'HC-SO-4', 'DELIVERY', { header_changes: { address2: 'Unit 9' } }),
    am('r5', 'HC-SO-5', 'PRICE'),
    am('x6', 'HC-SO-6', 'LINES', { status: 'SO_APPROVED' }),
    am('g7', 'HC-SO-7', null),
  ];
  sb.tables.mfg_sales_order_items = [
    item('i1', 'HC-SO-1'), item('i2', 'HC-SO-2'), item('i3', 'HC-SO-3'), item('i5', 'HC-SO-5'),
  ];
  sb.tables.so_amendment_lines = [
    line('a1', 'p1', 'i1', { new_unit_price_sen: 206000 }),
    line('a2', 'q2', 'i2', { change_type: 'QTY', new_qty: 3 }),
    line('a3', 's3', 'i3', { new_unit_price_sen: 5000, new_variants: { fabric: 'PC151-09' } }),
    line('a5', 'r5', 'i5', { new_unit_price_sen: 9000 }),
  ];
  audits.length = 0; handed.length = 0;
});

function appFor(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', { id: 7, email: 'admin@houzs.test', name: 'Admin', permissions } as unknown as User);
    await next();
  });
  app.route('/', soAmendments);
  return app;
}

const move = (permissions: string[], id: string, body: unknown) =>
  appFor(permissions).request(`/${id}/lane`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const row = (id: string) => (sb.tables.so_amendments as Row[]).find((r) => r.id === id)!;
const ADMIN = ['*'];
const reasonOf = async (res: Response) => (await res.json() as { error: string; reason?: string });

describe('PATCH /so-amendments/:id/lane', () => {
  it('a super admin moves a price-only change from the Purchaser to the Sales Director', async () => {
    const res = await move(ADMIN, 'p1', { lane: 'PRICE', note: '  price change, Sales Director signs ' });
    expect(res.status).toBe(200);
    expect(row('p1')).toMatchObject({ lane: 'PRICE', status: 'REQUESTED', version: 2 });
    expect(audits).toEqual([expect.objectContaining({
      action: 'AMENDMENT_LANE_CHANGED', note: 'price change, Sales Director signs',
      fieldChanges: [{ field: 'lane', from: 'LINES', to: 'PRICE' }],
    })]);
    expect(handed).toEqual([expect.objectContaining({ fromLane: 'LINES', toLane: 'PRICE', byAdmin: true })]);
  });

  it('refuses anyone without the wildcard, even the approver of every lane', async () => {
    const all = ['scm.amendment.approve_lines', 'scm.amendment.approve_delivery', 'scm.amendment.approve_price'];
    expect((await move(all, 'p1', { lane: 'PRICE', note: 'x' })).status).toBe(403);
    expect(row('p1').lane).toBe('LINES');
    expect(audits).toHaveLength(0);
  });

  it('refuses a change that is not price-only on the Sales Director desk', async () => {
    for (const id of ['q2', 's3']) {
      const res = await move(ADMIN, id, { lane: 'PRICE', note: 'try it' });
      expect(res.status).toBe(409);
      const body = await reasonOf(res);
      expect(body.error).toBe('not_price_only');
      expect(body.reason!.length).toBeLessThan(200);
      expect(row(id).lane).toBe('LINES');
    }
  });

  it('refuses header changes on the Sales Director desk', async () => {
    const res = await move(ADMIN, 'd4', { lane: 'PRICE', note: 'try it' });
    expect((await reasonOf(res)).error).toBe('not_price_only');
  });

  it('keeps a goods change the PO must follow with the Purchaser', async () => {
    const res = await move(ADMIN, 'q2', { lane: 'DELIVERY', note: 'try it' });
    expect(res.status).toBe(409);
    expect((await reasonOf(res)).error).toBe('po_must_follow');
  });

  it('moves a Sales Director row back to the Purchaser, which is always safe', async () => {
    const res = await move(ADMIN, 'r5', { lane: 'LINES', note: 'purchaser should see it' });
    expect(res.status).toBe(200);
    expect(row('r5').lane).toBe('LINES');
  });

  it('requires a note and a real lane, and refuses a no-op, a closed row and a legacy row', async () => {
    expect((await move(ADMIN, 'p1', { lane: 'PRICE', note: '  ' })).status).toBe(400);
    expect((await move(ADMIN, 'p1', { lane: 'FINANCE', note: 'x' })).status).toBe(400);
    expect((await reasonOf(await move(ADMIN, 'p1', { lane: 'LINES', note: 'x' }))).error).toBe('same_lane');
    expect((await reasonOf(await move(ADMIN, 'x6', { lane: 'PRICE', note: 'x' }))).error).toBe('bad_transition');
    expect((await move(ADMIN, 'g7', { lane: 'LINES', note: 'x' })).status).toBe(409);
    expect(audits).toHaveLength(0);
  });
});
