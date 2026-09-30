/* A payment whose slip is more than 14 days old is keyed in as a REQUEST, and
 * only an admin (scm.payment.backdate) sees the queue and decides it (owner
 * 2026-09-30). This suite drives the routes over the in-memory PostgREST fake
 * with the payment write core stubbed: what is under test is who may do what,
 * that nothing is booked until an admin approves, and that the approval books
 * exactly the payment that was asked for. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';
import { shiftIsoDay } from '../shared/payment-slip-date';
import { todayMyt } from '../lib/my-time';

const record = vi.fn(async (_sb: unknown, _p: Record<string, unknown>) => ({ payment: { id: 'pay-1' } as Record<string, unknown> | null, errorMessage: null as string | null }));
vi.mock('../lib/so-payment-row', () => ({ recordSoPaymentRow: (sb: unknown, p: Record<string, unknown>) => record(sb, p) }));
const soAudit = vi.fn(async (_sb: unknown, _args: unknown) => undefined);
vi.mock('../lib/so-audit', () => ({ recordSoAudit: (sb: unknown, args: unknown) => soAudit(sb, args) }));
vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const { soPaymentBackdateRequests, paymentBackdateInbox } = await import('./so-payment-backdate-requests');

const CO = 1;
let sb: ReturnType<typeof fakeSb>;
let tables: Record<string, Array<Record<string, unknown>>>;
const CALLER = { id: 'staff-uuid', email: 'x@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

type Who = { id: number; name: string; perms: string[] };
const SALES: Who = { id: 11, name: 'Sales Amy', perms: ['scm.access', 'scm.so.view_all'] };
const OTHER: Who = { id: 12, name: 'Sales Bob', perms: ['scm.access', 'scm.so.view_all'] };
const ADMIN: Who = { id: 1, name: 'Owner', perms: ['*'] };

function app(who: Who) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', CO);
    c.set('supabase', sb as unknown as SupabaseClient);
    c.set('houzsUser', { id: who.id, name: who.name, permissions_set: new Set(who.perms), permissions: who.perms });
    await next();
  });
  a.route('/mfg-sales-orders', soPaymentBackdateRequests);
  a.route('/payment-backdate-requests', paymentBackdateInbox);
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies in a test are read loosely on purpose
type J = Record<string, any>;
const ENV = {} as Env;
const post = async (who: Who, path: string, body?: unknown): Promise<{ status: number; body: J }> => {
  const res = await app(who).request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }, ENV);
  return { status: res.status, body: (await res.json()) as J };
};
const get = async (who: Who, path: string): Promise<{ status: number; body: J }> => {
  const res = await app(who).request(path, undefined, ENV);
  return { status: res.status, body: (await res.json()) as J };
};

const today = todayMyt();
const OLD = shiftIsoDay(today, -20);
const payment = (over: Record<string, unknown> = {}) => ({
  paidAt: OLD, method: 'cash', amountSen: 50000, reason: 'Balance collected on delivery, slip found late', ...over,
});
const rows = () => tables.so_payment_backdate_requests!;

beforeEach(() => {
  tables = {
    mfg_sales_orders: [
      { doc_no: 'SO-1', status: 'CONFIRMED', company_id: CO, salesperson_id: 11 },
      { doc_no: 'SO-OTHER', status: 'CONFIRMED', company_id: 2, salesperson_id: 11 },
    ],
    so_payment_backdate_requests: [],
    pending_slip_uploads: [{ upload_session_id: 'sess-1', r2_key: 'slips/x.jpg', status: 'uploaded' }],
  };
  sb = fakeSb(tables);
  record.mockClear(); soAudit.mockClear();
});

describe('raising a request', () => {
  it('parks the payment without booking it', async () => {
    const r = await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ uploadSessionId: 'sess-1' }));
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({
      so_doc_no: 'SO-1', status: 'REQUESTED', amount_sen: 50000, paid_at: OLD, method: 'cash',
      requested_by: 11, requested_by_name: 'Sales Amy', slip_key: 'slips/x.jpg', company_id: CO,
    });
    expect(record).not.toHaveBeenCalled();
    expect(tables.pending_slip_uploads![0]).toMatchObject({ status: 'promoted' });
  });

  it('needs a reason', async () => {
    const r = await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ reason: '' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('reason_required');
    expect(rows()).toHaveLength(0);
  });

  it('is refused for a date inside the window — record it directly', async () => {
    const r = await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ paidAt: today }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('no_request_needed');
  });

  it('is refused for a future date — that is a typo, not a late slip', async () => {
    const r = await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ paidAt: shiftIsoDay(today, 2) }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('slip_date_out_of_window');
  });

  it('keeps the method sub-field rule of the payments route', async () => {
    const r = await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ method: 'transfer' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('payment_method_field_required');
  });

  it('does not reach an order in another company', async () => {
    const r = await post(SALES, '/mfg-sales-orders/SO-OTHER/payment-backdate-requests', payment());
    expect(r.status).toBe(404);
    expect(rows()).toHaveLength(0);
  });
});

describe('who sees the requests', () => {
  beforeEach(async () => {
    await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment());
    await post(OTHER, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ amountSen: 1000 }));
  });

  it('the inbox is admin only', async () => {
    expect((await get(SALES, '/payment-backdate-requests')).status).toBe(403);
    const r = await get(ADMIN, '/payment-backdate-requests');
    expect(r.status).toBe(200);
    expect(r.body.requests).toHaveLength(2);
  });

  it('on the order, a non-admin sees only their own request', async () => {
    const mine = await get(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests');
    expect(mine.body.requests.map((x: J) => x.requested_by)).toEqual([11]);
    expect(mine.body.isAdmin).toBe(false);
    const all = await get(ADMIN, '/mfg-sales-orders/SO-1/payment-backdate-requests');
    expect(all.body.requests).toHaveLength(2);
    expect(all.body.isAdmin).toBe(true);
  });
});

describe('deciding', () => {
  let id: string;
  beforeEach(async () => {
    id = (await post(SALES, '/mfg-sales-orders/SO-1/payment-backdate-requests', payment({ uploadSessionId: 'sess-1' }))).body.request.id;
  });

  it('only an admin approves', async () => {
    const r = await post(SALES, `/payment-backdate-requests/${id}/approve`);
    expect(r.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it('approving books exactly the requested payment, past the window, once', async () => {
    const r = await post(ADMIN, `/payment-backdate-requests/${id}/approve`, { note: 'ok' });
    expect(r.status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![1]).toMatchObject({
      docNo: 'SO-1', paidAt: OLD, method: 'cash', amountSen: 50000, slipKey: 'slips/x.jpg', allowOutOfWindowSlipDate: true,
    });
    expect(String(record.mock.calls[0]![1].auditNote)).toContain('requested by Sales Amy');
    expect(rows()[0]).toMatchObject({ status: 'APPROVED', decided_by: 1, payment_id: 'pay-1' });
    const again = await post(ADMIN, `/payment-backdate-requests/${id}/approve`);
    expect(again.status).toBe(409);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('a failed booking hands the request back', async () => {
    record.mockResolvedValueOnce({ payment: null, errorMessage: 'boom' });
    const r = await post(ADMIN, `/payment-backdate-requests/${id}/approve`);
    expect(r.status).toBe(500);
    expect(rows()[0]).toMatchObject({ status: 'REQUESTED', decided_by: null });
  });

  it('rejecting needs a reason and books nothing', async () => {
    expect((await post(ADMIN, `/payment-backdate-requests/${id}/reject`, {})).status).toBe(400);
    const r = await post(ADMIN, `/payment-backdate-requests/${id}/reject`, { note: 'No bank line for this date' });
    expect(r.status).toBe(200);
    expect(rows()[0]).toMatchObject({ status: 'REJECTED', decision_note: 'No bank line for this date' });
    expect(record).not.toHaveBeenCalled();
  });

  it('only the requester (or an admin) withdraws', async () => {
    expect((await post(OTHER, `/mfg-sales-orders/SO-1/payment-backdate-requests/${id}/withdraw`)).status).toBe(403);
    expect((await post(SALES, `/mfg-sales-orders/SO-1/payment-backdate-requests/${id}/withdraw`)).status).toBe(200);
    expect(rows()[0]).toMatchObject({ status: 'WITHDRAWN' });
    expect((await post(ADMIN, `/payment-backdate-requests/${id}/approve`)).status).toBe(409);
  });
});
