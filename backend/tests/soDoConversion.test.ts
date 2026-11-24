/* GET /accounting/so-do-conversion (owner 2026-11-24: 「这个月开的订单转化去do是多少，
   剩下的都算之前」, 「我要可以选月份，如果看到total amount，和percentage」) on the real
   handler over fake PostgREST. Pinned: the financial statements' key answers at
   this end; a bad month is refused; the month is the DO date's, the active
   company's DOs and orders only; a Draft or Cancelled DO is left out; each DO
   sits in one part by its order's SO date — this month, earlier (AutoCount
   imports included), or other — and each part's total and share of the month's
   DO total add up. Amounts are made up. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { soDoConversionHandler } from '../src/scm/routes/accounting-so-do-conversion';
import { buildSoDoConversion, shareOf } from '../src/acc/so-do-conversion';

const CO = 2;
const PERM = 'scm.payment_voucher.post';
let seq = 0;
const dOrder = (so: string | null, date: string, status: string, sen: number, co = CO): Row => {
  seq += 1;
  return {
    id: `do-${String(seq).padStart(3, '0')}`, company_id: co, do_number: `DO-${String(seq).padStart(3, '0')}`, do_date: date,
    so_doc_no: so, status, local_total_sen: sen, debtor_name: `Debtor ${seq}`,
  };
};
const order = (doc: string, date: string, co = CO, book: string | null = null): Row => ({
  company_id: co, doc_no: doc, so_date: date, debtor_name: `Customer ${doc}`, linked_ac_docno: book,
});

function harness(perms: readonly string[] = [PERM]) {
  seq = 0;
  const sb = fakeSb({
    delivery_orders: [
      dOrder('SO-NOV', '2026-11-03', 'LOADED', 100_000),
      dOrder('SO-NOV', '2026-11-20', 'DELIVERED', 50_000),
      dOrder('SO-OCT', '2026-11-05', 'DISPATCHED', 300_000),
      dOrder('HC-SO-000777', '2026-11-08', 'DELIVERED', 50_000),
      dOrder(null, '2026-11-09', 'DELIVERED', 0),
      dOrder('SO-NOV', '2026-11-10', 'DRAFT', 999_000),
      dOrder('SO-OCT', '2026-11-11', 'CANCELLED', 999_000),
      dOrder('SO-OCT', '2026-10-30', 'DELIVERED', 70_000),
      dOrder('SO-NOV', '2026-12-01', 'LOADED', 999_000),
      // Company 1 reuses the number SO-OCT: neither its DO nor its order is this company's.
      dOrder('SO-OCT', '2026-11-12', 'DELIVERED', 999_000, 1),
    ],
    mfg_sales_orders: [
      order('SO-NOV', '2026-11-01'),
      order('SO-OCT', '2026-10-31'),
      // Brought over at the cutover: "HC-" + the book's number.
      order('HC-SO-000777', '2026-03-14', CO, 'SO-000777'),
      order('SO-OCT', '2026-11-02', 1),
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
  app.get('/accounting/so-do-conversion', soDoConversionHandler as never);
  return app;
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/so-do-conversion?${qs}`);
  return { status: res.status, body: await res.json() as any };
};

describe('GET /accounting/so-do-conversion', () => {
  test('the financial statements key answers at this end', async () => {
    expect((await read(harness([]), 'month=2026-11')).status).toBe(403);
  });

  test('a bad month is refused by name', async () => {
    const r = await read(harness(), 'month=2026-13');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_month');
  });

  test("the month's shipped DOs of the active company, by the month of the order each came from", async () => {
    const r = await read(harness(), 'month=2026-11');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ month: '2026-11', from: '2026-11-01', to: '2026-11-30' });
    expect(r.body.rows.map((x: any) => [x.doNumber, x.doDate, x.docNo, x.soDate, x.part, x.otherReason, x.imported, x.amountSen])).toEqual([
      ['DO-001', '2026-11-03', 'SO-NOV', '2026-11-01', 'this_month', null, false, 100_000],
      ['DO-003', '2026-11-05', 'SO-OCT', '2026-10-31', 'earlier', null, false, 300_000],
      ['DO-004', '2026-11-08', 'HC-SO-000777', '2026-03-14', 'earlier', null, true, 50_000],
      ['DO-005', '2026-11-09', null, null, 'other', 'no_order', false, 0],
      ['DO-002', '2026-11-20', 'SO-NOV', '2026-11-01', 'this_month', null, false, 50_000],
    ]);
    expect(r.body.rows[0]).toMatchObject({ status: 'LOADED', customer: 'Customer SO-NOV' });
    expect(r.body.total).toEqual({ dos: 5, amountSen: 500_000, pct: 100 });
    expect(r.body.parts).toEqual({
      this_month: { dos: 2, amountSen: 150_000, pct: 30 },
      earlier: { dos: 2, amountSen: 350_000, pct: 70 },
      other: { dos: 1, amountSen: 0, pct: 0 },
    });
  });

  test('a month with no shipped DO has no share to give', async () => {
    const r = await read(harness(), 'month=2026-09');
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([]);
    expect(r.body.total).toEqual({ dos: 0, amountSen: 0, pct: null });
    expect(r.body.parts.this_month).toEqual({ dos: 0, amountSen: 0, pct: null });
  });
});

describe('buildSoDoConversion', () => {
  const doRow = (id: string, so: string | null, date = '2026-11-15', sen = 10_000) => ({
    id, do_number: id, do_date: date, so_doc_no: so, status: 'DELIVERED', local_total_sen: sen, debtor_name: null,
  });

  test("an order that is not this company's, or dated after the DO's month, is other and says why", () => {
    const out = buildSoDoConversion({
      month: '2026-11', from: '2026-11-01', to: '2026-11-30',
      dos: [doRow('A', 'SO-GONE'), doRow('B', 'SO-DEC'), doRow('C', '  ')],
      orders: [{ doc_no: 'SO-DEC', so_date: '2026-12-02', debtor_name: null, linked_ac_docno: null }],
    });
    expect(out.rows.map((r) => [r.id, r.part, r.otherReason])).toEqual([
      ['A', 'other', 'order_not_found'], ['B', 'other', 'order_after'], ['C', 'other', 'no_order'],
    ]);
  });

  test('a Draft or Cancelled DO, or one dated outside the month, is never counted', () => {
    const out = buildSoDoConversion({
      month: '2026-11', from: '2026-11-01', to: '2026-11-30',
      dos: [
        { ...doRow('D', null), status: 'DRAFT' }, { ...doRow('E', null), status: 'cancelled' },
        doRow('F', null, '2026-10-31'), doRow('G', null, '2026-11-30T23:00:00Z'),
      ],
      orders: [],
    });
    expect(out.rows.map((r) => r.id)).toEqual(['G']);
  });

  test('a share is of the month total, to one decimal', () => {
    expect(shareOf(1, 3)).toBe(33.3);
    expect(shareOf(2, 3)).toBe(66.7);
    expect(shareOf(0, 0)).toBeNull();
  });

  test('the shares add up to 100.0, the rounding left over going to the largest part', () => {
    /* Three near-equal thirds round to 33.3 each, 99.9 in all; the largest part takes the 0.1 left over. */
    const out = buildSoDoConversion({
      month: '2026-11', from: '2026-11-01', to: '2026-11-30',
      dos: [doRow('A', 'SO-NOW', '2026-11-15', 10_000), doRow('B', 'SO-OLD', '2026-11-15', 10_000), doRow('C', null, '2026-11-15', 10_001)],
      orders: [
        { doc_no: 'SO-NOW', so_date: '2026-11-02', debtor_name: null, linked_ac_docno: null },
        { doc_no: 'SO-OLD', so_date: '2026-10-02', debtor_name: null, linked_ac_docno: null },
      ],
    });
    expect([out.parts.this_month.pct, out.parts.earlier.pct, out.parts.other.pct]).toEqual([33.3, 33.3, 33.4]);
    expect(out.total.pct).toBe(100);
  });
});
