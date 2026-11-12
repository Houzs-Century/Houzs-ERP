/* Event Commission — closing a month (owner 2026-10-26, 关月, Finance). Pinned
   through the handlers over the fake-PostgREST harness:
     • a closed month asked for whole is served as it was closed — the stored
       report, who closed it and when — and nothing is recalculated;
     • months close in order, once each has ended, and once only;
     • only the latest closed month reopens, and the reopening is recorded.
   The rules that turn a closed month into the next month's adjustments are the
   lib's (scm/lib/event-commission.test.ts, "closing a month").
   Finance's two buttons (owner 2026-11-12): marking an order "not counted" or
   "next month", and taking the mark away — each written to the order's History. */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  closeCommissionMonthHandler, eventCommissionHandler, markCommissionOrderHandler, reopenCommissionMonthHandler, unmarkCommissionOrderHandler,
} from '../src/scm/routes/acc-event-commission';

const CO = 1;
const FROZEN = { basis: 'fair', from: '2026-09-01', to: '2026-09-30', fairs: [], adjustments: [], earlierOrders: [], changedOrders: [], monthAdjustments: [], totals: { payableSen: 2_346_718_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, totalSen: 2_346_718_00 } };
const closed = (month: string, o: Partial<Row> = {}): Row => ({
  id: `close-${month}`, company_id: CO, month: `${month}-01`, closed_at: '2026-10-26T09:00:00Z', closed_by: 'Finance',
  paid: { fair: {}, so_date: {} }, carried: { fair: [], so_date: [] },
  report_fair: { ...FROZEN, from: `${month}-01` }, report_so_date: { ...FROZEN, basis: 'so_date', from: `${month}-01` }, ...o,
});
type Res = { body: Record<string, any>; status: number };
const ctx = (sb: unknown, { query = {}, body = {} }: { query?: Record<string, string>; body?: unknown } = {}) => ({
  env: {},
  req: { query: (k: string) => query[k], json: async () => body, path: '/api/scm/acc-events/commission' },
  get: (k: string) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: 7, name: 'Finance Chew', email: 'f@houzs' } : undefined),
  json: (b: Record<string, any>, status = 200): Res => ({ body: b, status }),
});
const run = async (h: (c: any) => Promise<unknown>, c: unknown) => (await h(c)) as unknown as Res;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T04:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('a closed month is served as it was closed', () => {
  test('the stored report, who closed it and when; the closed months and the first open one', async () => {
    const sb = fakeSb({ event_commission_closes: [closed('2026-09')], entity_audit_log: [] });
    const res = await run(eventCommissionHandler, ctx(sb, { query: { from: '2026-09-01', to: '2026-09-30' } }));
    expect(res.status).toBe(200);
    expect(res.body.totals.totalSen).toBe(2_346_718_00);
    expect(res.body.closed).toEqual({ month: '2026-09', closedAt: '2026-10-26T09:00:00Z', closedBy: 'Finance' });
    expect(res.body.closes).toEqual({ months: ['2026-09'], openFrom: '2026-10' });
    const bySo = await run(eventCommissionHandler, ctx(sb, { query: { from: '2026-09-01', to: '2026-09-30', basis: 'so_date' } }));
    expect(bySo.body.basis).toBe('so_date');
  });

  test("another company's close is not this company's", async () => {
    const sb = fakeSb({ event_commission_closes: [closed('2026-09', { company_id: 2 })], entity_audit_log: [] });
    const res = await run(closeCommissionMonthHandler, ctx(sb, { body: { month: '2026-11' } }));
    expect(res.body.error).toBe('not_ended'); // no close of its own: November is next in line, and it has not ended
  });
});

describe('months close in order, once each has ended, once only', () => {
  const sb = () => fakeSb({ event_commission_closes: [closed('2026-09')], entity_audit_log: [] });
  test.each([
    ['2026-13', 400, 'bad_month'],
    ['2026-09', 409, 'already_closed'],
    ['2026-11', 409, 'out_of_order'],
    ['2026-10', 409, 'not_ended'],
  ])('%s → %s %s', async (month, status, error) => {
    const res = await run(closeCommissionMonthHandler, ctx(sb(), { body: { month } }));
    expect([res.status, res.body.error]).toEqual([status, error]);
  });

  test('the refusals name the month to close first', async () => {
    const res = await run(closeCommissionMonthHandler, ctx(sb(), { body: { month: '2026-11' } }));
    expect(res.body.message).toBe('Months close in order — close 2026/10 first.');
  });
});

describe('only the latest closed month reopens', () => {
  test('an earlier one is refused; the latest goes, and the reopening is recorded', async () => {
    const tables = { event_commission_closes: [closed('2026-09'), closed('2026-10')], entity_audit_log: [] as Row[] };
    const sb = fakeSb(tables);
    const early = await run(reopenCommissionMonthHandler, ctx(sb, { body: { month: '2026-09' } }));
    expect([early.status, early.body.error, early.body.message]).toEqual([409, 'not_latest', 'Only the latest closed month can be reopened — 2026/10.']);
    const res = await run(reopenCommissionMonthHandler, ctx(sb, { body: { month: '2026-10' } }));
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.closes).toEqual({ months: ['2026-09'], openFrom: '2026-10' });
    expect((sb as any).tables.event_commission_closes.map((r: Row) => r.month)).toEqual(['2026-09-01']);
    expect((sb as any).tables.entity_audit_log).toEqual([expect.objectContaining({
      entity_type: 'COMMISSION_MONTH', entity_id: '1:2026-10', action: 'REVERSE', actor_name_snapshot: 'Finance Chew',
    })]);
  });

  test('nothing closed, nothing to reopen', async () => {
    const res = await run(reopenCommissionMonthHandler, ctx(fakeSb({ event_commission_closes: [], entity_audit_log: [] }), { body: { month: '2026-09' } }));
    expect([res.status, res.body.error]).toEqual([409, 'nothing_closed']);
  });
});

describe("Finance's two buttons — 这张单不要算 / 这个算下个月 (owner 2026-11-12)", () => {
  const MARK_ID = '3f0c1d7e-2b1a-4c5d-9e8f-0a1b2c3d4e5f';
  const tables = (marks: Row[] = []) => ({
    event_commission_closes: [closed('2026-09')],
    event_commission_marks: marks,
    mfg_sales_orders: [{ doc_no: 'HC-SO-2610-001', company_id: CO }, { doc_no: 'HC-SO-2610-099', company_id: 2 }],
    mfg_so_audit_log: [] as Row[],
    entity_audit_log: [] as Row[],
  });
  const excludeOnce = [{ table: 'event_commission_marks', column: 'so_doc_no', covers: (r: Row) => r.kind === 'exclude', name: 'event_commission_marks_exclude_uq' }];

  test("「这张单不要算」: the mark keeps who and why, the order's History says so, and twice is refused", async () => {
    const t = tables();
    const sb = fakeSb(t, {}, excludeOnce);
    const res = await run(markCommissionOrderHandler, ctx(sb, { body: { docNo: 'hc-so-2610-001', kind: 'exclude', reason: 'checking the price' } }));
    expect(res.status).toBe(200);
    expect(res.body.mark).toMatchObject({ docNo: 'HC-SO-2610-001', kind: 'exclude', month: null, reason: 'checking the price', markedBy: 'Finance Chew' });
    expect(t.mfg_so_audit_log).toEqual([expect.objectContaining({
      so_doc_no: 'HC-SO-2610-001', action: 'COMMISSION_MARK', actor_name_snapshot: 'Finance Chew', note: 'checking the price',
      field_changes: [{ field: 'eventCommission', from: 'Counted', to: 'Not counted' }],
    })]);
    const again = await run(markCommissionOrderHandler, ctx(sb, { body: { docNo: 'HC-SO-2610-001', kind: 'exclude' } }));
    expect([again.status, again.body.error]).toEqual([409, 'already_marked']);
  });

  test('「这个算下个月」 moves an open month only; a closed month is refused', async () => {
    const closedMonth = await run(markCommissionOrderHandler, ctx(fakeSb(tables()), { body: { docNo: 'HC-SO-2610-001', kind: 'defer', month: '2026-09' } }));
    expect([closedMonth.status, closedMonth.body.error, closedMonth.body.message])
      .toEqual([409, 'month_closed', "2026/09 is closed — only an open month's commission can move to the next month."]);
    const t = tables();
    const ok = await run(markCommissionOrderHandler, ctx(fakeSb(t), { body: { docNo: 'HC-SO-2610-001', kind: 'defer', month: '2026-10' } }));
    expect(ok.body.mark).toMatchObject({ kind: 'defer', month: '2026-10' });
    expect(t.mfg_so_audit_log[0]).toMatchObject({ field_changes: [{ field: 'eventCommission', from: 'Counted', to: 'Counted in 2026/11, not 2026/10' }] });
  });

  test.each([
    [{ docNo: '', kind: 'exclude' }, 400, 'bad_doc_no'],
    [{ docNo: 'HC-SO-2610-001', kind: 'maybe' }, 400, 'bad_kind'],
    [{ docNo: 'HC-SO-2610-001', kind: 'defer' }, 400, 'bad_month'],
    [{ docNo: 'HC-SO-2610-099', kind: 'exclude' }, 404, 'not_found'],
  ])('%j → %s %s', async (body, status, error) => {
    const res = await run(markCommissionOrderHandler, ctx(fakeSb(tables()), { body }));
    expect([res.status, res.body.error]).toEqual([status, error]);
  });

  test('Undo takes the mark away and says so in the History; a mark already gone is a 404', async () => {
    const t = tables([{
      id: MARK_ID, company_id: CO, so_doc_no: 'HC-SO-2610-001', kind: 'defer', month: '2026-10-01', reason: null, marked_by: 'Finance', marked_at: '2026-11-12T03:00:00Z',
    }]);
    const sb = fakeSb(t);
    const res = await run(unmarkCommissionOrderHandler, ctx(sb, { body: { id: MARK_ID } }));
    expect(res.body).toMatchObject({ ok: true, mark: { docNo: 'HC-SO-2610-001', kind: 'defer', month: '2026-10' } });
    expect((sb as any).tables.event_commission_marks).toEqual([]);
    expect(t.mfg_so_audit_log).toEqual([expect.objectContaining({
      action: 'COMMISSION_UNMARK', field_changes: [{ field: 'eventCommission', from: 'Counted in 2026/11, not 2026/10', to: 'Counted' }],
    })]);
    const gone = await run(unmarkCommissionOrderHandler, ctx(sb, { body: { id: MARK_ID } }));
    expect([gone.status, gone.body.error]).toEqual([404, 'not_found']);
    const bad = await run(unmarkCommissionOrderHandler, ctx(sb, { body: { id: 'row-1' } }));
    expect([bad.status, bad.body.error]).toEqual([400, 'bad_id']);
  });
});
