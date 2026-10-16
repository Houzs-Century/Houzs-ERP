/* BUG-101 (Sim 2026-10-10, owner 2026-10-12) — HC-SO-2609-395 was proceeded
 * 30/9 with PO-2610-025 out, and an amendment moved its Processing Date to
 * 10/10 on the Purchaser's signature. Pinned here:
 *
 *  · approve refuses a Processing Date move on an order with a live PO;
 *  · a Delivery Date brought forward under a PO waits for PATCH /purchaser-ok,
 *    which only a Purchaser can give, and Logistic's approve then goes through;
 *  · a postponed Delivery Date stays Logistic's alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({});
const audits: Array<{ action: string; note?: string }> = [];

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));
vi.mock('../lib/so-audit', () => ({
  recordSoAudit: async (_sb: unknown, a: { action: string; note?: string }) => { audits.push(a); },
}));
vi.mock('../../services/amendmentNotify', () => ({
  notifySoAmendmentResolved: async () => {},
  notifyPoAmendmentRaised: async () => {},
  notifySoAmendmentHandedOver: async () => {},
}));
const { soAmendments, approveSoCommandHandler } = await import('./so-amendments');

const DOC = 'HC-SO-2609-395';
const am = (id: string, lane: string, header_changes: Row, extra: Row = {}): Row => ({
  id, so_doc_no: DOC, amendment_no: `${DOC}/${id}`, lane, status: 'REQUESTED', version: 1, company_id: 1,
  lane_flag_note: null, requested_by: null, header_changes, purchaser_ok_at: null, ...extra,
});

/* The claim is the first write after the gates: reaching it means every gate
   said yes. Stopped there, so nothing past the gates needs faking. */
const gatedSb = {
  ...sb,
  from: (table: string) => {
    const q = sb.from(table);
    if (table !== 'so_amendments') return q;
    return new Proxy(q, {
      get(target, prop) {
        if (prop === 'update') return () => { throw new Error('reached-claim'); };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  },
};

function appFor(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', { id: 7, email: 'desk@houzs.test', name: 'Desk', permissions } as unknown as User);
    // approve-so is mounted bare (its real route runs inside runScmPgCommand), so
    // the Houzs caller the auth middleware would set is set here.
    c.set('houzsUser', { id: 7, name: 'Desk', permissions } as unknown as Variables['houzsUser']);
    await next();
  });
  app.patch('/:id/approve-so', (c) => approveSoCommandHandler(c, gatedSb));
  app.onError((e, c) => c.json({ error: e.message }, 500));
  app.route('/', soAmendments);
  return app;
}
const call = (perms: string[], id: string, verb: 'approve-so' | 'purchaser-ok') =>
  appFor(perms).request(`/${id}/${verb}`, { method: 'PATCH' });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const row = (id: string) => (sb.tables.so_amendments as Row[]).find((r) => r.id === id)!;

const LOGISTIC = ['scm.amendment.approve_delivery'];
const PURCHASER = ['scm.amendment.approve_lines'];

function seed(poStatus: string | null) {
  sb.tables.so_amendments = [
    am('A1', 'LINES', { processingDate: '2026-10-10' }),
    am('A2', 'DELIVERY', { customerDeliveryDate: '2026-10-15' }),   // brought forward
    am('A3', 'DELIVERY', { customerDeliveryDate: '2026-10-30' }),   // postponed
  ];
  sb.tables.mfg_sales_orders = [{
    doc_no: DOC, company_id: 1, processing_date: '2026-09-30', customer_delivery_date: '2026-10-20',
    debtor_name: 'Customer', address1: 'Jalan 1', postcode: '81100', version: 1, status: 'IN_PRODUCTION',
  }];
  sb.tables.mfg_sales_order_items = [{ id: 'si-1', doc_no: DOC }];
  sb.tables.purchase_order_items = poStatus ? [{ so_item_id: 'si-1', purchase_order_id: 'po-1' }] : [];
  sb.tables.purchase_orders = poStatus ? [{ id: 'po-1', po_number: 'PO-2610-025', status: poStatus }] : [];
}

beforeEach(() => { seed('SUBMITTED'); audits.length = 0; });

describe('approve-so under a live PO', () => {
  it('refuses the Processing Date move the Purchaser signed on HC-SO-2609-395', async () => {
    const res = await call(PURCHASER, 'A1', 'approve-so');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('processing_date_po_locked');
    expect(row('A1').status).toBe('REQUESTED');
  });

  it('refuses a Delivery Date brought forward until a Purchaser OKs it', async () => {
    const res = await call(LOGISTIC, 'A2', 'approve-so');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('purchaser_ok_required');
  });

  it('lets Logistic approve a postponed Delivery Date alone', async () => {
    const res = await call(LOGISTIC, 'A3', 'approve-so');
    expect(await errorOf(res)).toBe('reached-claim');
  });

  it('lets it through when the requester used the override key (stamped on the row)', async () => {
    row('A1').po_date_override_by = 'staff-owner';
    expect(await errorOf(await call(PURCHASER, 'A1', 'approve-so'))).toBe('reached-claim');
  });

  it('lets an approver who holds the override key through', async () => {
    const res = await call([...PURCHASER, 'scm.so.override_po_processing_date'], 'A1', 'approve-so');
    expect(await errorOf(res)).toBe('reached-claim');
  });

  it('with no live PO, neither rule applies', async () => {
    seed('CANCELLED');
    expect(await errorOf(await call(PURCHASER, 'A1', 'approve-so'))).toBe('reached-claim');
    expect(await errorOf(await call(LOGISTIC, 'A2', 'approve-so'))).toBe('reached-claim');
  });
});

describe('PATCH /:id/purchaser-ok', () => {
  it('a Purchaser OKs it, and Logistic can then approve', async () => {
    const res = await call(PURCHASER, 'A2', 'purchaser-ok');
    expect(res.status).toBe(200);
    expect(row('A2').purchaser_ok_at).toBeTruthy();
    expect(row('A2').status).toBe('REQUESTED');
    expect(row('A2').version).toBe(2);
    expect(audits.map((a) => a.action)).toEqual(['AMENDMENT_PURCHASER_OK']);

    expect(await errorOf(await call(LOGISTIC, 'A2', 'approve-so'))).toBe('reached-claim');
  });

  it('only a Purchaser can give it', async () => {
    expect((await call(LOGISTIC, 'A2', 'purchaser-ok')).status).toBe(403);
    expect(row('A2').purchaser_ok_at).toBeNull();
  });

  it('refuses a postponement, a LINES row, and a second OK', async () => {
    expect(await errorOf(await call(PURCHASER, 'A3', 'purchaser-ok'))).toBe('purchaser_ok_not_needed');
    expect(await errorOf(await call(PURCHASER, 'A1', 'purchaser-ok'))).toBe('bad_transition');
    await call(PURCHASER, 'A2', 'purchaser-ok');
    expect(await errorOf(await call(PURCHASER, 'A2', 'purchaser-ok'))).toBe('already_ok');
  });
});
