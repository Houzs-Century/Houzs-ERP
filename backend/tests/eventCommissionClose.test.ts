/* Event Commission — closing a month (owner 2026-10-26, 关月, Finance). Pinned
   through the handlers over the fake-PostgREST harness:
     • a closed month asked for whole is served as it was closed — the stored
       report, who closed it and when — and nothing is recalculated;
     • months close in order, once each has ended, and once only;
     • only the latest closed month reopens, and the reopening is recorded.
   The rules that turn a closed month into the next month's adjustments are the
   lib's (scm/lib/event-commission.test.ts, "closing a month"). */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  closeCommissionMonthHandler, eventCommissionHandler, reopenCommissionMonthHandler,
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
    expect(res.body.message).toBe('Months close in order — close October 2026 first.');
  });
});

describe('only the latest closed month reopens', () => {
  test('an earlier one is refused; the latest goes, and the reopening is recorded', async () => {
    const tables = { event_commission_closes: [closed('2026-09'), closed('2026-10')], entity_audit_log: [] as Row[] };
    const sb = fakeSb(tables);
    const early = await run(reopenCommissionMonthHandler, ctx(sb, { body: { month: '2026-09' } }));
    expect([early.status, early.body.error, early.body.message]).toEqual([409, 'not_latest', 'Only the latest closed month can be reopened — October 2026.']);
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
