/* AR Invoices — the Finance list of the money owed TO the company (owner
   2026-09-29: 可以把 sales invoice 和 other debtor bill 做一个类似 ap invoice
   这样让我 finance 这边看两个一起吗). Pinned:
     • the list shows BOTH kinds — sales invoices as a read-only mirror (the
       live ones: never a DRAFT, never a CANCELLED) beside the other-debtor
       bills — one table, a `kind`, newest first;
     • a sales invoice's outstanding is the Sales Invoices list's OWN figure:
       total − its receipts − the order's deposit applied (si-order-deposit);
     • a bill's outstanding is total − received, its debtor named off the
       registry; the kind filter narrows; a bill opens with its lines and its
       debtor; a bill of another company is not found.
   Same bare-Hono + fake-PostgREST-shaped harness as tests/otherDebtors.test.ts. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { arInvoices } from '../src/scm/routes/ar-invoices';

type Row = Record<string, any>;
const CO = 1;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] { return this.rows.filter((r) => this.preds.every((p) => p(r))); }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery(tables[t] ||= []) } as never);
    c.set('companyId' as never, CO as never);
    /* The router carries the supabaseAuth bridge (docs/bugs/0648). The pinned
       system-staff id is the bridge's own "already translated" mark, so it steps
       aside and the supabase + houzsUser set by hand below stay in force. */
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.route('/ar-invoices', arInvoices);
  return app;
}

const si = (over: Row): Row => ({
  company_id: CO, so_doc_no: null, debtor_code: '300-C001', debtor_name: 'TAN AH KOW', invoice_date: '2026-09-01', due_date: null,
  currency: 'MYR', total_sen: 100_000, local_total_sen: 100_000, paid_sen: 0, status: 'SENT', notes: null, ...over,
});

const tables = (): Record<string, Row[]> => ({
  sales_invoices: [
    /* An order deposit of 200 settles part of this one — the SI list's own rule. */
    si({ id: 'si-1', invoice_number: 'HC-SI-2609-001', so_doc_no: 'HC-SO-2609-004', total_sen: 440_000, local_total_sen: 440_000, paid_sen: 40_000, invoice_date: '2026-09-03', due_date: '2026-09-30', notes: 'Bedroom set' }),
    si({ id: 'si-2', invoice_number: 'HC-SI-2609-002', debtor_code: '300-C002', debtor_name: 'LIM MEI LING', total_sen: 250_000, local_total_sen: 250_000, paid_sen: 250_000, status: 'PAID', invoice_date: '2026-09-02' }),
    si({ id: 'si-d', invoice_number: 'HC-SI-2609-090', status: 'DRAFT', invoice_date: '2026-09-09' }),
    si({ id: 'si-x', invoice_number: 'HC-SI-2609-091', status: 'CANCELLED', invoice_date: '2026-09-09' }),
    si({ id: 'si-o', company_id: 2, invoice_number: 'ZZ-SI-2609-001', invoice_date: '2026-09-09' }),
  ],
  mfg_sales_orders: [{ doc_no: 'HC-SO-2609-004', company_id: CO, total_revenue_sen: 440_000, deposit_sen: 0 }],
  mfg_sales_order_payments: [{ id: 'p1', so_doc_no: 'HC-SO-2609-004', amount_sen: 20_000, is_deposit: true }],
  acc_debtors: [
    { id: 'd1', company_id: CO, name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, address1: '12 Jalan Satu', city: 'Petaling Jaya' },
    { id: 'd9', company_id: 2, name: 'SOMEONE ELSE', phone: null, notes: null, is_active: true },
  ],
  acc_debtor_bills: [
    { id: 'b1', company_id: CO, bill_number: 'HC-ODB-2609-001', debtor_id: 'd1', bill_date: '2026-09-05', total_sen: 50_000, received_sen: 20_000, status: 'POSTED', notes: '转租九月', created_at: '2026-09-05T02:00:00Z' },
    { id: 'b2', company_id: CO, bill_number: 'HC-ODB-2608-003', debtor_id: 'd1', bill_date: '2026-08-20', total_sen: 10_000, received_sen: 10_000, status: 'PAID', notes: null, created_at: '2026-08-20T02:00:00Z' },
    { id: 'b9', company_id: 2, bill_number: 'ZZ-ODB-2609-001', debtor_id: 'd9', bill_date: '2026-09-06', total_sen: 999, received_sen: 0, status: 'POSTED', notes: null, created_at: '2026-09-06T02:00:00Z' },
  ],
  acc_debtor_bill_lines: [
    { id: 'l1', company_id: CO, bill_id: 'b1', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50_000 },
    { id: 'l2', company_id: CO, bill_id: 'b2', line_no: 1, description: null, credit_account_code: '700-0000', amount_sen: 10_000 },
  ],
});

describe('the Finance list — both kinds', () => {
  test('live sales invoices mirror beside the debtor bills, newest first, each with its kind, party and outstanding', async () => {
    const app = harness(tables());
    const res = await app.request('/ar-invoices');
    expect(res.status, await res.clone().text()).toBe(200);
    const b = await res.json() as { rows: Row[] };
    expect(b.rows.map((r) => [r.kind, r.invoiceNumber, r.partyName, r.outstandingSen])).toEqual([
      ['ODB', 'HC-ODB-2609-001', 'AHMAD BIN ALI', 30_000],
      ['SI', 'HC-SI-2609-001', 'TAN AH KOW', 380_000],
      ['SI', 'HC-SI-2609-002', 'LIM MEI LING', 0],
      ['ODB', 'HC-ODB-2608-003', 'AHMAD BIN ALI', 0],
    ]);
    /* Never a draft, never a cancelled one, never another company's. */
    const numbers = b.rows.map((r) => r.invoiceNumber);
    expect(numbers).not.toContain('HC-SI-2609-090');
    expect(numbers).not.toContain('HC-SI-2609-091');
    expect(numbers).not.toContain('ZZ-SI-2609-001');
    expect(numbers).not.toContain('ZZ-ODB-2609-001');
  });

  test("a sales invoice's outstanding is the SI list's own figure: total − receipts − the order's deposit applied, the slice reported", async () => {
    const app = harness(tables());
    const b = await (await app.request('/ar-invoices?kind=SI')).json() as { rows: Row[] };
    const row = b.rows.find((r) => r.invoiceNumber === 'HC-SI-2609-001')!;
    /* 4,400 − 400 own receipts − 200 order deposit = 3,800; "paid" is what settles it. */
    expect(row).toMatchObject({
      kind: 'SI', partyKey: 'C:300-C001', partyCode: '300-C001', ref: 'HC-SO-2609-004', description: 'Bedroom set',
      invoiceDate: '2026-09-03', dueDate: '2026-09-30', currency: 'MYR',
      totalSen: 440_000, paidSen: 60_000, depositAppliedSen: 20_000, outstandingSen: 380_000, status: 'SENT', debtorId: null,
    });
    expect(b.rows.map((r) => r.kind)).toEqual(['SI', 'SI']);
  });

  test('a bill row names its debtor off the registry and carries the registry id for the filter', async () => {
    const app = harness(tables());
    const b = await (await app.request('/ar-invoices?kind=ODB')).json() as { rows: Row[] };
    expect(b.rows.map((r) => r.kind)).toEqual(['ODB', 'ODB']);
    expect(b.rows[0]).toMatchObject({
      kind: 'ODB', invoiceNumber: 'HC-ODB-2609-001', partyKey: 'D:d1', debtorId: 'd1', partyName: 'AHMAD BIN ALI', partyCode: null,
      ref: null, description: '转租九月', invoiceDate: '2026-09-05', dueDate: null,
      totalSen: 50_000, paidSen: 20_000, depositAppliedSen: 0, outstandingSen: 30_000, status: 'POSTED',
    });
  });

  test('an unknown kind is refused by name', async () => {
    const app = harness(tables());
    const res = await app.request('/ar-invoices?kind=PI');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('bad_kind');
  });
});

describe('a bill opens with its lines and its debtor', () => {
  test('the pop-out gets the bill, its lines in order and the registry row that prints as BILL TO', async () => {
    const app = harness(tables());
    const res = await app.request('/ar-invoices/bills/b1');
    expect(res.status, await res.clone().text()).toBe(200);
    const b = await res.json() as { bill: Row; debtor: Row };
    expect(b.bill).toMatchObject({ id: 'b1', bill_number: 'HC-ODB-2609-001', total_sen: 50_000, received_sen: 20_000, status: 'POSTED' });
    expect(b.bill.lines).toEqual([{ id: 'l1', company_id: CO, bill_id: 'b1', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50_000 }]);
    expect(b.debtor).toMatchObject({ id: 'd1', name: 'AHMAD BIN ALI', address1: '12 Jalan Satu', city: 'Petaling Jaya' });
  });

  test("another company's bill is not found", async () => {
    const app = harness(tables());
    const res = await app.request('/ar-invoices/bills/b9');
    expect(res.status).toBe(404);
  });
});
