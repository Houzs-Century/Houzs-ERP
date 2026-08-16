/* POST /sales-invoices — what the AutoCount outbox is told about the invoice.
 *
 * THE DEFECT THESE TESTS WERE WRITTEN AGAINST. The handler called
 * recordParentlessCreate unconditionally, with `missing: 'no source Delivery
 * Order'`, while accepting a source on both halves of the document —
 * `deliveryOrderId` on the header and `doItemId` on every line. The desktop
 * "invoice from a delivery order" flow sends both (SalesInvoiceFromDo ->
 * SalesInvoiceNew -> POST /), so a desktop invoice raised FROM a delivery order
 * was recorded as ERP-only and never enqueued, while the mobile surface went
 * through POST /from-dos and was correct. HC-SI-2608-001 is the live one, and a
 * skipped TRANSFER row is not re-queueable — so it can never reach the account
 * book at all.
 *
 * The first test below FAILS on that code: the row it finds is `skipped`
 * reading "created with no source Delivery Order", not a queued `do_to_iv`.
 *
 * Harness copied from companyScopeSalesInvoiceMoney.test.ts — a bare Hono app
 * whose middleware injects a fake scm supabase client plus a company context,
 * mounting the EXPORTED handler because the supabaseAuth bridge cannot run
 * here. Two additions that file did not need: an insert has to hand back an
 * `id` (the whole create path threads it), and a head/count select has to
 * answer a count (conversionIsPartial asks for one).
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { createSalesInvoiceHandler } from '../src/scm/routes/sales-invoices';
import { resetWritebackFlagCache } from '../src/scm/lib/autocount-writeback-flag';
import { classifyAcSkip } from '../src/scm/lib/autocount-outbox-status';

const CO_A = 1;

type Row = Record<string, any>;

let idSeq = 0;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private headCount = false;
  constructor(private rows: Row[], private table: string, private log: string[]) {}
  select(_cols?: unknown, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.headCount = true;
    return this;
  }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    const list = Array.isArray(p) ? p : [p];
    idSeq += 1;
    this.inserted = list.map((r, i) => ({ id: `gen-${idSeq}-${i}`, ...r }));
    return this;
  }
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
    const hit = this.run();
    const payload = this.headCount
      ? { data: null, error: null, count: hit.length }
      : { data: hit, error: null, count: hit.length };
    return Promise.resolve(payload).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO_A as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('companies' as never, [{ id: CO_A, code: 'HOUZS', name: 'Houzs Century' }] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/sales-invoices', createSalesInvoiceHandler as never);
  return { app, log };
}

const doHeader = (id: string, number: string): Row => ({
  id, do_number: number, company_id: CO_A, status: 'SHIPPED',
  debtor_code: 'C1', debtor_name: 'Cust', currency: 'MYR', so_doc_no: null,
});

const doLine = (id: string, doId: string, code: string): Row => ({
  id, delivery_order_id: doId, company_id: CO_A, item_code: code, item_group: null,
  description: null, description2: null, uom: 'UNIT', qty: 5,
  unit_price_centi: 1000, unit_cost_centi: 500, discount_centi: 0, variants: null,
  line_no: 0, linked_ac_dtlkey: Number(id.replace(/\D/g, '') || 1) + 1000,
});

/* The write-back switch is a live app_config row, off by default. Every test
   below is about what the ERP DECIDES to queue, so it is on here. */
const baseTables = (): Record<string, Row[]> => ({
  app_config: [{ key: 'scm.autocount_writeback', value: 'all' }],
  mfg_products: [
    { code: 'M1', status: 'ACTIVE', company_id: CO_A },
    { code: 'M2', status: 'ACTIVE', company_id: CO_A },
    { code: 'ADHOC', status: 'ACTIVE', company_id: CO_A },
  ],
  delivery_orders: [doHeader('do-a', 'HC-DO-2608-001'), doHeader('do-b', 'HC-DO-2608-002')],
  delivery_order_items: [doLine('doi-a', 'do-a', 'M1'), doLine('doi-b', 'do-b', 'M2')],
  sales_invoices: [],
  sales_invoice_items: [],
  delivery_return_items: [],
  delivery_returns: [],
  autocount_outbox: [],
});

const line = (code: string, doItemId: string | null): Row => ({
  itemCode: code, qty: 1, unitPriceCenti: 1000, unitCostCenti: 500, uom: 'UNIT',
  ...(doItemId ? { doItemId } : {}),
});

const create = (app: Hono, body: Row) =>
  app.request('/sales-invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /* asDraft short-circuits revenue posting and customer credit, neither of
       which this file is about. The outbox decision is written BEFORE that
       early return, deliberately — a draft and a posted invoice each record
       exactly one row. */
    body: JSON.stringify({ debtorName: 'Cust', asDraft: true, ...body }),
  });

const outboxFor = (t: Record<string, Row[]>) => t.autocount_outbox ?? [];

beforeEach(() => { resetWritebackFlagCache(); });

describe('an invoice raised FROM a delivery order is enqueued, not recorded parentless', () => {
  test('THE BUG: one source DO, every line linked — a do_to_iv is QUEUED', async () => {
    const t = baseTables();
    const res = await create(harness(t).app, {
      deliveryOrderId: 'do-a',
      items: [line('M1', 'doi-a')],
    });
    expect(res.status).toBe(201);

    const rows = outboxFor(t);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.op).toBe('do_to_iv');
    /* The assertion that fails on the old code: it wrote status 'skipped' with
       last_error "created with no source Delivery Order, so there is no source
       document to transfer from." */
    expect(row.status).toBe('pending');
    expect(row.last_error).toBeNull();
    expect(row.doc_type).toBe('IV');
    expect(row.payload.fromDoc).toEqual({ table: 'delivery_orders', keyCol: 'id', key: 'do-a' });
    expect(row.payload.writeback.table).toBe('sales_invoices');
  });

  test('the queued transfer NAMES the source line, so AutoCount cannot take the rest of the DO', async () => {
    /* Omitting DtlKeys makes AcSyncService transfer every still-outstanding
       line on the parent. The DO here has one line and the invoice took it, so
       the keys are nameable and must be sent. */
    const t = baseTables();
    await create(harness(t).app, { deliveryOrderId: 'do-a', items: [line('M1', 'doi-a')] });
    expect(outboxFor(t)[0]!.payload.body.DtlKeys).toEqual([1001]);
  });

  test('the header link alone is not required — the LINE links are what decide it', async () => {
    /* A caller that sends only per-line doItemIds (no header deliveryOrderId)
       still has a source, and the old code called that parentless too. */
    const t = baseTables();
    await create(harness(t).app, { items: [line('M1', 'doi-a')] });
    const row = outboxFor(t)[0]!;
    expect(row.op).toBe('do_to_iv');
    expect(row.status).toBe('pending');
  });
});

describe('the claim is CHECKED — the three shapes that genuinely cannot transfer', () => {
  test('no source at all is still recorded parentless, with the same words', async () => {
    const t = baseTables();
    await create(harness(t).app, { items: [line('ADHOC', null)] });
    const row = outboxFor(t)[0]!;
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('created with no source Delivery Order');
    expect(classifyAcSkip(row.last_error).kind).toBe('no-source-document');
  });

  test('lines from SEVERAL delivery orders are recorded as a merged conversion', async () => {
    const t = baseTables();
    await create(harness(t).app, { items: [line('M1', 'doi-a'), line('M2', 'doi-b')] });
    const row = outboxFor(t)[0]!;
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('HC-DO-2608-001, HC-DO-2608-002');
    /* Verbatim the phrase /from-dos writes — it is the needle that classifies a
       merged conversion, and a reworded twin lands on the owner's page as
       `unrecognised` with no remedy. */
    expect(classifyAcSkip(row.last_error).kind).toBe('no-autocount-shape');
  });

  test('a linked line beside a standalone line is refused, and says which line', async () => {
    /* The ERP allows a standalone line on an invoice; AutoCount's transfer
       would produce an invoice MISSING it and understate the revenue in a live
       book. Refused with a named remedy rather than approximated. */
    const t = baseTables();
    await create(harness(t).app, { deliveryOrderId: 'do-a', items: [line('M1', 'doi-a'), line('ADHOC', null)] });
    const row = outboxFor(t)[0]!;
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('ADHOC');
    expect(row.last_error).toContain('1 of 2 line(s)');
    expect(classifyAcSkip(row.last_error).kind).toBe('mixed-source-lines');
  });

  test('a header link with no line taken from it does not claim "no source Delivery Order"', async () => {
    /* Nothing to transfer either way — but the sentence has to be true, which
       is the whole subject of this file. */
    const t = baseTables();
    await create(harness(t).app, { deliveryOrderId: 'do-a', items: [line('ADHOC', null)] });
    const row = outboxFor(t)[0]!;
    expect(row.status).toBe('skipped');
    expect(row.last_error).toContain('not one line taken from it');
    expect(classifyAcSkip(row.last_error).kind).toBe('no-source-document');
  });
});

describe('exactly one outbox row per created invoice, whatever the shape', () => {
  test('a DRAFT records one row and a POSTED invoice records one row', async () => {
    const t = baseTables();
    await create(harness(t).app, { deliveryOrderId: 'do-a', items: [line('M1', 'doi-a')] });
    expect(outboxFor(t)).toHaveLength(1);
  });
});
