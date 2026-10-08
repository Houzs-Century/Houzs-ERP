/* How many payment requests wait for Finance (owner 2026-10-08: 在payment
   voucher 会有一个接口 … 提醒我有几个payment request 还没proceed) — the count
   behind the PV page's reminder and the sidebar badge. Pinned:
     • the same reading as the page's 「Waiting for Finance」 (requestStage):
       SUBMITTED; answered by an AP invoice since cancelled; answered (no AP
       invoice) by a voucher since cancelled, or by nothing at all;
     • a live answer, a returned or withdrawn request, another company's: not counted;
     • only Finance is counted for — anyone else reads 0 and nothing is read.
   The count rides PostgREST inner embeds (ap_invoices!inner / payment_vouchers
   !inner), which the shared fake does not speak — so this file carries a small
   fake of exactly the shape the handler asks: head counts, eq / is filters, and
   an embed's status filtered through its alias. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { paymentRequests } from '../src/scm/routes/payment-requests';
import { requestStage } from '../src/scm/lib/payment-request';

type Row = Record<string, unknown>;
const CO = 1;

const REQUESTS: Row[] = [
  { id: 'r-sub', company_id: 1, status: 'SUBMITTED', pv_id: null, ap_invoice_id: null },
  { id: 'r-pv-live', company_id: 1, status: 'VOUCHERED', pv_id: 'pv-1', ap_invoice_id: null },
  { id: 'r-pv-gone', company_id: 1, status: 'VOUCHERED', pv_id: 'pv-2', ap_invoice_id: null },
  { id: 'r-api-gone', company_id: 1, status: 'VOUCHERED', pv_id: null, ap_invoice_id: 'api-2' },
  { id: 'r-api-live', company_id: 1, status: 'VOUCHERED', pv_id: 'pv-2', ap_invoice_id: 'api-1' },
  { id: 'r-none', company_id: 1, status: 'VOUCHERED', pv_id: null, ap_invoice_id: null },
  { id: 'r-back', company_id: 1, status: 'REJECTED', pv_id: null, ap_invoice_id: null },
  { id: 'r-off', company_id: 1, status: 'WITHDRAWN', pv_id: null, ap_invoice_id: null },
  { id: 'r-other-co', company_id: 2, status: 'SUBMITTED', pv_id: null, ap_invoice_id: null },
];
const VOUCHERS: Record<string, string> = { 'pv-1': 'DRAFT', 'pv-2': 'CANCELLED' };
const INVOICES: Record<string, string> = { 'api-1': 'POSTED', 'api-2': 'CANCELLED' };

/* The handler's query shape, answered from the fixtures. */
function fakeSb(reads: string[]) {
  return {
    from(table: string) {
      reads.push(table);
      let cols = '';
      const filters: Array<(r: Row) => boolean> = [];
      const statusOf = (r: Row, path: string): unknown => {
        if (path === 'inv.status') return r.ap_invoice_id == null ? undefined : INVOICES[String(r.ap_invoice_id)];
        if (path === 'pv.status') return r.pv_id == null ? undefined : VOUCHERS[String(r.pv_id)];
        return r[path];
      };
      const q = {
        select(c: string, opts?: { count?: string; head?: boolean }) {
          cols = c;
          expect(opts).toEqual({ count: 'exact', head: true });
          return q;
        },
        eq(col: string, val: unknown) { filters.push((r) => statusOf(r, col) === val); return q; },
        is(col: string, val: null) { filters.push((r) => (r[col] ?? null) === val); return q; },
        then(resolve: (v: { count: number; error: null }) => unknown) {
          let rows = REQUESTS.slice();
          /* An inner embed keeps only the rows whose embedded row exists. */
          if (cols.includes('ap_invoices!inner')) rows = rows.filter((r) => r.ap_invoice_id != null);
          if (cols.includes('payment_vouchers!inner')) rows = rows.filter((r) => r.pv_id != null);
          return Promise.resolve({ count: rows.filter((r) => filters.every((f) => f(r))).length, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
}

function as(perms: string[], reads: string[]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, fakeSb(reads) as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/payment-requests', paymentRequests);
  return async () => {
    const res = await app.request('/payment-requests/waiting-count');
    return { status: res.status, body: await res.json() as Row };
  };
}

describe('payment requests waiting for Finance', () => {
  test('counts what the page calls 「Waiting for Finance」 — and nothing else', async () => {
    const reads: string[] = [];
    const r = await as(['scm.payment_voucher.create'], reads)();
    expect(r).toEqual({ status: 200, body: { count: 4 } });
    /* The same answer the page reads off each request's stage. */
    const waiting = REQUESTS.filter((q) => q.company_id === CO).filter((q) => {
      const inv = q.ap_invoice_id ? { id: String(q.ap_invoice_id), status: INVOICES[String(q.ap_invoice_id)] } : null;
      const pv = q.pv_id ? { id: String(q.pv_id), status: VOUCHERS[String(q.pv_id)] } : null;
      const stage = requestStage(String(q.status), pv as never, false, inv as never);
      return stage === 'SUBMITTED' || stage === 'VOUCHER_CANCELLED';
    });
    expect(waiting.map((q) => q.id)).toEqual(['r-sub', 'r-pv-gone', 'r-api-gone', 'r-none']);
  });

  test('anyone but Finance reads 0, and nothing is read', async () => {
    const reads: string[] = [];
    expect(await as(['scm.payment_request.create'], reads)()).toEqual({ status: 200, body: { count: 0 } });
    expect(reads).toEqual([]);
  });
});
