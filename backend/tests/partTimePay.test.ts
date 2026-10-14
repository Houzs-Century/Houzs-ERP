/* Part-time sales pay (owner 2026-10-14): a part-timer at an event is paid 2%
   of their sales (nothing when they sold nothing), RM 120 for each day they
   logged into the POS, and one RM 20 WiFi allowance per event; the owner keys
   the sheet with the bank details, HR confirms, the confirm raises the payment
   request, Finance pays one voucher per person and attaches the bank slip, which
   the sheet then shows. Pinned through the real routers:
     • the day count and arrival time come from the POS logins, by Malaysian
       calendar day, inside the event's period; a day with a sale and no login
       counts too;
     • the sales figure is the event's orders by that salesperson, draft /
       cancelled / held left out, never a sum keyed by hand;
     • one WiFi allowance per event; zero sales earns no commission;
     • the owner keys and removes, HR confirms, nobody else; a confirmed row
       cannot change; sales that moved since the save stop the confirm;
     • the confirm raises a SUBMITTED payment request with the event's title and
       dates as its purpose and the breakdown as its note; Finance's voucher
       answers it without a bill, and its files read back on the sheet.
   Same fake-PostgREST harness as tests/paymentRequests.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { paymentVouchers } from '../src/scm/routes/payment-vouchers';
import { paymentRequests } from '../src/scm/routes/payment-requests';
import { partTimePay } from '../src/scm/routes/hr-part-time-pay';
import { partTimeAmounts, partTimeBreakdown, partTimePurpose, workDays } from '../src/scm/lib/part-time-pay';

const CO = 1;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const OWNER = { id: 1, name: 'Ummu', perms: ['scm.part_time_pay.request'] };
const HR = { id: 7, name: 'Mei Ling', perms: ['scm.part_time_pay.confirm'] };
const FINANCE = { id: 9, name: 'Rachael', perms: PV_KEYS };
const NOBODY = { id: 50, name: 'Warehouse', perms: ['scm.access'] };

const AINA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHOO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const EVENTS: Row[] = [
  { id: 348, company_id: 1, code: '2026-10-ZANOTTI-REX', name: 'Kuala Lumpur [ZANOTTI] REX @ MITEC', start_date: '2026-10-13', end_date: '2026-10-15', status: 'confirmed', archived_at: null },
  { id: 349, company_id: 1, code: '2026-10-AKEMI-IOI', name: 'Putrajaya [AKEMI] @ IOI CITY MALL', start_date: '2026-10-20', end_date: '2026-10-26', status: 'confirmed', archived_at: null },
];

/* env.DB as the routes read it: the events (lib/event-tags.ts) and the members'
   company grants (lib/staffCompanyScope.ts). */
const fakeDb = {
  prepare(sql: string) {
    return {
      bind(...vals: unknown[]) {
        return {
          async all<T>() {
            if (/FROM user_companies WHERE user_id IN/.test(sql)) {
              return { results: vals.map((v) => ({ user_id: Number(v), company_id: CO })) as unknown as T[] };
            }
            if (/FROM projects p/.test(sql)) {
              let hit = EVENTS.slice();
              const co = /p\.company_id = (\d+)/.exec(sql);
              if (co) hit = hit.filter((r) => r.company_id === Number(co[1]));
              if (/p\.id IN/.test(sql)) hit = hit.filter((r) => vals.map(Number).includes(r.id));
              return { results: hit.map((r) => ({ id: r.id, code: r.code, name: r.name, startdate: r.start_date, enddate: r.end_date, status: r.status, archivedat: r.archived_at })) as unknown as T[] };
            }
            return { results: [] as T[] };
          },
          async first<T>() { return null as T | null; },
          async run() { return {}; },
        };
      },
    };
  },
};

const fakeR2 = () => {
  const store = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) => { store.set(k, { bytes: v, contentType: o?.httpMetadata?.contentType ?? '' }); },
    get: async (k: string) => {
      const hit = store.get(k);
      return hit ? { arrayBuffer: async () => hit.bytes, body: new Blob([hit.bytes]).stream(), httpMetadata: { contentType: hit.contentType } } : null;
    },
    delete: async (k: string) => { store.delete(k); },
  };
};

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});

const so = (doc: string, staff: string, date: string, totalSen: number, over: Row = {}): Row => ({
  doc_no: doc, company_id: CO, project_id: 348, salesperson_id: staff, so_date: date, total_revenue_sen: totalSen, status: 'CONFIRMED', on_hold: false, ...over,
});

/* Aina: three days at the fair — 07:30 MYT on the first day (23:30 UTC the day
   before), twice on the second, once on the third — and a login after the fair
   that does not count. Ben: one day. Choo: no login, one sale on the last day. */
const LOGINS: Row[] = [
  { id: 1, company_id: CO, staff_id: AINA, user_id: 101, session_sid: 's1', logged_in_at: '2026-10-12T23:30:00.000Z', logged_out_at: '2026-10-13T14:00:00.000Z' },
  { id: 2, company_id: CO, staff_id: AINA, user_id: 101, session_sid: 's2', logged_in_at: '2026-10-14T01:05:00.000Z', logged_out_at: null },
  { id: 3, company_id: CO, staff_id: AINA, user_id: 101, session_sid: 's3', logged_in_at: '2026-10-14T06:00:00.000Z', logged_out_at: '2026-10-14T13:30:00.000Z' },
  { id: 4, company_id: CO, staff_id: AINA, user_id: 101, session_sid: 's4', logged_in_at: '2026-10-15T01:00:00.000Z', logged_out_at: null },
  { id: 5, company_id: CO, staff_id: AINA, user_id: 101, session_sid: 's5', logged_in_at: '2026-10-16T01:00:00.000Z', logged_out_at: null },
  { id: 6, company_id: CO, staff_id: BEN, user_id: 102, session_sid: 's6', logged_in_at: '2026-10-14T01:00:00.000Z', logged_out_at: null },
];

function world() {
  const sb = fakeSb({
    accounts: [
      acct('900-0000', 'Operating Expense', 'EXPENSE'),
      acct('900-A001', 'PART-TIME WAGES', 'EXPENSE', { parent_code: '900-0000' }),
      acct('310-0010', 'CASH AT BANK - PBB', 'ASSET', { acc_money: true }),
    ],
    suppliers: [],
    companies: [{ id: CO, code: 'HC' }],
    acc_account_roles: [],
    staff: [
      { id: AINA, name: 'Aina', staff_code: 'PT01', user_id: 101, active: true },
      { id: BEN, name: 'Ben', staff_code: 'PT02', user_id: 102, active: true },
      { id: CHOO, name: 'Choo', staff_code: 'PT03', user_id: 103, active: true },
    ],
    hr_commission_config: [{ id: 1, company_id: CO, base_bps: 100, part_time_commission_bps: 200, part_time_day_rate_sen: 12000, part_time_wifi_sen: 2000 }],
    pos_logins: LOGINS.map((r) => ({ ...r })),
    mfg_sales_orders: [
      so('SO-1', AINA, '2026-10-13', 300_000),
      so('SO-2', AINA, '2026-10-14', 200_000),
      so('SO-3', AINA, '2026-10-14', 999_999, { status: 'DRAFT' }),
      so('SO-4', AINA, '2026-10-14', 777_777, { on_hold: true }),
      so('SO-5', AINA, '2026-10-21', 555_555, { project_id: 349 }),
      so('SO-6', CHOO, '2026-10-15', 100_000),
    ],
    hr_part_time_pay: [],
    acc_payment_requests: [],
    acc_payment_request_files: [],
    acc_pv_files: [],
    payment_vouchers: [],
    payment_voucher_lines: [],
    pv_allocations: [],
    ap_invoices: [],
    journal_entries: [],
    journal_entry_lines: [],
    acc_bank_statement_matches: [],
    acc_bank_statement_lines: [],
    entity_audit_log: [],
    acc_vendor_memory: [],
  });
  sb.rpcHandlers.entity_audit_writable = () => true;
  return { sb, r2: fakeR2() };
}

function as(w: ReturnType<typeof world>, who: { id: number; name: string; perms: string[] }) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, w.sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: who.id, name: who.name, permissions_set: new Set(who.perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    await next();
  });
  app.route('/hr/part-time-pay', partTimePay);
  app.route('/payment-requests', paymentRequests);
  app.route('/payment-vouchers', paymentVouchers);
  return async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: fakeDb, SLIPS: w.r2, ANTHROPIC_API_KEY: 'k' });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, contentType: ct, body: ct.includes('json') ? await res.json() as Row : {} as Row };
  };
}

const RATES = { commissionBps: 200, dayRateSen: 12_000, wifiSen: 2_000 };
const PERIOD = { startDate: '2026-10-13', endDate: '2026-10-15' };

describe('the rules', () => {
  test('days are Malaysian calendar days with a login inside the period; the first login is the arrival; a sale alone counts a day', () => {
    const days = workDays(
      LOGINS.filter((l) => l.staff_id === AINA).map((l) => ({ at: String(l.logged_in_at), outAt: l.logged_out_at ? String(l.logged_out_at) : null })),
      ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-21'],
      PERIOD,
    );
    expect(days.map((d) => d.date)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
    expect(days[0]).toMatchObject({ firstLoginAt: '2026-10-12T23:30:00.000Z', lastLogoutAt: '2026-10-13T14:00:00.000Z', logins: 1, orders: 1 });
    expect(days[1]).toMatchObject({ firstLoginAt: '2026-10-14T01:05:00.000Z', lastLogoutAt: '2026-10-14T13:30:00.000Z', logins: 2, orders: 1 });
    /* A day sold on without a login that day. */
    const soldOnly = workDays([], ['2026-10-14'], PERIOD);
    expect(soldOnly).toEqual([{ date: '2026-10-14', firstLoginAt: null, lastLogoutAt: null, logins: 0, orders: 1 }]);
    /* An open-ended event runs on; an undated one takes everything. */
    expect(workDays([{ at: '2026-10-30T01:00:00.000Z', outAt: null }], [], { startDate: '2026-10-13', endDate: null })).toHaveLength(1);
    expect(workDays([{ at: '2026-10-30T01:00:00.000Z', outAt: null }], [], { startDate: null, endDate: null })).toHaveLength(1);
  });

  test('2% of sales, nothing on zero sales; RM 120 a day; the WiFi allowance when ticked', () => {
    expect(partTimeAmounts({ days: 3, salesSen: 500_000, wifi: true, rates: RATES })).toEqual({ commissionSen: 10_000, salarySen: 36_000, wifiSen: 2_000, totalSen: 48_000 });
    expect(partTimeAmounts({ days: 1, salesSen: 0, wifi: false, rates: RATES })).toEqual({ commissionSen: 0, salarySen: 12_000, wifiSen: 0, totalSen: 12_000 });
    expect(partTimeAmounts({ days: 0, salesSen: -5, wifi: false, rates: RATES }).totalSen).toBe(0);
    /* Half a sen rounds up. */
    expect(partTimeAmounts({ days: 0, salesSen: 125, wifi: false, rates: RATES }).commissionSen).toBe(3);
  });

  test('the purpose carries the event title and dates; the breakdown says how the total came about', () => {
    expect(partTimePurpose({ name: 'Kuala Lumpur [ZANOTTI] REX @ MITEC', startDate: '2026-10-13', endDate: '2026-10-15' })).toBe('Part-time sales — Kuala Lumpur [ZANOTTI] REX @ MITEC (2026-10-13 to 2026-10-15)');
    expect(partTimePurpose({ name: 'One day', startDate: '2026-10-13', endDate: '2026-10-13' })).toBe('Part-time sales — One day (2026-10-13)');
    expect(partTimeBreakdown({ days: 3, dayRateSen: 12_000, salesSen: 500_000, commissionBps: 200, commissionSen: 10_000, wifiSen: 2_000, totalSen: 48_000 }))
      .toBe('3 days × RM 120.00 = RM 360.00; sales RM 5,000.00 × 2% = RM 100.00; WiFi RM 20.00. Total RM 480.00.');
    expect(partTimeBreakdown({ days: 1, dayRateSen: 12_000, salesSen: 0, commissionBps: 200, commissionSen: 0, wifiSen: 0, totalSen: 12_000 }))
      .toBe('1 day × RM 120.00 = RM 120.00; no sales, no commission. Total RM 120.00.');
  });
});

const AINA_ROW = { staffId: AINA, days: 3, wifi: true, bankName: 'Maybank', bankAccountNo: '1234567890', bankAccountName: 'AINA BINTI AHMAD', note: null };
const BEN_ROW = { staffId: BEN, days: 1, wifi: false, bankName: 'CIMB', bankAccountNo: '7001234567', bankAccountName: 'BEN TAN', note: 'Came for the weekend' };

describe('the sheet', () => {
  test('lists everyone who logged in or sold at the event, with their days, arrival times and sales; the other event and the draft, held orders stay out', async () => {
    const w = world();
    const r = await as(w, OWNER)('/hr/part-time-pay?projectId=348');
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({ id: 348, name: 'Kuala Lumpur [ZANOTTI] REX @ MITEC' });
    expect(r.body.rates).toEqual(RATES);
    expect(r.body.purpose).toBe('Part-time sales — Kuala Lumpur [ZANOTTI] REX @ MITEC (2026-10-13 to 2026-10-15)');
    expect(r.body).toMatchObject({ canRequest: true, canConfirm: false });
    const byName = Object.fromEntries((r.body.lines as Row[]).map((l) => [l.staffName, l]));
    expect(Object.keys(byName).sort()).toEqual(['Aina', 'Ben', 'Choo']);
    expect(byName.Aina).toMatchObject({ suggestedDays: 3, salesSen: 500_000, orderCount: 2, saved: null, salesChanged: false });
    expect(byName.Aina.days[0]).toMatchObject({ date: '2026-10-13', firstLoginAt: '2026-10-12T23:30:00.000Z' });
    expect(byName.Ben).toMatchObject({ suggestedDays: 1, salesSen: 0, orderCount: 0 });
    expect(byName.Choo).toMatchObject({ suggestedDays: 1, salesSen: 100_000, orderCount: 1 });
    expect(byName.Choo.days[0]).toMatchObject({ date: '2026-10-15', firstLoginAt: null, orders: 1 });
    /* HR reads it too; a stranger does not; an event of another company is not there. */
    expect((await as(w, HR)('/hr/part-time-pay?projectId=348')).body).toMatchObject({ canRequest: false, canConfirm: true });
    expect((await as(w, NOBODY)('/hr/part-time-pay?projectId=348')).status).toBe(403);
    expect((await as(w, OWNER)('/hr/part-time-pay?projectId=999')).status).toBe(404);
    expect((await as(w, OWNER)('/hr/part-time-pay?projectId=abc')).status).toBe(400);
  });

  test('the owner saves it priced from the rates; the WiFi allowance goes to one person; HR cannot key it', async () => {
    const w = world();
    const owner = as(w, OWNER);
    const saved = await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW, BEN_ROW] });
    expect(saved.status).toBe(200);
    const rows = w.sb.tables.hr_part_time_pay;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.staff_id === AINA)).toMatchObject({
      staff_name: 'Aina', days: 3, sales_sen: 500_000, commission_bps: 200, commission_sen: 10_000, day_rate_sen: 12_000, salary_sen: 36_000, wifi_sen: 2_000, total_sen: 48_000,
      bank_name: 'Maybank', bank_account_no: '1234567890', bank_account_name: 'AINA BINTI AHMAD', status: 'DRAFT', requested_by: 1, requested_by_name: 'Ummu', project_id: 348, company_id: CO,
    });
    expect(rows.find((r) => r.staff_id === BEN)).toMatchObject({ days: 1, sales_sen: 0, commission_sen: 0, salary_sen: 12_000, wifi_sen: 0, total_sen: 12_000, note: 'Came for the weekend' });
    /* Two WiFi ticks in one save, or a second holder saved on their own. */
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW, { ...BEN_ROW, wifi: true }] })).body.error).toBe('wifi_twice');
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [{ ...BEN_ROW, wifi: true }] })).body.error).toBe('wifi_twice');
    /* Bad days, a stranger, a second row for one person. */
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [{ ...AINA_ROW, days: 2.5 }] })).body.error).toBe('bad_days');
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [{ ...AINA_ROW, staffId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] })).body.error).toBe('staff_not_found');
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW, AINA_ROW] })).body.error).toBe('staff_twice');
    /* A re-save re-prices the row in place. */
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [{ ...AINA_ROW, days: 2 }] })).status).toBe(200);
    expect(w.sb.tables.hr_part_time_pay).toHaveLength(2);
    expect(w.sb.tables.hr_part_time_pay.find((r) => r.staff_id === AINA)).toMatchObject({ days: 2, salary_sen: 24_000, total_sen: 36_000 });
    /* The sheet reads the saved row back with its breakdown. */
    const sheet = await owner('/hr/part-time-pay?projectId=348');
    const aina = (sheet.body.lines as Row[]).find((l) => l.staffName === 'Aina')!;
    expect(aina.saved).toMatchObject({ status: 'DRAFT', total_sen: 36_000, breakdown: '2 days × RM 120.00 = RM 240.00; sales RM 5,000.00 × 2% = RM 100.00; WiFi RM 20.00. Total RM 360.00.', answer: null });
    /* HR keys nothing. */
    expect((await as(w, HR)('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW] })).status).toBe(403);
  });

  test('HR confirms a row: the payment request is raised with the event as its purpose and the breakdown as its note; the row locks', async () => {
    const w = world();
    const owner = as(w, OWNER);
    const hr = as(w, HR);
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW, BEN_ROW] })).status).toBe(200);
    const ainaId = String(w.sb.tables.hr_part_time_pay.find((r) => r.staff_id === AINA)!.id);
    const benId = String(w.sb.tables.hr_part_time_pay.find((r) => r.staff_id === BEN)!.id);
    /* The owner cannot confirm their own sheet. */
    expect((await owner(`/hr/part-time-pay/${ainaId}/confirm`, 'POST')).status).toBe(403);
    const ok = await hr(`/hr/part-time-pay/${ainaId}/confirm`, 'POST');
    expect(ok.status).toBe(201);
    expect(ok.body.request.requestNo).toMatch(/^HC-PRQ-\d{4}-\d{3}$/);
    const req = w.sb.tables.acc_payment_requests[0];
    expect(req).toMatchObject({
      status: 'SUBMITTED', payee_name: 'AINA BINTI AHMAD', amount_sen: 48_000, project_id: 348, requested_by: 1, requested_by_name: 'Ummu',
      bank_name: 'Maybank', bank_account_no: '1234567890', bank_account_name: 'AINA BINTI AHMAD', part_time_pay_id: ainaId, event_bill: false,
      purpose: 'Part-time sales — Kuala Lumpur [ZANOTTI] REX @ MITEC (2026-10-13 to 2026-10-15)',
      note: '3 days × RM 120.00 = RM 360.00; sales RM 5,000.00 × 2% = RM 100.00; WiFi RM 20.00. Total RM 480.00.',
    });
    expect(w.sb.tables.hr_part_time_pay.find((r) => r.id === ainaId)).toMatchObject({ status: 'CONFIRMED', request_id: req.id, confirmed_by: 'Mei Ling' });
    const audit = w.sb.tables.entity_audit_log.find((a) => a.entity_type === 'PAYMENT_REQUEST' && a.action === 'CREATE');
    expect(JSON.stringify(audit)).toContain('partTimePayId');
    /* Confirmed is confirmed: not again, not changed, not removed. */
    expect((await hr(`/hr/part-time-pay/${ainaId}/confirm`, 'POST')).body.error).toBe('already_confirmed');
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [{ ...AINA_ROW, days: 1 }] })).body.error).toBe('row_confirmed');
    expect((await owner(`/hr/part-time-pay/${ainaId}`, 'DELETE')).body.error).toBe('row_confirmed');
    /* The requester's own list carries it; Finance sees it waiting. */
    const mine = await owner('/payment-requests');
    expect(mine.status).toBe(200);
    expect((mine.body.requests as Row[]).map((r) => r.part_time_pay_id)).toEqual([ainaId]);
    /* Ben's note rides behind the breakdown; a draft row the owner removes is gone. */
    expect((await hr(`/hr/part-time-pay/${benId}/confirm`, 'POST')).status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[1].note).toBe('1 day × RM 120.00 = RM 120.00; no sales, no commission. Total RM 120.00. Came for the weekend');
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [{ staffId: CHOO, days: 0, wifi: false, bankName: null, bankAccountNo: null, bankAccountName: null, note: null }] })).status).toBe(200);
    const chooId = String(w.sb.tables.hr_part_time_pay.find((r) => r.staff_id === CHOO)!.id);
    /* Choo sold RM 1,000 with no days: 2% stands, the day pay is zero. */
    expect(w.sb.tables.hr_part_time_pay.find((r) => r.id === chooId)).toMatchObject({ days: 0, sales_sen: 100_000, commission_sen: 2_000, total_sen: 2_000 });
    expect((await owner(`/hr/part-time-pay/${chooId}`, 'DELETE')).status).toBe(200);
    expect(w.sb.tables.hr_part_time_pay.find((r) => r.id === chooId)).toBeUndefined();
    expect((await hr(`/hr/part-time-pay/${chooId}`, 'DELETE')).status).toBe(403);
  });

  test('nothing to pay is not sent; sales that moved since the save stop the confirm until the owner saves again', async () => {
    const w = world();
    const owner = as(w, OWNER);
    const hr = as(w, HR);
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW, { ...BEN_ROW, days: 0 }] })).status).toBe(200);
    const ainaId = String(w.sb.tables.hr_part_time_pay.find((r) => r.staff_id === AINA)!.id);
    const benId = String(w.sb.tables.hr_part_time_pay.find((r) => r.staff_id === BEN)!.id);
    expect((await hr(`/hr/part-time-pay/${benId}/confirm`, 'POST')).body.error).toBe('nothing_to_pay');
    /* A sale lands after the save. */
    w.sb.tables.mfg_sales_orders.push(so('SO-7', AINA, '2026-10-15', 50_000));
    const sheet = await hr('/hr/part-time-pay?projectId=348');
    expect((sheet.body.lines as Row[]).find((l) => l.staffName === 'Aina')).toMatchObject({ salesSen: 550_000, salesChanged: true });
    const stale = await hr(`/hr/part-time-pay/${ainaId}/confirm`, 'POST');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('sales_changed');
    expect(w.sb.tables.acc_payment_requests).toHaveLength(0);
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW] })).status).toBe(200);
    expect(w.sb.tables.hr_part_time_pay.find((r) => r.id === ainaId)).toMatchObject({ sales_sen: 550_000, commission_sen: 11_000, total_sen: 49_000 });
    expect((await hr(`/hr/part-time-pay/${ainaId}/confirm`, 'POST')).status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0].amount_sen).toBe(49_000);
  });

  test('Finance pays it with a voucher — no bill needed — and the bank slip on that voucher reads back on the sheet', async () => {
    const w = world();
    const owner = as(w, OWNER);
    const hr = as(w, HR);
    const fin = as(w, FINANCE);
    expect((await owner('/hr/part-time-pay', 'PUT', { projectId: 348, rows: [AINA_ROW] })).status).toBe(200);
    const ainaId = String(w.sb.tables.hr_part_time_pay[0].id);
    expect((await hr(`/hr/part-time-pay/${ainaId}/confirm`, 'POST')).status).toBe(201);
    const reqId = String(w.sb.tables.acc_payment_requests[0].id);
    const pv = await fin('/payment-vouchers', 'POST', {
      payeeName: 'AINA BINTI AHMAD', creditAccountCode: '310-0010', voucherDate: '2026-10-16', purpose: 'OTHER', paymentRequestId: reqId,
      lines: [{ debitAccountCode: '900-A001', description: 'Part-time sales — ZANOTTI REX', amountSen: 48_000, projectId: 348 }],
    });
    expect(pv.status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ status: 'VOUCHERED', pv_id: pv.body.id });
    const slip = await fin(`/payment-vouchers/${pv.body.id}/files`, 'POST', { fileName: 'bank-slip.pdf', mime: 'application/pdf', dataBase64: btoa('%PDF-1.4 slip') });
    expect(slip.status).toBe(201);
    /* HR and the owner read the stage and the slip off the sheet. */
    for (const who of [hr, owner]) {
      const sheet = await who('/hr/part-time-pay?projectId=348');
      const aina = (sheet.body.lines as Row[]).find((l) => l.staffName === 'Aina')!;
      expect(aina.saved.answer).toMatchObject({ requestNo: w.sb.tables.acc_payment_requests[0].request_no, stage: 'PROCESSING' });
      expect(aina.saved.answer.slips).toHaveLength(1);
      expect(aina.saved.answer.slips[0]).toMatchObject({ fileName: 'bank-slip.pdf', mime: 'application/pdf' });
      const file = await who(`/hr/part-time-pay/${ainaId}/slip/${aina.saved.answer.slips[0].id}`);
      expect(file.status).toBe(200);
      expect(file.contentType).toBe('application/pdf');
    }
    /* A stranger reads no slip; a wrong file is not found. */
    const fileId = String(w.sb.tables.acc_pv_files[0].id);
    expect((await as(w, NOBODY)(`/hr/part-time-pay/${ainaId}/slip/${fileId}`)).status).toBe(403);
    expect((await hr(`/hr/part-time-pay/${ainaId}/slip/nope`)).status).toBe(404);
  });
});
