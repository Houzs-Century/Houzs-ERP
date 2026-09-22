/* PATCH /so-amendments/:id/flag-lane — the APPROVER saying "this is not mine to
 * approve", which PASSES the request to the other desk (owner 2026-09-17,
 * option B).
 *
 * The flag first shipped in the requester's submit dialog, where nobody can
 * judge it; then as a note for an administrator to act on. The owner's ruling:
 * the approver's word moves it. Pinned here:
 *
 *  · only someone who could SIGN the row may pass it on — a requester, or the
 *    other desk, cannot;
 *  · the row moves lane, stays REQUESTED, and carries the note;
 *  · a change the Purchase Order has to follow never leaves the Purchaser —
 *    only the LINES lane's approval raises the PO amendment;
 *  · ONCE: a row that was already passed over cannot be passed back, so two
 *    desks cannot bounce it;
 *  · a desk that already has an open request on the order cannot receive a
 *    second one.
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

const ROWS = (): Row[] => [
  am('d1', 'HC-SO-1', 'DELIVERY', { header_changes: { address2: 'Unit 9' } }),
  am('d2', 'HC-SO-2', 'DELIVERY', { status: 'SO_APPROVED', version: 2 }),
  am('g3', 'HC-SO-3', null),
  am('l4', 'HC-SO-4', 'LINES'),                                   // a goods QTY change
  am('l5', 'HC-SO-5', 'LINES'),                                   // a service line the rule sent to LINES
  am('l6', 'HC-SO-6', 'LINES', { header_changes: { processingDate: '2026-10-01' } }),
  am('d7', 'HC-SO-7', 'DELIVERY'),
  am('l7', 'HC-SO-7', 'LINES', { amendment_no: 'HC-SO-7/A2' }),   // the target desk is already busy on this order
  am('l8', 'HC-SO-8', 'LINES', { lane_flag_note: 'came from Logistic' }),
  am('p9', 'HC-SO-9', 'PRICE'),                                   // a 2990 price-only lane — never handed over
];

function appFor(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', { id: 7, email: 'desk@houzs.test', name: 'Desk', permissions } as unknown as User);
    await next();
  });
  app.route('/', soAmendments);
  return app;
}

const pass = (permissions: string[], id: string, body: unknown = { note: 'not mine, see the change' }) =>
  appFor(permissions).request(`/${id}/flag-lane`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const row = (id: string) => (sb.tables.so_amendments as Row[]).find((r) => r.id === id)!;
const LOGISTIC = ['scm.amendment.approve_delivery'];
const PURCHASER = ['scm.amendment.approve_lines'];
const FINANCE = ['scm.amendment.approve_price'];

beforeEach(() => {
  sb.tables.so_amendments = ROWS();
  sb.tables.mfg_sales_order_items = [
    { id: 'i4', doc_no: 'HC-SO-4', item_code: 'PC151-01', item_group: 'sofa' },
    { id: 'i5', doc_no: 'HC-SO-5', item_code: 'SVC-DELIVERY', item_group: 'service' },
  ];
  sb.tables.so_amendment_lines = [
    { id: 'x4', amendment_id: 'l4', sales_order_item_id: 'i4', change_type: 'QTY', new_item_code: null, new_variants: null, new_qty: 3, new_unit_price_sen: null },
    { id: 'x5', amendment_id: 'l5', sales_order_item_id: 'i5', change_type: 'QTY', new_item_code: null, new_variants: null, new_qty: 2, new_unit_price_sen: null },
  ];
  audits.length = 0; handed.length = 0;
});

describe('PATCH /so-amendments/:id/flag-lane', () => {
  it('the Logistic approver passes a request to the Purchaser: it moves, stays open, and carries the note', async () => {
    const res = await pass(LOGISTIC, 'd1', { note: '  this is a fabric change, Purchaser approves these ' });
    expect(res.status).toBe(200);
    expect(row('d1').lane).toBe('LINES');
    expect(row('d1').status).toBe('REQUESTED');
    expect(row('d1').version).toBe(2);
    expect(row('d1').lane_flag_note).toBe('this is a fabric change, Purchaser approves these');
    expect(audits.map((a) => a.action)).toEqual(['AMENDMENT_LANE_FLAGGED']);
    expect(audits[0].fieldChanges).toEqual([
      { field: 'lane', from: 'DELIVERY', to: 'LINES' },
      { field: 'lane_flag_note', to: 'this is a fabric change, Purchaser approves these' },
    ]);
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ amendmentNo: 'HC-SO-1/A1', fromLane: 'DELIVERY', toLane: 'LINES' });
  });

  it('refuses a handover on a PRICE lane row — a price-only change is Finance\'s alone', async () => {
    const res = await pass(FINANCE, 'p9');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('price_lane_no_handover');
    expect(row('p9').lane).toBe('PRICE');
    expect(audits).toHaveLength(0);
    expect(handed).toHaveLength(0);
  });

  it('refuses the requester and the OTHER desk — only the row\'s own approver passes it on', async () => {
    for (const perms of [['scm.amendment.create'], PURCHASER, []]) {
      expect((await pass(perms, 'd1')).status).toBe(403);
    }
    expect(row('d1').lane).toBe('DELIVERY');
    expect(audits).toHaveLength(0);
  });

  it('requires a note', async () => {
    const res = await pass(LOGISTIC, 'd1', { note: '   ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('note_required');
    expect(row('d1').lane).toBe('DELIVERY');
  });

  it('never lets a change the Purchase Order follows leave the Purchaser', async () => {
    const goods = await pass(PURCHASER, 'l4');
    expect(goods.status).toBe(409);
    const body = (await goods.json()) as { error: string; reason: string };
    expect(body.error).toBe('po_must_follow');
    expect(body.reason).toContain('1 product line change');
    // humanApiError drops a server sentence of 200+ characters for a generic one.
    expect(body.reason.length).toBeLessThan(200);
    expect(row('l4').lane).toBe('LINES');

    const procDate = await pass(PURCHASER, 'l6');
    expect(procDate.status).toBe(409);
    expect(((await procDate.json()) as { error: string }).error).toBe('po_must_follow');
    expect(row('l6').lane).toBe('LINES');
    expect(handed).toHaveLength(0);
  });

  it('lets the Purchaser pass a service-line change to Logistic — the PO carries nothing for it', async () => {
    const res = await pass(PURCHASER, 'l5', { note: 'delivery charge, Logistic approves these' });
    expect(res.status).toBe(200);
    expect(row('l5').lane).toBe('DELIVERY');
    expect(handed[0]).toMatchObject({ fromLane: 'LINES', toLane: 'DELIVERY' });
  });

  it('passes once: a request that was already handed over cannot be bounced back', async () => {
    const res = await pass(PURCHASER, 'l8');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('already_handed_over');
    expect(row('l8').lane).toBe('LINES');
  });

  it('refuses when the other desk already has an open request on the order', async () => {
    const res = await pass(LOGISTIC, 'd7');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe('target_lane_busy');
    expect(body.reason).toContain('HC-SO-7/A2');
    expect(body.reason.length).toBeLessThan(200);
    expect(row('d7').lane).toBe('DELIVERY');
  });

  it('refuses a row that has already been acted on, and a legacy row with no desk', async () => {
    expect((await pass(LOGISTIC, 'd2')).status).toBe(409);
    expect((await pass(['*'], 'g3')).status).toBe(409);
    expect(row('d2').lane).toBe('DELIVERY');
    expect(row('g3').lane).toBeNull();
    expect(handed).toHaveLength(0);
  });
});
