/* Sales-invoice money verbs — the company gate that was applied to the DELIVERY
   ORDER twins on 2026-08-13 and never to these.
 *
 * The asymmetry, read in source rather than inferred:
 *
 *   delivery-orders-mfg.ts  POST /:id/payments          scopeToCompany  (fixed)
 *   delivery-orders-mfg.ts  DELETE /:id/payments/:pid   scopeToCompany  (fixed)
 *   sales-invoices.ts       POST /:id/payments          .eq('id', id)   (MISSED)
 *   sales-invoices.ts       DELETE /:id/payments/:pid   .eq('id', id)   (MISSED)
 *   sales-invoices.ts       PATCH /:id/payment          .eq('id', id)   (MISSED)
 *
 * The SI insert even carried the comment "multi-company: match the SI's
 * company" above `company_id: activeCompanyId(c)` — it stamped the ACTIVE
 * company and never compared it to the invoice's, so a payment against company
 * B's invoice was filed under company A while recomputePaid moved B's
 * paid_centi and AR status.
 *
 * The second handler here is the FIFTH converter of the DO -> SI shape.
 * companyScope.ts names four (SO->DO, SO->SI, DO->SI, PO->GRN) and every one
 * refuses a cross-company source; `POST /:id/items/from-do/:doId` is the
 * PARTIAL form of DO -> SI (a second delivery folded into an existing invoice)
 * and checked nothing at all.
 *
 * Harness copied from companyScopeHardening.test.ts: a bare Hono app whose
 * middleware injects a fake scm supabase client plus a company context, mounting
 * the EXPORTED handlers because the supabaseAuth bridge cannot run here.
 *
 * Both directions on every case, deliberately: a scope sweep's real failure mode
 * is hiding a company's own data from its own users, which nobody reports.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  postSalesInvoicePaymentHandler,
  appendDoLinesToSalesInvoiceHandler,
} from '../src/scm/routes/sales-invoices';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — same contract as the sibling test: every
   method chains, an unknown table reads as empty rather than throwing, because
   the assertions are about the company predicate and not the rest of the
   handler. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string, private log: string[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  upsert(p: Row | Row[]) { return this.insert(p); }
  eq(col: string, val: unknown) {
    this.log.push(`${this.table}.${this.op}:eq:${col}`);
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, companyId: number | undefined) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('companyCode' as never, (companyId === CO_B ? '2990' : 'HOUZS') as never);
    c.set('companies' as never, [
      { id: CO_A, code: 'HOUZS', name: 'Houzs Century' },
      { id: CO_B, code: '2990', name: '2990' },
    ] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/sales-invoices/:id/payments', postSalesInvoicePaymentHandler as never);
  app.post('/sales-invoices/:id/items/from-do/:doId', appendDoLinesToSalesInvoiceHandler as never);
  return { app, log };
}

const postJson = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const PAYMENT = { paidAt: '2026-08-13', method: 'cash', amountCenti: 5000 };

// ── POST /:id/payments — money IN on the other company's receivable ──────────
describe('SI payment create is company-scoped', () => {
  const invoices = (): Row[] => [
    { id: 'si-a', invoice_number: 'HC-SI-2608-001', company_id: CO_A, status: 'SENT', total_centi: 10000, paid_centi: 0 },
    { id: 'si-b', invoice_number: '2990-SI-2608-001', company_id: CO_B, status: 'SENT', total_centi: 10000, paid_centi: 0 },
  ];

  test("A cannot record a payment against B's invoice, and B's ledger is untouched", async () => {
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_payments: [] };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-b/payments', PAYMENT);
    expect(res.status).toBe(404);
    // A refusal that still wrote would pass a status-only assertion.
    expect(t.sales_invoice_payments).toHaveLength(0);
    expect(t.sales_invoices.find((r) => r.id === 'si-b')!.paid_centi).toBe(0);
    expect(t.sales_invoices.find((r) => r.id === 'si-b')!.status).toBe('SENT');
  });

  test('A CAN still record a payment on its own invoice', async () => {
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_payments: [] };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/payments', PAYMENT);
    expect(res.status).toBe(201);
    expect(t.sales_invoice_payments).toHaveLength(1);
    expect(t.sales_invoices.find((r) => r.id === 'si-a')!.paid_centi).toBe(5000);
  });

  test('the stamped company_id is the invoice\'s, not merely whatever was active', async () => {
    // The old comment claimed this; only the gate above makes it true.
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_payments: [] };
    await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/payments', PAYMENT);
    expect(t.sales_invoice_payments[0]!.company_id).toBe(CO_A);
  });

  test('an UNRESOLVED company still serves — the three-state sentinel degrades', async () => {
    // companies master unreadable (pre-migration / cold start). Single-company
    // Houzs must keep taking payments; failing closed here is an outage.
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_payments: [] };
    const res = await postJson(harness(t, undefined).app, '/sales-invoices/si-a/payments', PAYMENT);
    expect(res.status).toBe(201);
  });
});

// ── POST /:id/items/from-do/:doId — the fifth DO -> SI converter ─────────────
describe('SI append-from-DO refuses a cross-company source', () => {
  const invoices = (): Row[] => [
    { id: 'si-a', invoice_number: 'HC-SI-2608-001', company_id: CO_A, status: 'DRAFT' },
    { id: 'si-b', invoice_number: '2990-SI-2608-001', company_id: CO_B, status: 'DRAFT' },
  ];
  const dos = (): Row[] => [
    { id: 'do-a', do_number: 'HC-DO-2608-001', company_id: CO_A, status: 'SHIPPED' },
    { id: 'do-b', do_number: '2990-DO-2608-001', company_id: CO_B, status: 'SHIPPED' },
  ];

  test("A cannot append its own invoice from B's delivery order", async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/items/from-do/do-b');
    expect(res.status).toBe(409);
    const body = await res.json() as Row;
    expect(body.error).toBe('cross_company_conversion_blocked');
    // Names the document and both companies — the operator's next question.
    expect(body.sourceDocNo).toBe('2990-DO-2608-001');
    expect(body.sourceCompany).toBe('2990');
    expect(body.activeCompany).toBe('HOUZS');
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test("A cannot append B's invoice at all — the header read is scoped", async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-b/items/from-do/do-b');
    expect(res.status).toBe(404);
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test('a SAME-company append gets past both gates', async () => {
    // No DO lines to copy, so the handler reaches its own do_fully_invoiced
    // refusal — which is exactly the proof wanted: neither company gate fired.
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/items/from-do/do-a');
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('do_fully_invoiced');
  });

  test('an UNRESOLVED company degrades to allowed, matching the other converters', async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, undefined).app, '/sales-invoices/si-a/items/from-do/do-b');
    expect((await res.json() as Row).error).not.toBe('cross_company_conversion_blocked');
  });
});
