/* Books › Commission release, the route's replies (owner 2026-11-25). Made-up
   figures. Pinned: the page's answer — the switch, the two accounts, the lines on
   the prepayment, each bill's layer, each month, what is booked and the runs;
   one bill's orders; a run refused while the release is off; the switch takes a
   true or false only and, turned on, books the months that have ended; the
   permission gate answers at this end. Real handlers, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  commissionReleaseOrders, commissionReleaseRun, commissionReleaseSettings, commissionReleaseStatus,
} from '../src/scm/routes/accounting-commission-release';

const CO = 1;
const GL_PERM = 'scm.payment_voucher.post';

const acct = (code: string, name: string, parent: string | null, type: string): Row => ({ company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: parent, is_active: true });
const gl = (over: Row): Row => ({ company_id: CO, account_code: '360-0050', posted: true, reversed: false, reversed_by_je: null, debit_sen: 0, credit_sen: 0, source_type: 'API', ...over });
const so = (doc_no: string, so_date: string, total: number): Row => ({ company_id: CO, doc_no, so_date, status: 'CONFIRMED', total_revenue_sen: total, local_total_sen: total, mattress_sofa_sen: total, bedframe_sen: 0, accessories_sen: 0, others_sen: 0 });

function harness(perms: readonly string[] = [GL_PERM], on = false) {
  const t: Record<string, Row[]> = {
    companies: [{ id: CO, code: 'HC' }],
    accounts: [
      acct('360-0000', 'PREPAYMENT & ADVANCE', null, 'ASSET'), acct('360-0050', 'PREPAYMENT COMMISSION', '360-0000', 'ASSET'),
      acct('900-0000', 'EXPENSES', null, 'EXPENSE'), acct('900-C003', 'COMMISSION ( EVENT )', '900-0000', 'EXPENSE'),
    ],
    acc_account_roles: [],
    acc_company_settings: [{ company_id: CO, commission_release_on: on, books_start_date: '2026-09-01' }],
    v_gl_entries: [
      gl({ line_id: 1, je_no: 'JE-0', entry_date: '2026-08-31', source_type: 'OPENING', source_doc_no: 'OPEN', debit_sen: 300_00, notes: 'B/F' }),
      gl({ line_id: 2, je_no: 'JE-1', entry_date: '2026-10-31', source_doc_no: 'API-OCT', debit_sen: 500_00, notes: "PAYROLL - OCT'26" }),
    ],
    event_commission_closes: [{ company_id: CO, month: '2026-10-01', paid: { so_date: { 'SO-A': 300_00, 'SO-B': 200_00 }, fair: {} }, carried: { so_date: [], fair: [] } }],
    mfg_sales_orders: [so('SO-OLD', '2026-06-01', 3_000_00), so('SO-A', '2026-10-03', 2_000_00), so('SO-B', '2026-10-09', 1_000_00)],
    sales_invoices: [
      { id: 1, company_id: CO, so_doc_no: 'SO-OLD', invoice_date: '2026-09-10', total_sen: 3_000_00, status: 'SENT' },
      { id: 2, company_id: CO, so_doc_no: 'SO-A', invoice_date: '2026-10-20', total_sen: 2_000_00, status: 'PAID' },
      { id: 3, company_id: CO, so_doc_no: 'SO-B', invoice_date: '2026-11-15', total_sen: 500_00, status: 'SENT' },
    ],
    acc_deposit_invoices: [], acc_credit_notes: [], mfg_so_audit_log: [], so_total_changes: [],
    journal_entries: [], journal_entry_lines: [], acc_commission_release_runs: [],
  };
  const sb = fakeSb(t);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/commission-release', commissionReleaseStatus as never);
  app.get('/accounting/commission-release/orders', commissionReleaseOrders as never);
  app.post('/accounting/commission-release/run', commissionReleaseRun as never);
  app.post('/accounting/commission-release/settings', commissionReleaseSettings as never);
  return { app, t };
}
const get = async (app: Hono, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() as any };
};
const post = async (app: Hono, path: string, body: unknown) => {
  const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  /* 2 December 2026, 10:00 MYT: November is the last month that has ended. */
  vi.setSystemTime(new Date(Date.UTC(2026, 11, 2, 2, 0, 0)));
});
afterEach(() => vi.useRealTimers());

describe('GET /accounting/commission-release', () => {
  test('the switch, the accounts, the prepayment, each layer and each month; nothing booked while off', async () => {
    const { app } = harness();
    const { status, body } = await get(app, '/accounting/commission-release');
    expect(status).toBe(200);
    expect(body.on).toBe(false);
    expect(body.booksStart).toBe('2026-09');
    expect(body.currentMonth).toBe('2026-12');
    expect(body.lastMonth).toBe('2026-11');
    expect(body.accounts).toEqual({ prepaid: { code: '360-0050', name: 'PREPAYMENT COMMISSION' }, expense: { code: '900-C003', name: 'COMMISSION ( EVENT )' } });
    expect(body.prepaid.map((p: any) => [p.docNo, p.month, p.amountSen])).toEqual([['OPEN', null, 300_00], ['API-OCT', '2026-10', 500_00]]);
    expect(body.layers.map((l: any) => [l.key, l.basis, l.orders, l.releasedSen, l.leftSen])).toEqual([
      ['bill:2026-10', 'close', 2, 400_00, 100_00],
      ['opening', 'goods', 1, 300_00, 0],
    ]);
    expect(body.months.map((m: any) => [m.month, m.totalSen])).toEqual([['2026-09', 300_00], ['2026-10', 300_00], ['2026-11', 100_00], ['2026-12', 0]]);
    expect(body.posted).toEqual([]);
    expect(body.runs).toEqual([]);
  });

  test('the permission gate answers at this end', async () => {
    const { app } = harness([]);
    expect((await get(app, '/accounting/commission-release')).status).toBe(403);
    expect((await post(app, '/accounting/commission-release/settings', { on: true })).status).toBe(403);
  });
});

describe('GET /accounting/commission-release/orders', () => {
  test('one bill\'s orders: each share, how much is invoiced, released and left', async () => {
    const { app } = harness();
    const { status, body } = await get(app, '/accounting/commission-release/orders?layer=bill:2026-10');
    expect(status).toBe(200);
    expect(body.orders.map((o: any) => [o.docNo, o.shareSen, o.sold, o.releasedSen, o.leftSen])).toEqual([
      ['SO-A', 300_00, 1, 300_00, 0],
      ['SO-B', 200_00, 0.5, 100_00, 100_00],
    ]);
  });
  test('a layer the prepayment does not hold, or a malformed one, is refused by name', async () => {
    const { app } = harness();
    expect((await get(app, '/accounting/commission-release/orders?layer=bill:2026-07')).status).toBe(404);
    expect((await get(app, '/accounting/commission-release/orders?layer=everything')).body.error).toBe('bad_layer');
  });
});

describe('the switch and the run', () => {
  test('a run while the release is off is refused; nothing is booked', async () => {
    const { app, t } = harness();
    const { status, body } = await post(app, '/accounting/commission-release/run', {});
    expect(status).toBe(409);
    expect(body.error).toBe('release_off');
    expect(t.journal_entries).toEqual([]);
  });

  test('the switch takes true or false only; on, it books the months that have ended at once', async () => {
    const { app, t } = harness();
    expect((await post(app, '/accounting/commission-release/settings', { on: 'yes' })).body.error).toBe('bad_switch');
    const { status, body } = await post(app, '/accounting/commission-release/settings', { on: true });
    expect(status).toBe(200);
    expect(body.outcomes.map((o: any) => [o.month, o.action, o.releasedSen])).toEqual([
      ['2026-09', 'posted', 300_00], ['2026-10', 'posted', 300_00], ['2026-11', 'posted', 100_00],
    ]);
    expect(t.acc_company_settings![0]!.commission_release_on).toBe(true);
    const after = await get(app, '/accounting/commission-release');
    expect(after.body.on).toBe(true);
    expect(after.body.posted.map((p: any) => [p.month, p.releasedSen, p.reposted])).toEqual([['2026-09', 300_00, false], ['2026-10', 300_00, false], ['2026-11', 100_00, false]]);
    expect(after.body.runs).toHaveLength(3);
    /* A second run with nothing moved changes nothing. */
    const again = await post(app, '/accounting/commission-release/run', {});
    expect(again.status).toBe(200);
    expect(again.body.outcomes.map((o: any) => o.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  test('turned off, nothing new is booked and what is booked stays', async () => {
    const { app, t } = harness([GL_PERM], true);
    await post(app, '/accounting/commission-release/run', {});
    const booked = t.journal_entries!.length;
    const off = await post(app, '/accounting/commission-release/settings', { on: false });
    expect(off.body).toEqual({ ok: true, on: false, outcomes: [] });
    expect(t.journal_entries).toHaveLength(booked);
  });
});
