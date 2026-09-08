/* Cancelling a Sales Order / Purchase Order now needs a reason and two
 * signatures (owner 2026-09-08). This suite drives the request routes and the
 * guard in front of the two existing cancel endpoints over the in-memory
 * PostgREST fake, with the audit + notify + downstream-lock collaborators
 * stubbed: what is under test is the wiring — who may do what, in which order,
 * and that the cancel stays refused until both signatures are on the row. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const notify = vi.fn(async () => undefined);
vi.mock('../../services/cancelRequestNotify', () => ({ notifyCancelRequest: (...a: unknown[]) => notify(...(a as [])) }));
const soAudit = vi.fn(async (_sb: unknown, _args: unknown) => undefined);
vi.mock('../lib/so-audit', () => ({ recordSoAudit: (sb: unknown, args: unknown) => soAudit(sb, args) }));
const poAudit = vi.fn(async (_sb: unknown, _args: unknown) => ({ ok: true }));
vi.mock('../lib/entity-audit', () => ({ recordEntityAudit: (sb: unknown, args: unknown) => poAudit(sb, args) }));
let downstream: { error: string; message: string } | null = null;
vi.mock('../lib/downstream-lock', () => ({
  soHasDownstream: async () => downstream,
  poHasDownstream: async () => downstream,
}));
vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));

const CO = 1;
let sb: ReturnType<typeof fakeSb>;
let tables: Record<string, Array<Record<string, unknown>>>;

const CALLER = { id: 'staff-uuid', email: 'x@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

const {
  cancelApprovalGuard, soCancelRequests, poCancelRequests, cancelRequestsInbox,
  cancelApproverWriteBypass, CANCEL_REQUEST_OPEN_READ_PATH,
} = await import('./document-cancel-routes');

type Who = { id: number; name: string; perms: string[] };
const REQUESTER: Who = { id: 11, name: 'Sales Amy', perms: ['scm.access', 'scm.so.view_all'] };
const L1: Who = { id: 21, name: 'Ops Ben', perms: ['scm.access', 'scm.so.view_all', 'scm.so_cancel.approve_l1', 'scm.po_cancel.approve_l1'] };
const L2: Who = { id: 31, name: 'MD Cara', perms: ['*'] };
const BOTH: Who = { id: 41, name: 'IT Dan', perms: ['*'] };
const NOBODY: Who = { id: 51, name: 'Eve', perms: ['scm.access', 'scm.so.view_all'] };

/** A handler standing in for the real cancel routes: it answers 200 when
 *  reached, so the test can tell "the guard let it through" from "refused". */
const reached = vi.fn();

function app(who: Who) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', CO);
    c.set('supabase', sb as unknown as SupabaseClient);
    c.set('houzsUser', { id: who.id, name: who.name, permissions_set: new Set(who.perms), permissions: who.perms });
    await next();
  });
  a.use('/mfg-sales-orders/:docNo/status', cancelApprovalGuard('SO'));
  a.use('/mfg-purchase-orders/:id/cancel', cancelApprovalGuard('PO'));
  a.route('/mfg-sales-orders', soCancelRequests);
  a.route('/mfg-purchase-orders', poCancelRequests);
  a.patch('/mfg-sales-orders/:docNo/status', async (c) => { reached((await c.req.json()).status); return c.json({ ok: true }); });
  a.patch('/mfg-purchase-orders/:id/cancel', (c) => { reached('po'); return c.json({ ok: true }); });
  a.route('/cancel-requests', cancelRequestsInbox);
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies in a test are read loosely on purpose
type J = Record<string, any>;
const body = async (res: Response): Promise<J> => (await res.json()) as J;
const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ENV = {} as Env;
const post = (who: Who, path: string, body?: unknown) => app(who).request(path, { method: 'POST', ...(body === undefined ? {} : json(body)) }, ENV);
const patch = (who: Who, path: string, body?: unknown) => app(who).request(path, { method: 'PATCH', ...(body === undefined ? {} : json(body)) }, ENV);
const get = (who: Who, path: string) => app(who).request(path, undefined, ENV);

beforeEach(() => {
  tables = {
    mfg_sales_orders: [
      { doc_no: 'SO-1', status: 'CONFIRMED', company_id: CO, salesperson_id: 11 },
      { doc_no: 'SO-DRAFT', status: 'DRAFT', company_id: CO, salesperson_id: 11 },
      { doc_no: 'SO-DONE', status: 'CANCELLED', company_id: CO, salesperson_id: 11 },
      { doc_no: 'SO-OTHER', status: 'CONFIRMED', company_id: 2, salesperson_id: 11 },
    ],
    purchase_orders: [
      { id: 'po-1', po_number: 'PO-1', status: 'SUBMITTED', company_id: CO },
      { id: 'po-draft', po_number: 'PO-D', status: 'DRAFT', company_id: CO },
    ],
    document_cancel_requests: [],
  };
  sb = fakeSb(tables);
  downstream = null;
  notify.mockClear(); soAudit.mockClear(); poAudit.mockClear(); reached.mockClear();
});

const rows = () => tables.document_cancel_requests;

describe('raising a request', () => {
  it('needs a reason', async () => {
    const res = await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'no' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'reason_required' });
    expect(rows()).toHaveLength(0);
  });

  it('creates the row, audits, and tells the level-1 desk', async () => {
    const res = await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer cancelled the order' });
    expect(res.status).toBe(201);
    const { request } = await body(res);
    expect(request).toMatchObject({
      doc_type: 'SO', doc_key: 'SO-1', doc_number: 'SO-1', status: 'REQUESTED',
      reason: 'Customer cancelled the order', requested_by: 11, requested_by_name: 'Sales Amy', company_id: CO,
      doc_status_at_request: 'CONFIRMED',
    });
    expect(soAudit).toHaveBeenCalledTimes(1);
    expect(soAudit.mock.calls[0]![1]).toMatchObject({ docNo: 'SO-1', action: 'CANCEL_SUBMIT_FOR_APPROVAL', actorName: 'Sales Amy' });
    expect(notify).toHaveBeenCalledWith(expect.anything(), 'raised', expect.objectContaining({ docType: 'SO', docNumber: 'SO-1', requesterUserId: 11 }));
  });

  it('a PO request audits on the entity log with the real caller', async () => {
    const res = await post(REQUESTER, '/mfg-purchase-orders/po-1/cancel-request', { reason: 'Supplier cannot deliver' });
    expect(res.status).toBe(201);
    expect((await body(res)).request).toMatchObject({ doc_type: 'PO', doc_key: 'po-1', doc_number: 'PO-1' });
    expect(poAudit.mock.calls[0]![1]).toMatchObject({ entityType: 'PURCHASE_ORDER', entityId: 'po-1', entityDocNo: 'PO-1', action: 'SUBMIT_FOR_APPROVAL', actor: { id: 11, name: 'Sales Amy' } });
  });

  it('refuses a second open request on the same document', async () => {
    await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer cancelled the order' });
    const res = await post(NOBODY, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Another reason entirely' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cancel_request_open' });
    expect(rows()).toHaveLength(1);
  });

  it('refuses a draft, a cancelled document, a locked document, and another company\'s', async () => {
    expect((await post(REQUESTER, '/mfg-sales-orders/SO-DRAFT/cancel-request', { reason: 'Junk scan draft' })).status).toBe(409);
    expect(await body(await post(REQUESTER, '/mfg-sales-orders/SO-DONE/cancel-request', { reason: 'Already gone' }))).toMatchObject({ error: 'already_cancelled' });
    expect((await post(REQUESTER, '/mfg-purchase-orders/po-draft/cancel-request', { reason: 'Draft purchase' })).status).toBe(409);
    expect((await post(REQUESTER, '/mfg-sales-orders/SO-OTHER/cancel-request', { reason: 'Wrong company' })).status).toBe(404);
    downstream = { error: 'so_locked_downstream', message: 'A delivery order exists.' };
    const locked = await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer cancelled' });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: 'so_locked_downstream' });
    expect(rows()).toHaveLength(0);
  });
});

describe('the two signatures', () => {
  beforeEach(async () => {
    await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer cancelled the order' });
    notify.mockClear();
  });

  it('level 1 by a level-1 holder, level 2 by a different level-2 holder, then execute', async () => {
    const l1 = await post(L1, '/mfg-sales-orders/SO-1/cancel-request/approve');
    expect(l1.status).toBe(200);
    expect(await l1.json()).toMatchObject({ execute: false, request: { status: 'L1_APPROVED', l1_by: 21, l1_by_name: 'Ops Ben' } });
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), 'level1', expect.objectContaining({ actorUserId: 21 }));

    const l2 = await post(L2, '/mfg-sales-orders/SO-1/cancel-request/approve');
    expect(l2.status).toBe(200);
    expect(await l2.json()).toMatchObject({ execute: true, request: { status: 'APPROVED', l2_by: 31, l2_by_name: 'MD Cara' } });
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), 'approved', expect.objectContaining({ requesterUserId: 11, actorUserId: 31 }));
    expect(soAudit).toHaveBeenCalledTimes(3);
  });

  it('the requester cannot sign, and a wildcard holder cannot sign twice', async () => {
    expect(await body(await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request/approve'))).toMatchObject({ error: 'self_approval' });
    expect((await post(BOTH, '/mfg-sales-orders/SO-1/cancel-request/approve')).status).toBe(200);
    const again = await post(BOTH, '/mfg-sales-orders/SO-1/cancel-request/approve');
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ error: 'same_signer' });
    expect(rows()[0]).toMatchObject({ status: 'L1_APPROVED' });
  });

  it('a level-1 holder cannot give level 2; a nobody cannot give either', async () => {
    expect(await body(await post(NOBODY, '/mfg-sales-orders/SO-1/cancel-request/approve'))).toMatchObject({ error: 'approve_forbidden' });
    await post(L1, '/mfg-sales-orders/SO-1/cancel-request/approve');
    const res = await post(L1, '/mfg-sales-orders/SO-1/cancel-request/approve');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'same_signer' });
  });

  it('an approver may reject with a reason; the requester is told', async () => {
    expect((await post(L1, '/mfg-sales-orders/SO-1/cancel-request/reject', { reason: 'x' })).status).toBe(400);
    expect(await body(await post(NOBODY, '/mfg-sales-orders/SO-1/cancel-request/reject', { reason: 'Not a good reason' }))).toMatchObject({ error: 'reject_forbidden' });
    const res = await post(L1, '/mfg-sales-orders/SO-1/cancel-request/reject', { reason: 'Production already started' });
    expect(res.status).toBe(200);
    expect((await body(res)).request).toMatchObject({ status: 'REJECTED', rejected_by: 21, reject_reason: 'Production already started' });
    expect(notify).toHaveBeenLastCalledWith(expect.anything(), 'rejected', expect.objectContaining({ requesterUserId: 11, reason: 'Production already started' }));
    /* Closed — a fresh request may now be raised. */
    expect((await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer insists on cancelling' })).status).toBe(201);
  });

  it('the requester may withdraw, silently; a stranger may not', async () => {
    expect(await body(await post(NOBODY, '/mfg-sales-orders/SO-1/cancel-request/withdraw'))).toMatchObject({ error: 'withdraw_forbidden' });
    const res = await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request/withdraw');
    expect(res.status).toBe(200);
    expect((await body(res)).request).toMatchObject({ status: 'WITHDRAWN' });
    expect(notify).not.toHaveBeenCalled();
    expect((await post(L1, '/mfg-sales-orders/SO-1/cancel-request/approve')).status).toBe(404);
  });

  it('the document answers its open request and history; the inbox lists open ones', async () => {
    const detail = await body(await get(NOBODY, '/mfg-sales-orders/SO-1/cancel-request'));
    expect(detail.open).toMatchObject({ status: 'REQUESTED' });
    expect(detail.history).toHaveLength(1);
    expect(detail.needsApproval).toBe(true);
    await post(REQUESTER, '/mfg-purchase-orders/po-1/cancel-request', { reason: 'Supplier cannot deliver' });
    const inbox = await body(await get(NOBODY, '/cancel-requests'));
    expect(inbox.requests.map((r: { doc_number: string }) => r.doc_number).sort()).toEqual(['PO-1', 'SO-1']);
    await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request/withdraw');
    expect((await body(await get(NOBODY, '/cancel-requests'))).requests).toHaveLength(1);
    expect((await body(await get(NOBODY, '/cancel-requests?scope=all'))).requests).toHaveLength(2);
  });
});

describe('the area-guard bypass for approvers', () => {
  const ctx = (method: string, path: string, perms: string[]) => ({
    req: { method, path },
    get: (_k: 'user') => ({ permissions_set: new Set(perms) }),
  });
  it('admits only the three approver verbs, only for a holder of that document\'s keys', () => {
    const so = cancelApproverWriteBypass('SO');
    expect(so(ctx('POST', '/api/scm/mfg-sales-orders/SO-1/cancel-request/approve', ['scm.so_cancel.approve_l2']))).toBe(true);
    expect(so(ctx('POST', '/api/scm/mfg-sales-orders/SO-1/cancel-request/reject', ['scm.so_cancel.approve_l1']))).toBe(true);
    expect(so(ctx('POST', '/api/scm/mfg-sales-orders/SO-1/cancel-request/withdraw', ['scm.so_cancel.approve_l1']))).toBe(true);
    /* Raising a request is NOT admitted by the key — that still needs the area's edit. */
    expect(so(ctx('POST', '/api/scm/mfg-sales-orders/SO-1/cancel-request', ['scm.so_cancel.approve_l1']))).toBe(false);
    /* The other document's key does not open this prefix. */
    expect(so(ctx('POST', '/api/scm/mfg-sales-orders/SO-1/cancel-request/approve', ['scm.po_cancel.approve_l1']))).toBe(false);
    /* Any other write on the prefix stays behind the area. */
    expect(so(ctx('PATCH', '/api/scm/mfg-sales-orders/SO-1/status', ['scm.so_cancel.approve_l2']))).toBe(false);
    expect(so(ctx('POST', '/api/scm/mfg-sales-orders/SO-1/cancel-request/approve', ['scm.access']))).toBe(false);
    expect(cancelApproverWriteBypass('PO')(ctx('POST', '/api/scm/mfg-purchase-orders/po-1/cancel-request/approve', ['scm.po_cancel.approve_l1']))).toBe(true);
    expect(CANCEL_REQUEST_OPEN_READ_PATH).toBe('/cancel-request');
  });
});

describe('the guard in front of the cancel', () => {
  it('lets every non-cancel status transition through untouched', async () => {
    const res = await patch(NOBODY, '/mfg-sales-orders/SO-1/status', { status: 'IN_PRODUCTION' });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledWith('IN_PRODUCTION');
  });

  it('refuses a cancel with no request, and one with only one signature', async () => {
    const none = await patch(L2, '/mfg-sales-orders/SO-1/status', { status: 'CANCELLED' });
    expect(none.status).toBe(403);
    expect(await none.json()).toMatchObject({ error: 'cancel_approval_required' });
    await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer cancelled the order' });
    await post(L1, '/mfg-sales-orders/SO-1/cancel-request/approve');
    const one = await patch(L2, '/mfg-sales-orders/SO-1/status', { status: 'cancelled' });
    expect(one.status).toBe(403);
    expect((await body(one)).message).toContain('1 of 2');
    expect(reached).not.toHaveBeenCalled();
  });

  it('lets an APPROVED request through, then stamps it EXECUTED — once', async () => {
    await post(REQUESTER, '/mfg-sales-orders/SO-1/cancel-request', { reason: 'Customer cancelled the order' });
    await post(L1, '/mfg-sales-orders/SO-1/cancel-request/approve');
    await post(L2, '/mfg-sales-orders/SO-1/cancel-request/approve');
    const res = await patch(L2, '/mfg-sales-orders/SO-1/status', { status: 'CANCELLED', version: 3 });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledWith('CANCELLED');
    expect(rows()[0]).toMatchObject({ status: 'EXECUTED', executed_by: 31 });
    /* The row is spent: a second cancel call is refused again. */
    expect((await patch(L2, '/mfg-sales-orders/SO-1/status', { status: 'CANCELLED' })).status).toBe(403);
  });

  it('a draft purchase order needs no approval; a live one does', async () => {
    expect((await patch(NOBODY, '/mfg-purchase-orders/po-draft/cancel')).status).toBe(200);
    expect((await patch(NOBODY, '/mfg-purchase-orders/po-1/cancel')).status).toBe(403);
    await post(REQUESTER, '/mfg-purchase-orders/po-1/cancel-request', { reason: 'Supplier cannot deliver' });
    await post(L1, '/mfg-purchase-orders/po-1/cancel-request/approve');
    await post(L2, '/mfg-purchase-orders/po-1/cancel-request/approve');
    expect((await patch(NOBODY, '/mfg-purchase-orders/po-1/cancel')).status).toBe(200);
    expect(rows()[0]).toMatchObject({ doc_type: 'PO', status: 'EXECUTED' });
  });

  it('falls through on an unknown document so the handler gives its own 404', async () => {
    const res = await patch(NOBODY, '/mfg-sales-orders/NOPE/status', { status: 'CANCELLED' });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledWith('CANCELLED');
  });
});
