/* GET /accounting/so-backlog-cover (owner 2026-11-24: 「根据 processing date，而不是
   几时放 processing date」; backlog = 「以前还没有 process 的单」; the second rate on
   「本月 process 的总额」; the average 「default 从系统，我也可以自己根据情况放」) on
   the real handler over fake PostgREST. Pinned: the financial statements' key
   answers at this end; a bad month or average start is refused; only the active
   company's live orders and DOs are read; an order counts in its Processing
   Date's month, or on its first shipped DO when it has none; the backlog at the
   1st, the two cover rates by amount and by order count (「这个average要by amount
   和by quantities」) and their averages from the company's first month with a
   backlog, or from the month the reader picks. Amounts are made up. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { averageFrom, soBacklogCoverHandler } from '../src/scm/routes/accounting-so-backlog-cover';
import { buildSoBacklogCover, pctOf, type ScOrder } from '../src/acc/so-backlog-cover';

const CO = 2;
const PERM = 'scm.payment_voucher.post';
const order = (doc: string, soDate: string, pdate: string | null, sen: number, extra: Partial<Row> = {}): Row => ({
  company_id: CO, doc_no: doc, so_date: soDate, processing_date: pdate, local_total_sen: sen,
  debtor_name: `Customer ${doc}`, linked_ac_docno: null, status: 'CONFIRMED', ...extra,
});
let seq = 0;
const dOrder = (so: string, date: string, status: string, co = CO): Row => {
  seq += 1;
  return { id: `do-${seq}`, company_id: co, so_doc_no: so, do_date: date, status };
};

function harness(perms: readonly string[] = [PERM]) {
  seq = 0;
  const sb = fakeSb({
    mfg_sales_orders: [
      order('SO-A', '2026-09-05', '2026-09-05', 100_000),
      order('SO-B', '2026-09-10', null, 200_000),
      order('SO-C', '2026-09-20', '2026-10-15', 300_000),
      order('SO-D', '2026-10-02', '2026-10-02', 400_000),
      order('SO-E', '2026-10-20', '2026-11-03', 500_000),
      order('SO-F', '2026-11-04', '2026-11-04', 600_000),
      // Brought over at the cutover ("HC-" + the book's number) with no Processing Date.
      order('HC-SO-000777', '2026-03-14', null, 700_000, { linked_ac_docno: 'SO-000777' }),
      order('HC-SO-000888', '2026-05-01', null, 800_000, { linked_ac_docno: 'SO-000888' }),
      order('SO-G', '2026-11-05', '2026-11-05', 9_990_000, { status: 'DRAFT' }),
      order('SO-H', '2026-10-05', '2026-11-06', 9_990_000, { status: 'CANCELLED' }),
      // Company 1 reuses the number SO-C.
      order('SO-C', '2026-10-01', '2026-11-01', 9_990_000, { company_id: 1 }),
    ],
    delivery_orders: [
      dOrder('HC-SO-000777', '2026-10-01', 'DRAFT'),
      dOrder('HC-SO-000777', '2026-11-08', 'DELIVERED'),
      dOrder('HC-SO-000777', '2026-11-20', 'LOADED'),
      dOrder('HC-SO-000888', '2026-11-02', 'DELIVERED', 1),
    ],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/so-backlog-cover', soBacklogCoverHandler as never);
  return app;
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/so-backlog-cover?${qs}`);
  return { status: res.status, body: await res.json() as any };
};

describe('GET /accounting/so-backlog-cover', () => {
  test('the financial statements key answers at this end', async () => {
    expect((await read(harness([]), 'month=2026-11')).status).toBe(403);
  });

  test('a bad month or average start is refused by name', async () => {
    expect((await read(harness(), 'month=2026-13')).body.error).toBe('bad_month');
    const bad = await read(harness(), 'month=2026-11&avgFrom=2026-1');
    expect([bad.status, bad.body.error]).toEqual([400, 'bad_average_from']);
    expect((await read(harness(), 'month=2026-11&avgFrom=2026-12')).body.error).toBe('bad_average_from');
  });

  test("the month's orders by Processing Date, or by the first shipped DO when there is none", async () => {
    const r = await read(harness(), 'month=2026-11');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ month: '2026-11', from: '2026-11-01', to: '2026-11-30' });
    expect(r.body.rows.map((x: any) => [x.docNo, x.soDate, x.processedOn, x.dateFrom, x.part, x.imported, x.amountSen])).toEqual([
      ['SO-E', '2026-10-20', '2026-11-03', 'processing_date', 'backlog', false, 500_000],
      ['SO-F', '2026-11-04', '2026-11-04', 'processing_date', 'this_month', false, 600_000],
      ['HC-SO-000777', '2026-03-14', '2026-11-08', 'first_do', 'backlog', true, 700_000],
    ]);
    expect(r.body.rows[0].customer).toBe('Customer SO-E');
    expect(r.body.total).toEqual({ orders: 3, amountSen: 1_800_000 });
    expect(r.body.parts).toEqual({
      this_month: { orders: 1, amountSen: 600_000, pct: 33.3 },
      backlog: { orders: 2, amountSen: 1_200_000, pct: 66.7 },
    });
  });

  test('the backlog at the 1st, the two cover rates by amount and by orders, and their averages from the first month with a backlog', async () => {
    const r = await read(harness(), 'month=2026-11');
    // Not processed by 1 Nov: SO-B and HC-SO-000888 have no date at all, SO-E and HC-SO-000777 count later.
    expect(r.body.backlog).toEqual({ orders: 4, amountSen: 2_200_000 });
    expect(r.body.cover).toEqual({ amount: { onBacklog: 54.5, onMonth: 66.7 }, orders: { onBacklog: 50, onMonth: 66.7 } });
    expect(r.body.defaultFrom).toBe('2026-09');
    expect(r.body.months.map((m: any) => [m.month, m.backlog, m.backlogProcessed, m.processed])).toEqual([
      ['2026-09', { orders: 2, amountSen: 1_500_000 }, { orders: 0, amountSen: 0 }, { orders: 1, amountSen: 100_000 }],
      ['2026-10', { orders: 4, amountSen: 2_000_000 }, { orders: 1, amountSen: 300_000 }, { orders: 2, amountSen: 700_000 }],
      ['2026-11', { orders: 4, amountSen: 2_200_000 }, { orders: 2, amountSen: 1_200_000 }, { orders: 3, amountSen: 1_800_000 }],
    ]);
    expect(r.body.months.map((m: any) => [m.month, m.amount.onBacklog, m.amount.onMonth, m.orders.onBacklog, m.orders.onMonth])).toEqual([
      ['2026-09', 0, 0, 0, 0],
      ['2026-10', 15, 42.9, 25, 50],
      ['2026-11', 54.5, 66.7, 50, 66.7],
    ]);
    expect(r.body.average).toEqual({
      from: '2026-09', to: '2026-11',
      amount: { onBacklog: 23.2, onMonth: 36.5 },
      orders: { onBacklog: 25, onMonth: 38.9 },
    });
  });

  test('the reader picks where the average starts', async () => {
    const r = await read(harness(), 'month=2026-11&avgFrom=2026-10');
    expect(r.body.months.map((m: any) => m.month)).toEqual(['2026-10', '2026-11']);
    expect(r.body.average).toEqual({
      from: '2026-10', to: '2026-11',
      amount: { onBacklog: 34.8, onMonth: 54.8 },
      orders: { onBacklog: 37.5, onMonth: 58.4 },
    });
    expect(r.body.defaultFrom).toBe('2026-09');
  });

  test('a month with nothing processed has no share to give', async () => {
    const r = await read(harness(), 'month=2026-08');
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([]);
    expect(r.body.total).toEqual({ orders: 0, amountSen: 0 });
    expect(r.body.parts.this_month.pct).toBeNull();
    expect(r.body.cover).toEqual({ amount: { onBacklog: 0, onMonth: null }, orders: { onBacklog: 0, onMonth: null } });
  });
});

describe('averageFrom', () => {
  test('absent is the default; a month at most ten years before the report month', () => {
    expect(averageFrom(undefined, '2026-11')).toEqual({ ok: true, from: null });
    expect(averageFrom(' 2026-09 ', '2026-11')).toEqual({ ok: true, from: '2026-09' });
    expect(averageFrom('2016-11', '2026-11')).toMatchObject({ ok: false, error: 'too_long' });
  });
});

describe('buildSoBacklogCover', () => {
  const o = (doc: string, soDate: string, pdate: string | null, sen: number): ScOrder => ({
    doc_no: doc, so_date: soDate, processing_date: pdate, local_total_sen: sen, debtor_name: null, linked_ac_docno: null,
  });

  test("the default start skips a first month that had nothing waiting", () => {
    const out = buildSoBacklogCover({
      month: '2026-08', avgFrom: null, firstDo: new Map(),
      orders: [o('A', '2026-06-11', '2026-06-11', 10_000), o('B', '2026-06-20', '2026-07-02', 20_000), o('C', '2026-07-05', '2026-08-01', 30_000)],
    });
    expect(out.defaultFrom).toBe('2026-07');
    expect(out.months.map((m) => [m.month, m.amount.onBacklog, m.amount.onMonth])).toEqual([['2026-07', 100, 100], ['2026-08', 100, 100]]);
  });

  test('a start the reader picks before any backlog leaves that month out of the backlog rate only', () => {
    const out = buildSoBacklogCover({
      month: '2026-07', avgFrom: '2026-06', firstDo: new Map(),
      orders: [o('A', '2026-06-11', '2026-06-11', 10_000), o('B', '2026-06-20', '2026-07-02', 20_000), o('C', '2026-07-05', '2026-07-06', 20_000)],
    });
    expect(out.months.map((m) => [m.month, m.amount.onBacklog, m.amount.onMonth])).toEqual([['2026-06', null, 0], ['2026-07', 100, 50]]);
    expect(out.average.amount).toEqual({ onBacklog: 100, onMonth: 25 });
    expect(out.average.orders).toEqual({ onBacklog: 100, onMonth: 25 });
  });

  test('by orders counts each order once, whatever its amount', () => {
    /* One big backlog order of three is processed: a third of the orders, most of the amount. */
    const out = buildSoBacklogCover({
      month: '2026-11', avgFrom: null, firstDo: new Map(),
      orders: [
        o('BIG', '2026-10-02', '2026-11-03', 900_000), o('S1', '2026-10-05', null, 50_000), o('S2', '2026-10-06', null, 50_000),
        o('NEW', '2026-11-04', '2026-11-04', 100_000),
      ],
    });
    expect(out.cover.amount).toEqual({ onBacklog: 90, onMonth: 90 });
    expect(out.cover.orders).toEqual({ onBacklog: 33.3, onMonth: 50 });
  });

  test("the two parts' shares add up to 100.0, the rounding left over going to the larger", () => {
    /* 6.25% and 93.75% round to 6.3 and 93.8, 100.1 in all; the larger part gives back the 0.1. */
    const out = buildSoBacklogCover({
      month: '2026-11', avgFrom: null, firstDo: new Map(),
      orders: [o('NOW', '2026-11-02', '2026-11-03', 100), o('OLD', '2026-10-02', '2026-11-03', 1_500)],
    });
    expect([out.parts.this_month.pct, out.parts.backlog.pct]).toEqual([6.3, 93.7]);
  });

  test('a rate is one decimal of its whole', () => {
    expect(pctOf(1, 3)).toBe(33.3);
    expect(pctOf(0, 5)).toBe(0);
    expect(pctOf(1, 0)).toBeNull();
  });
});
