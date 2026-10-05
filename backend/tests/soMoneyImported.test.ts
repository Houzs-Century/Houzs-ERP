/* The money on a Sales Order counts the payments brought over from AutoCount
   (owner 2026-10-05: 「两个payment 我要看到也可以refund 和 convert … 那个在erp
   开张前已记录，所以照理没欠了」), and the same customer is never "everyone on
   the cash debtor" (Houzs's 300-C002 sits on thousands of orders of different
   people; the Convert list walked them all and the panel vanished). Pinned:
     • the panel: the AutoCount payment is in the pool beside the booked one,
       flagged, its share named (importedSen); a live order keeps its floor of
       the whole;
     • a refund from the panel may take the AutoCount money too;
     • a conversion may move money from an order whose only money came over
       from AutoCount;
     • the same customer: by customer id, else phone, else debtor code AND
       name — a shared debtor code alone lists nobody else.
   Real handlers, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { postSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders';
import { soConvertSourcesHandler, soMoneyHandler, soMoneyRefundHandler } from '../src/scm/routes/so-money-routes';

const CO = 1;
const A = 'HC-SO-009202';
const B = 'HC-SO-009300';
const C = 'HC-SO-009301';
const D = 'HC-SO-009302';
const NEW = 'HC-SO-2610-001';

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
];
/* Houzs's way: no customer id, the cash debtor code, a phone (or none). */
const order = (doc_no: string, status: string, over: Row = {}): Row => ({
  doc_no, company_id: CO, status, debtor_name: 'Teresa Teh', debtor_code: '300-C002', phone: null, customer_id: null,
  salesperson_id: 'staff-1', access_staff_ids: null, open_to_all: true, updated_at: '2026-09-22T02:00:00Z', local_total_sen: 1_980_000, ...over,
});
const pay = (id: string, so: string, paid_at: string, method: string, amount_sen: number): Row => ({
  id, so_doc_no: so, paid_at, method, merchant_provider: null, installment_months: null, online_type: null, approval_code: null,
  amount_sen, account_sheet: null, slip_key: null, collected_by: 'staff-1', note: null, company_id: CO, version: 1,
  created_at: `${paid_at}T03:00:00Z`, created_by: 'u1', is_deposit: false, converted_from_so_doc_no: null,
});
const je = (id: string, paymentId: string, date: string): Row => ({
  id, je_no: `JE-${id}`, company_id: CO, source_type: 'SOPAY', source_doc_no: paymentId, reversed: false, reversed_by_je: null,
  entry_date: date, posted: true, narration: `Payment on ${paymentId}`, total_debit_sen: 0, total_credit_sen: 0,
});

function harness(tables: Record<string, Row[]> = {}) {
  const sb = fakeSb(
    {
      accounts: CHART.map((r) => ({ ...r })),
      acc_account_roles: [],
      acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }],
      acc_numbering: [],
      acc_company_settings: [],
      acc_deposit_invoices: [],
      acc_credit_notes: [],
      acc_credit_note_lines: [],
      acc_official_receipts: [],
      acc_supplier_advances: [],
      acc_vendor_memory: [],
      companies: [{ id: CO, code: 'HC' }],
      customer_credits: [],
      entity_audit_log: [],
      journal_entries: [je('je1', 'pA2', '2026-09-21')],
      journal_entry_lines: [],
      mfg_sales_orders: [
        order(A, 'DELIVERED'),
        /* Other people on the same cash debtor code. */
        order(B, 'CANCELLED', { debtor_name: 'Someone Else' }),
        order(C, 'CANCELLED', { debtor_name: 'Another Person' }),
        /* The same name on the same code: the same customer. */
        order(D, 'CANCELLED', { local_total_sen: 500_000 }),
        order(NEW, 'CONFIRMED', { local_total_sen: 900_000 }),
      ],
      mfg_sales_order_payments: [
        pay('pA1', A, '2025-11-16', 'imported', 600_000),
        pay('pA2', A, '2026-09-21', 'transfer', 1_380_000),
        pay('pB1', B, '2025-10-01', 'imported', 200_000),
        pay('pC1', C, '2025-10-02', 'imported', 300_000),
        pay('pD1', D, '2025-12-01', 'imported', 150_000),
      ],
      mfg_so_audit_log: [],
      payment_voucher_lines: [],
      payment_vouchers: [],
      pv_allocations: [],
      sales_invoices: [],
      sales_invoice_payments: [],
      staff: [],
      suppliers: [],
      ...tables,
    },
    {},
    [{ table: 'payment_vouchers', column: 'pv_number', name: 'payment_vouchers_pv_number_key' }],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Sales A' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Sales A', permissions_set: ['*'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('env' as never, {} as never);
    await next();
  });
  app.get('/mfg-sales-orders/:docNo/money', soMoneyHandler as never);
  app.post('/mfg-sales-orders/:docNo/money/refund', soMoneyRefundHandler as never);
  app.get('/mfg-sales-orders/:docNo/convert-sources', soConvertSourcesHandler as never);
  app.post('/mfg-sales-orders/:docNo/payments', postSoPaymentHandler as never);
  return { app, sb };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const money = async (app: Hono, docNo: string) => {
  const res = await app.request(`/mfg-sales-orders/${docNo}/money`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as { money: Record<string, any>; others: Array<Record<string, any>> };
};

describe('AutoCount money is the order\'s money', () => {
  test('the panel counts the AutoCount payment beside the booked one and names its share', async () => {
    const { app } = harness();
    const { money: m } = await money(app, A);
    expect(m).toMatchObject({
      docNo: A, cancelled: false, bookedSen: 1_980_000, importedSen: 600_000, remainingSen: 1_980_000, open: true, reason: null,
      keepFraction: 0.3, keepSen: 594_000, movableSen: 1_386_000,
    });
    expect(m.payments.map((p: Row) => [p.id, p.booked, p.imported])).toEqual([['pA1', false, true], ['pA2', true, false]]);
  });

  test('a refund from the panel may take the AutoCount money too', async () => {
    const { app, sb } = harness();
    const res = await app.request(`/mfg-sales-orders/${A}/money/refund`, json({ amountSen: 1_980_000, note: 'whole order' }));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(sb.tables.payment_vouchers[0]).toMatchObject({ purpose: 'CUSTOMER_REFUND', refund_source_doc_no: A, total_sen: 1_980_000, status: 'DRAFT' });
    const more = await app.request(`/mfg-sales-orders/${A}/money/refund`, json({ amountSen: 100 }));
    expect(more.status).toBe(409);
  });

  test('money moves off an order whose only money came over from AutoCount', async () => {
    const { app, sb } = harness();
    const res = await app.request(`/mfg-sales-orders/${NEW}/payments`, json({ paidAt: '2026-10-05', method: 'converted', convertedFromDocNo: D, amountSen: 150_000 }));
    expect(res.status, await res.clone().text()).toBe(201);
    const row = sb.tables.mfg_sales_order_payments.find((r) => r.so_doc_no === NEW && r.converted_from_so_doc_no === D);
    expect(row).toMatchObject({ method: 'converted', amount_sen: 150_000, paid_at: '2025-12-01' });
    const { money: d } = await money(app, D);
    expect(d).toMatchObject({ convertedSen: 150_000, remainingSen: 0, open: false });
  });
});

describe('the same customer is never everyone on the cash debtor', () => {
  test('a shared debtor code lists only the orders under the same name', async () => {
    const { app } = harness();
    const { others } = await money(app, A);
    expect(others.map((o) => o.docNo)).toEqual([D]);
    const res = await app.request(`/mfg-sales-orders/${NEW}/convert-sources`);
    expect(res.status).toBe(200);
    const b = await res.json() as { sources: Array<Record<string, any>> };
    expect(b.sources.map((s) => s.docNo)).toEqual([A, D]);
  });

  test('a phone finds the customer\'s orders whatever their names; a customer id comes first', async () => {
    const { app } = harness({
      mfg_sales_orders: [
        order(A, 'DELIVERED', { phone: '0123456789' }),
        order(B, 'CANCELLED', { debtor_name: 'T. Teh', phone: '0123456789' }),
        order(C, 'CANCELLED', { debtor_name: 'Teresa Teh', phone: '0199999999' }),
      ],
    });
    const { others } = await money(app, A);
    expect(others.map((o) => o.docNo)).toEqual([B]);
  });
});
