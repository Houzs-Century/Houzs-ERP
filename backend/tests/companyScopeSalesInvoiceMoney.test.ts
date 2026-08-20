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
 *   sales-invoices.ts       POST  /:id/items            .eq('id', id)   (MISSED AGAIN,
 *                                                                        2026-08-19)
 *
 * The SI insert even carried the comment "multi-company: match the SI's
 * company" above `company_id: activeCompanyId(c)` — it stamped the ACTIVE
 * company and never compared it to the invoice's, so a payment against company
 * B's invoice was filed under company A while recomputePaid moved B's
 * paid_sen and AR status.
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
  createSalesInvoiceFromDoLinesHandler,
  appendSalesInvoiceItemHandler,
} from '../src/scm/routes/sales-invoices';
import { createDoFromSoLinesHandler } from '../src/scm/routes/delivery-orders-mfg';
import { convertDoLinesToReturn } from '../src/scm/routes/delivery-returns';

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
  app.post('/sales-invoices/:id/items', appendSalesInvoiceItemHandler as never);
  app.post('/sales-invoices/from-dos', createSalesInvoiceFromDoLinesHandler as never);
  app.post('/delivery-orders-mfg/from-sos', createDoFromSoLinesHandler as never);
  app.post('/delivery-returns/from-dos', convertDoLinesToReturn as never);
  return { app, log };
}

const postJson = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const PAYMENT = { paidAt: '2026-08-13', method: 'cash', amountSen: 5000 };

// ── POST /:id/payments — money IN on the other company's receivable ──────────
describe('SI payment create is company-scoped', () => {
  const invoices = (): Row[] => [
    { id: 'si-a', invoice_number: 'HC-SI-2608-001', company_id: CO_A, status: 'SENT', total_sen: 10000, paid_sen: 0 },
    { id: 'si-b', invoice_number: '2990-SI-2608-001', company_id: CO_B, status: 'SENT', total_sen: 10000, paid_sen: 0 },
  ];

  test("A cannot record a payment against B's invoice, and B's ledger is untouched", async () => {
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_payments: [] };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-b/payments', PAYMENT);
    expect(res.status).toBe(404);
    // A refusal that still wrote would pass a status-only assertion.
    expect(t.sales_invoice_payments).toHaveLength(0);
    expect(t.sales_invoices.find((r) => r.id === 'si-b')!.paid_sen).toBe(0);
    expect(t.sales_invoices.find((r) => r.id === 'si-b')!.status).toBe('SENT');
  });

  test('A CAN still record a payment on its own invoice', async () => {
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_payments: [] };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/payments', PAYMENT);
    expect(res.status).toBe(201);
    expect(t.sales_invoice_payments).toHaveLength(1);
    expect(t.sales_invoices.find((r) => r.id === 'si-a')!.paid_sen).toBe(5000);
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

/* ── THE CONVERSION SUITE (sales side) ────────────────────────────────────────
   SO -> DO -> SI is one chain and DO -> DR hangs off its middle, so all four
   converters are tested together here, on the one harness that already carries
   the invoice half. A document conversion never crosses a company; as of
   2026-08-13 that is held by SCOPING THE SOURCE LOAD rather than by comparing
   companies after loading it unscoped, so each test asserts the same pair:

     · the other company's source YIELDS NOTHING — the handler answers with its
       own "I could not find that", and no destination document is written;
     · this company's source is STILL VISIBLE — it gets past the source read and
       stops on a LATER, unrelated rule.

   These assertions changed shape on 2026-08-13: they used to expect
   `cross_company_conversion_blocked`, the 409 the REFUSAL mechanism returned.
   There is no refusal to return now, because there is no cross-company row to
   refuse. The message is worse and that is the recorded cost of the trade. */

// ── POST /:id/items/from-do/:doId — DO -> SI, the PARTIAL form ───────────────
describe('SI append-from-DO cannot see a cross-company source', () => {
  const invoices = (): Row[] => [
    { id: 'si-a', invoice_number: 'HC-SI-2608-001', company_id: CO_A, status: 'DRAFT' },
    { id: 'si-b', invoice_number: '2990-SI-2608-001', company_id: CO_B, status: 'DRAFT' },
  ];
  const dos = (): Row[] => [
    { id: 'do-a', do_number: 'HC-DO-2608-001', company_id: CO_A, status: 'DISPATCHED' },
    { id: 'do-b', do_number: '2990-DO-2608-001', company_id: CO_B, status: 'DISPATCHED' },
  ];

  test("B's delivery order is not visible to A's invoice", async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/items/from-do/do-b');
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('delivery_order_not_found');
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test("A cannot append B's invoice at all — the DESTINATION read is scoped too", async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-b/items/from-do/do-b');
    expect(res.status).toBe(404);
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test('a SAME-company append gets past both ends', async () => {
    // No DO lines to copy, so the handler reaches its own do_fully_invoiced
    // refusal — which is exactly the proof wanted: neither end hid anything.
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/items/from-do/do-a');
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('do_fully_invoiced');
  });

  test('BOTH source reads carry the company predicate — header and lines', async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const h = harness(t, CO_A);
    await postJson(h.app, '/sales-invoices/si-a/items/from-do/do-a');
    expect(h.log).toContain('delivery_orders.select:eq:company_id');
    expect(h.log).toContain('delivery_order_items.select:eq:company_id');
  });

  test('an UNRESOLVED company degrades to allowed, matching the other converters', async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(), delivery_orders: dos(),
      delivery_order_items: [], sales_invoice_items: [],
    };
    const res = await postJson(harness(t, undefined).app, '/sales-invoices/si-a/items/from-do/do-b');
    expect((await res.json() as Row).error).not.toBe('delivery_order_not_found');
  });
});

/* ── DO -> SI, picked lines ───────────────────────────────────────────────────
   The money hop: this mints the invoice, posts the revenue and the AR. */
describe('SI convert-from-DO-lines cannot see a cross-company source', () => {
  const dos = (): Row[] => [
    { id: 'do-a', do_number: 'HC-DO-2608-001', company_id: CO_A, status: 'DISPATCHED', debtor_code: 'C1', debtor_name: 'Cust', currency: 'MYR' },
    { id: 'do-b', do_number: '2990-DO-2608-001', company_id: CO_B, status: 'DISPATCHED', debtor_code: 'C9', debtor_name: 'Other', currency: 'MYR' },
  ];
  const doItems = (): Row[] => [
    { id: 'doi-a', delivery_order_id: 'do-a', company_id: CO_A, item_code: 'M1', item_group: null, description: null, description2: null, uom: 'UNIT', qty: 2, unit_price_sen: 100, unit_cost_sen: 50, discount_sen: 0, variants: null, line_no: 0 },
    { id: 'doi-b', delivery_order_id: 'do-b', company_id: CO_B, item_code: 'M9', item_group: null, description: null, description2: null, uom: 'UNIT', qty: 2, unit_price_sen: 100, unit_cost_sen: 50, discount_sen: 0, variants: null, line_no: 0 },
  ];
  const tables = (): Record<string, Row[]> => ({
    delivery_orders: dos(), delivery_order_items: doItems(),
    sales_invoices: [], sales_invoice_items: [], delivery_returns: [], delivery_return_items: [],
  });

  test("B's delivery line is not visible to A — no invoice is minted", async () => {
    const t = tables();
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/from-dos', {
      picks: [{ doItemId: 'doi-b', qty: 1 }],
    });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('do_item_not_found');
    expect(t.sales_invoices).toHaveLength(0);
  });

  test("A's own delivery line IS visible — its live remaining is derived", async () => {
    /* Ask for MORE than the line's remaining. Reaching `over_remaining` proves
       the source line was found AND its Pending pool computed off the source
       document — a deeper proof than merely getting a different 404. */
    const t = tables();
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/from-dos', {
      picks: [{ doItemId: 'doi-a', qty: 99 }],
    });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('over_remaining');
    expect(t.sales_invoices).toHaveLength(0);
  });

  test('the source line read carries the company predicate', async () => {
    const t = tables();
    const h = harness(t, CO_A);
    await postJson(h.app, '/sales-invoices/from-dos', { picks: [{ doItemId: 'doi-a', qty: 99 }] });
    expect(h.log).toContain('delivery_order_items.select:eq:company_id');
  });

  test('an UNRESOLVED company degrades to allowed', async () => {
    const t = tables();
    const res = await postJson(harness(t, undefined).app, '/sales-invoices/from-dos', {
      picks: [{ doItemId: 'doi-b', qty: 1 }],
    });
    expect((await res.json() as Row).error).not.toBe('do_item_not_found');
  });
});

/* ── SO -> DO ─────────────────────────────────────────────────────────────────
   THE ONE CONVERSION THAT CROSSES THE SWITCHER ON PURPOSE, and the tests below
   assert exactly that — the opposite of every other converter in this file.

   Delivery Planning is a SHARED queue: a Houzs dispatcher converts a 2990 SO
   and the result is a 2990 DO, under 2990's document prefix, drawing 2990's
   stock. The destination INHERITS the source's company rather than claiming it,
   so the books stay straight without hiding the document from the person who
   came to ship it.

   THE REAL DEFECT HERE was never the crossing. It was that the HEADER inherited
   while the LINES, the warehouse resolution and the stock lookups all used the
   ACTIVE company — so a 2990 DO deducted HOUZS stock. Both now resolve from one
   `sourceCompanyId`, taken from the picked SO lines.

   This route was broken TWICE on 2026-08-13 before the owner confirmed the
   design: once by adding a cross-company refusal (killing the feature), once by
   scoping its source reads (killing it structurally). An earlier draft of THIS
   BLOCK asserted the second mistake as correct behaviour. If these tests ever
   start asserting that a 2990 line is invisible to a Houzs caller, that is the
   third time — read companyScope.ts's INHERIT paragraph before changing them. */
describe('DO convert-from-SO-lines INHERITS the source company (shared Delivery Planning)', () => {
  const sos = (): Row[] => [
    /* Both DRAFT so the deliverability gate — the first rule AFTER the source
       read — is what stops every request that gets that far. It is the marker
       for "the source was visible". */
    { doc_no: 'HC-SO-2608-001', company_id: CO_A, status: 'DRAFT', debtor_code: 'C1', debtor_name: 'Cust' },
    { doc_no: '2990-SO-2608-001', company_id: CO_B, status: 'DRAFT', debtor_code: 'C9', debtor_name: 'Other' },
  ];
  const soItems = (): Row[] => [
    { id: 'soi-a', doc_no: 'HC-SO-2608-001', company_id: CO_A },
    { id: 'soi-b', doc_no: '2990-SO-2608-001', company_id: CO_B },
  ];
  const tables = (): Record<string, Row[]> => ({
    mfg_sales_orders: sos(), mfg_sales_order_items: soItems(), delivery_orders: [], delivery_order_items: [],
  });

  test("B's SO line IS visible to A — that is the shared queue, not a leak", async () => {
    /* THE POINT OF THIS ROUTE. A 404 here would mean the Houzs dispatcher
       cannot see the 2990 order they were asked to ship. Reaching the
       deliverability gate — the first rule AFTER the source read — proves the
       line was found. */
    const t = tables();
    const res = await postJson(harness(t, CO_A).app, '/delivery-orders-mfg/from-sos', {
      picks: [{ soItemId: 'soi-b', qty: 1 }],
    });
    expect(res.status).not.toBe(404);
    expect((await res.json() as Row).error).not.toBe('so_item_not_found');
  });

  test("the source read is NOT pinned to the ACTIVE company", async () => {
    /* The inverse of every other converter in this file, and the assertion that
       fails first if someone "fixes" this route by scoping it. */
    const t = tables();
    const h = harness(t, CO_A);
    await postJson(h.app, '/delivery-orders-mfg/from-sos', { picks: [{ soItemId: 'soi-b', qty: 1 }] });
    const pinnedToActive = h.log.filter((l) =>
      l.startsWith('mfg_sales_order_items.select') && l.includes(`eq:company_id:${CO_A}`));
    expect(pinnedToActive).toHaveLength(0);
  });

  test("A's own SO line IS found — it fails the NEXT rule instead", async () => {
    /* HC-SO-2608-001 is a DRAFT, so the deliverability gate refuses it. That gate
       runs AFTER the source read, so reaching it proves the line was visible. */
    const t = tables();
    const res = await postJson(harness(t, CO_A).app, '/delivery-orders-mfg/from-sos', {
      picks: [{ soItemId: 'soi-a', qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('so_not_deliverable');
    expect(t.delivery_orders).toHaveLength(0);
  });

  /* WHAT THIS HARNESS CANNOT PROVE, written down rather than faked.
     The fake PostgREST client logs `${table}.${op}:eq:${col}` — the COLUMN name
     and not the VALUE. So it can say whether a read carries a company predicate;
     it cannot say WHICH company that predicate names. For every other converter
     in this file that is enough, because there the question is binary: scoped or
     not. Here it is not — the source reads ARE scoped, to the SOURCE company,
     and a log line reading `eq:company_id` looks identical either way.

     Two attempts to assert it through the log failed for two different reasons:
     the first because a DRAFT fixture never reaches the header load at all (the
     assertion passed over an empty list, which is the "verdict computed over
     nothing" trap this repo keeps finding), the second because the value simply
     is not recorded.

     So the inherit DIRECTION is proved behaviourally above — B's line is
     reachable from A, and the read is not pinned to A — and the stamp itself is
     proved by `scripts/check-conversion-guards.mjs`, whose INHERIT kind fails if
     the source reads become active-scoped or if the handler stops resolving a
     `sourceCompanyId`. Both failure modes were driven and observed. A fixture
     rich enough to cut a whole DO (warehouses, stock, allocation) would prove it
     end to end and is the honest next step; this file does not pretend to. */

  test('an UNRESOLVED company degrades to allowed', async () => {
    /* Reaching the deliverability gate on a 2990 line is the proof: with no
       resolvable company, scopeToCompany adds no predicate and single-company
       Houzs keeps converting exactly as it did pre-migration. */
    const t = tables();
    const res = await postJson(harness(t, undefined).app, '/delivery-orders-mfg/from-sos', {
      picks: [{ soItemId: 'soi-b', qty: 1 }],
    });
    expect((await res.json() as Row).error).toBe('so_not_deliverable');
  });
});

/* ── DO -> DR ─────────────────────────────────────────────────────────────────
   A return writes stock back IN and re-opens the source SO, so a cross-company
   source moves the other company's inventory under this company's document. */
describe('DR convert-from-DO-lines cannot see a cross-company source', () => {
  const dos = (): Row[] => [
    { id: 'do-a', do_number: 'HC-DO-2608-001', company_id: CO_A, status: 'DISPATCHED', debtor_code: 'C1', debtor_name: 'Cust', currency: 'MYR' },
    { id: 'do-b', do_number: '2990-DO-2608-001', company_id: CO_B, status: 'DISPATCHED', debtor_code: 'C9', debtor_name: 'Other', currency: 'MYR' },
  ];
  const doItems = (): Row[] => [
    { id: 'doi-a', delivery_order_id: 'do-a', company_id: CO_A, item_code: 'M1', item_group: null, description: null, description2: null, uom: 'UNIT', qty: 2, unit_price_sen: 100, unit_cost_sen: 50, discount_sen: 0, variants: null, line_no: 0 },
    { id: 'doi-b', delivery_order_id: 'do-b', company_id: CO_B, item_code: 'M9', item_group: null, description: null, description2: null, uom: 'UNIT', qty: 2, unit_price_sen: 100, unit_cost_sen: 50, discount_sen: 0, variants: null, line_no: 0 },
  ];
  const tables = (): Record<string, Row[]> => ({
    delivery_orders: dos(), delivery_order_items: doItems(),
    delivery_returns: [], delivery_return_items: [], sales_invoice_items: [], sales_invoices: [],
  });

  test("B's delivery line is not visible to A — no return is created", async () => {
    const t = tables();
    const res = await postJson(harness(t, CO_A).app, '/delivery-returns/from-dos', {
      picks: [{ doItemId: 'doi-b', qty: 1 }],
    });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('do_item_not_found');
    expect(t.delivery_returns).toHaveLength(0);
  });

  test("A's own delivery line IS visible — its returnable remaining is derived", async () => {
    const t = tables();
    const res = await postJson(harness(t, CO_A).app, '/delivery-returns/from-dos', {
      picks: [{ doItemId: 'doi-a', qty: 99 }],
    });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('over_remaining');
    expect(t.delivery_returns).toHaveLength(0);
  });

  test('the source line read carries the company predicate', async () => {
    const t = tables();
    const h = harness(t, CO_A);
    await postJson(h.app, '/delivery-returns/from-dos', { picks: [{ doItemId: 'doi-a', qty: 99 }] });
    expect(h.log).toContain('delivery_order_items.select:eq:company_id');
  });

  test('an UNRESOLVED company degrades to allowed', async () => {
    const t = tables();
    const res = await postJson(harness(t, undefined).app, '/delivery-returns/from-dos', {
      picks: [{ doItemId: 'doi-b', qty: 1 }],
    });
    expect((await res.json() as Row).error).not.toBe('do_item_not_found');
  });
});

/* ── POST /:id/items — a MANUAL line on the other company's invoice ───────────
 *
 * The three other line verbs on this resource are strict
 * (`requireActiveCompanyId` + `scopeToCompanyId`); adding one resolved the header
 * by `id` alone. The insert then carried `company_id: activeCompanyId(c)`, which
 * is the FIFTH BLIND SPOT from CLAUDE.md in its purest form — a STAMP is not a
 * predicate. It wrote OUR company onto a line appended to THEIR invoice, and
 * everything downstream keys off that line: the totals recompute, the AR/GL
 * re-post, and the AutoCount outbox row is queued under the caller's company.
 *
 * Which is why the assertions below are not status-only. A 404 that still
 * inserted would pass a status check and be exactly as wrong.
 */
describe('SI manual line create is company-scoped', () => {
  const invoices = (): Row[] => [
    { id: 'si-a', invoice_number: 'HC-SI-2608-001', company_id: CO_A, status: 'DRAFT', total_sen: 0, delivery_order_id: null },
    { id: 'si-b', invoice_number: '2990-SI-2608-001', company_id: CO_B, status: 'DRAFT', total_sen: 0, delivery_order_id: null },
  ];
  const LINE = { itemCode: 'DELIVERY', description: 'Delivery fee', qty: 1, unitPriceSen: 5000 };

  test("A cannot append a line to B's invoice, and nothing is written", async () => {
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_items: [] };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-b/items', LINE);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found_in_company' });
    // The refusal has to be BEFORE the insert, not after it.
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test("B cannot append a line to A's invoice either — the gate is not one-sided", async () => {
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_items: [] };
    const res = await postJson(harness(t, CO_B).app, '/sales-invoices/si-a/items', LINE);
    expect(res.status).toBe(404);
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test('a company CAN still append to its own invoice — the sweep must not lock anyone out', async () => {
    const t: Record<string, Row[]> = {
      sales_invoices: invoices(),
      sales_invoice_items: [],
      // validateItemCodes reads mfg_products scoped to the caller's company.
      mfg_products: [{ code: 'DELIVERY', status: 'ACTIVE', company_id: CO_A }],
    };
    const res = await postJson(harness(t, CO_A).app, '/sales-invoices/si-a/items', LINE);
    // Not 404. The handler may still refuse for a business reason further down,
    // but it must get PAST the company gate, which is what this file is about.
    expect(res.status).not.toBe(404);
  });

  test('an UNRESOLVED company refuses rather than falling through to every invoice', async () => {
    // requireActiveCompanyId is the strict helper: no company context is a 409,
    // not a pass. The permissive scopeToCompany would degrade here, and on a
    // money write that degradation is the bug.
    const t: Record<string, Row[]> = { sales_invoices: invoices(), sales_invoice_items: [] };
    const res = await postJson(harness(t, undefined).app, '/sales-invoices/si-b/items', LINE);
    expect(res.status).toBe(409);
    expect(t.sales_invoice_items).toHaveLength(0);
  });
});
