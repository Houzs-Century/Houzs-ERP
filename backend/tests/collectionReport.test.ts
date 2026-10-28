/* The Collection report (owner 2026-09-12, docs/bugs/0825). Pinned:
     • DEPOSIT view: orders by SO date, deposit collected against order value
       per salesman, and how many sit under the threshold (default 50%);
     • BALANCE view: of the delivered orders, the balance after deposit and
       how much of it has come in — and of an INVOICED order, measured against
       the final invoice's total, whatever its status says (docs/bugs/0831);
     • collected is read from the payments on the order — a deposit topped up
       later counts, and a payment not flagged deposit is balance;
     • DRAFT and CANCELLED are not orders; a date outside the range is not in;
     • the threshold and a salesperson filter are the caller's; a bad range
       is refused; the permission gate answers at this end.
   Real handler, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { collectionReport } from '../src/scm/routes/accounting-collection';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const so = (docNo: string, date: string, status: string, seller: string | null, totalSen: number, over: Row = {}): Row => ({
  company_id: CO, doc_no: docNo, so_date: date, status, debtor_name: `Customer of ${docNo}`,
  local_total_sen: totalSen, salesperson_id: seller, agent: null, ...over,
});
let payId = 0;
const pay = (docNo: string, amountSen: number, deposit: boolean): Row => ({
  id: `pay-${++payId}`, company_id: CO, so_doc_no: docNo, amount_sen: amountSen, is_deposit: deposit, paid_at: '2026-07-05', method: 'merchant',
});

const world = () => fakeSb({
  mfg_sales_orders: [
    so('SO-1', '2026-07-02', 'CONFIRMED', A, 500000),          // deposit 2,000 of 5,000 → 40%
    so('SO-2', '2026-07-10', 'DELIVERED', A, 300000),          // deposit 1,500 of 3,000, balance paid 1,000 of 1,500
    so('SO-3', '2026-07-15', 'CANCELLED', A, 999900),          // not an order
    so('SO-4', '2026-07-20', 'DELIVERED', B, 200000),          // paid in full as deposit
    so('SO-5', '2026-08-01', 'CONFIRMED', A, 100000),          // outside the range
    so('SO-6', '2026-07-25', 'DRAFT', B, 700000),              // not an order
    so('SO-7', '2026-07-28', 'CONFIRMED', null, 100000, { agent: 'Walk-in Agent' }), // no staff row: the agent text
    so('SO-8', '2026-07-29', 'CONFIRMED', B, 100000),          // not delivered by status, but its final invoice exists: billed 1,100, deposit 400
  ],
  sales_invoices: [
    { id: 'si-4', company_id: CO, so_doc_no: 'SO-4', invoice_number: 'SI-4', status: 'PAID', total_sen: 200000 },
    { id: 'si-8', company_id: CO, so_doc_no: 'SO-8', invoice_number: 'SI-8', status: 'SENT', total_sen: 110000 },
    { id: 'si-8x', company_id: CO, so_doc_no: 'SO-8', invoice_number: 'SI-8X', status: 'CANCELLED', total_sen: 999900 }, // a cancelled invoice is no invoice
  ],
  mfg_sales_order_payments: [
    pay('SO-1', 150000, true), pay('SO-1', 50000, true),       // two deposits, 2,000 together
    pay('SO-2', 150000, true), pay('SO-2', 100000, false),
    pay('SO-3', 999900, true),
    pay('SO-4', 200000, true),
    pay('SO-5', 100000, true),
    pay('SO-8', 40000, true),
  ],
  staff: [
    { id: A, name: 'Scarlett Chong Kar Yin', active: true },
    { id: B, name: 'Kah Wai', active: true },
  ],
});

function harness(perms: readonly string[] = [GL_PERM]) {
  const sb = world();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/reports/collection', collectionReport as never);
  return { app, sb };
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/reports/collection?${qs}`);
  return { status: res.status, body: await res.json() as any };
};

describe('the Collection report', () => {
  test('deposit against order value per salesman, and who sits under the threshold', async () => {
    const { app } = harness();
    const { status, body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(status).toBe(200);
    expect(body.thresholdPct).toBe(50);
    expect(body.rows.map((r: any) => r.salesperson)).toEqual(['Scarlett Chong Kar Yin', 'Kah Wai', 'Walk-in Agent']);
    const [scarlett, kahWai, agent] = body.rows;
    expect(scarlett).toMatchObject({ salespersonId: A, orders: 2, totalSen: 800000, depositSen: 350000, depositPct: 43.8, belowCount: 1 });
    expect(kahWai).toMatchObject({ salespersonId: B, orders: 2, totalSen: 300000, depositSen: 240000, depositPct: 80, belowCount: 1 });
    expect(agent).toMatchObject({ salespersonId: null, orders: 1, totalSen: 100000, depositSen: 0, depositPct: 0, belowCount: 1 });
    /* The two deposits on SO-1 count together; the order under the line is named. */
    const so1 = scarlett.sos.find((o: any) => o.docNo === 'SO-1');
    expect(so1).toMatchObject({ depositSen: 200000, depositPct: 40, belowThreshold: true, delivered: false, outstandingSen: 300000, invoiceNumber: null, billedSen: 500000 });
    /* Cancelled, draft and out-of-range orders are nowhere. */
    const docs = body.rows.flatMap((r: any) => r.sos.map((o: any) => o.docNo));
    expect(docs.sort()).toEqual(['SO-1', 'SO-2', 'SO-4', 'SO-7', 'SO-8']);
    expect(body.totals).toMatchObject({ orders: 5, totalSen: 1200000, depositSen: 590000, depositPct: 49.2, belowCount: 3 });
  });

  test('the balance view reads the delivered orders, and an invoiced order against its final invoice', async () => {
    const { app } = harness();
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    const scarlett = body.rows[0];
    expect(scarlett.delivered).toEqual({ orders: 1, totalSen: 300000, billedSen: 300000, depositSen: 150000, balanceDueSen: 150000, balancePaidSen: 100000, balancePct: 66.7, outstandingSen: 50000 });
    const so2 = scarlett.sos.find((o: any) => o.docNo === 'SO-2');
    expect(so2).toMatchObject({ delivered: true, invoiceNumber: null, billedSen: 300000, balanceDueSen: 150000, balancePaidSen: 100000, balancePct: 66.7, outstandingSen: 50000 });
    /* SO-4: paid in full as deposit, its invoice equal to the order — nothing
       due. SO-8: CONFIRMED by status, but its final invoice (1,100 against an
       order of 1,000) puts it at the balance stage, measured against 1,100;
       the cancelled SI-8X is no invoice. */
    const kahWai = body.rows[1];
    expect(kahWai.delivered).toEqual({ orders: 2, totalSen: 300000, billedSen: 310000, depositSen: 240000, balanceDueSen: 70000, balancePaidSen: 0, balancePct: 0, outstandingSen: 70000 });
    const so4 = kahWai.sos.find((o: any) => o.docNo === 'SO-4');
    expect(so4).toMatchObject({ delivered: true, invoiceNumber: 'SI-4', billedSen: 200000, balanceDueSen: 0, outstandingSen: 0 });
    const so8 = kahWai.sos.find((o: any) => o.docNo === 'SO-8');
    expect(so8).toMatchObject({ status: 'CONFIRMED', delivered: true, invoiceNumber: 'SI-8', totalSen: 100000, billedSen: 110000, depositSen: 40000, depositPct: 40, balanceDueSen: 70000, balancePaidSen: 0, outstandingSen: 70000 });
    expect(body.totals.delivered).toMatchObject({ orders: 3, billedSen: 610000, balanceDueSen: 220000, balancePaidSen: 100000, balancePct: 45.5 });
  });

  test('the threshold and the salesperson are the caller\'s', async () => {
    const { app } = harness();
    const sixty = await read(app, 'from=2026-07-01&to=2026-07-31&threshold=60');
    expect(sixty.body.thresholdPct).toBe(60);
    expect(sixty.body.rows[0]).toMatchObject({ salesperson: 'Scarlett Chong Kar Yin', belowCount: 2 });
    const one = await read(app, `from=2026-07-01&to=2026-07-31&salesperson=${B}`);
    expect(one.body.rows.map((r: any) => r.salesperson)).toEqual(['Kah Wai']);
    expect(one.body.totals).toMatchObject({ orders: 2, totalSen: 300000 });
    /* A threshold that is not a percentage falls back to 50. */
    expect((await read(app, 'from=2026-07-01&to=2026-07-31&threshold=abc')).body.thresholdPct).toBe(50);
  });

  test('a bad range is refused, and the permission gate answers at this end', async () => {
    const { app } = harness();
    expect((await read(app, 'from=2026-07-31&to=2026-07-01')).status).toBe(400);
    expect((await read(app, 'from=July&to=2026-07-31')).status).toBe(400);
    const { app: noPerm } = harness(['scm.access']);
    expect((await read(noPerm, 'from=2026-07-01&to=2026-07-31')).status).toBe(403);
  });
});
