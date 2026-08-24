/* THE CALLERS, not the library — a blip on the Pending ledger must not be able
 * to mint a document.
 *
 * lib/do-line-remaining.failclosed.test.ts proves the ledger itself now refuses.
 * That is only half the claim: the defect was never in the arithmetic, it was in
 * what each caller DID with a ledger that came back empty. remaining =
 * delivered − invoiced − returned, so an unreadable `invoiced` made every
 * already-invoiced line read as fully available and every one of these four
 * money doors opened at the full delivered quantity.
 *
 * So each test here drives the REAL exported handler with one table's SELECT
 * failing, and asserts two things — the refusal, and that the tables are
 * untouched. The second is the one that matters: a 500 that still wrote the
 * invoice would pass a status assertion and lose the money anyway.
 *
 * WHAT THE REFUSAL SAYS. 503 `remaining_check_failed`, never 409
 * `over_remaining` and never `race_conflict`. The operator did not ask for too
 * much and no colleague raced them; the check could not run. A gate may only
 * fail somebody for something they could have caused.
 *
 * Harness copied from companyScopeSalesInvoiceMoney.test.ts — a bare Hono app
 * whose middleware injects a fake scm client, mounting the exported handlers
 * because the supabaseAuth bridge cannot run here.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  createSalesInvoiceHandler,
  createSalesInvoiceFromDoLinesHandler,
  appendDoLinesToSalesInvoiceHandler,
  patchSalesInvoiceStatusHandler,
} from '../src/scm/routes/sales-invoices';
import { convertDoLinesToReturn } from '../src/scm/routes/delivery-returns';

const CO = 1;
type Row = Record<string, any>;

const BLIP = { message: 'connection terminated unexpectedly' };

/* Permissive fake PostgREST builder. `failing` names tables whose SELECTs
   resolve `{ data: null, error }`; writes still work, so a test can prove that
   the handler wrote nothing rather than that writing was impossible.
   `failSelectFrom` delays the failure to the Nth select on that table, which is
   how the POST-INSERT recheck is reached: the pre-check has to succeed first or
   the handler refuses before anything exists to roll back. */
type FailSpec = { failing?: string[]; failSelectFrom?: Record<string, number> };

function makeClient(tables: Record<string, Row[]>, spec: FailSpec) {
  const fail = new Set(spec.failing ?? []);
  const from = spec.failSelectFrom ?? {};
  const selectCount: Record<string, number> = {};

  class FakeQuery {
    private preds: Array<(r: Row) => boolean> = [];
    private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
    private patch: Row = {};
    private inserted: Row[] = [];
    constructor(private rows: Row[], private table: string) {}
    select() { return this; }
    order() { return this; }
    limit() { return this; }
    range() { return this; }
    ilike() { return this; }
    update(p: Row) { this.op = 'update'; this.patch = p; return this; }
    delete() { this.op = 'delete'; return this; }
    insert(p: Row | Row[]) {
      this.op = 'insert';
      /* Stand in for the table's `id uuid DEFAULT gen_random_uuid()` so the
         handler has a header id to roll back with. */
      this.inserted = (Array.isArray(p) ? p : [p]).map((r, i) => ({
        id: r.id ?? `gen-${this.table}-${this.rows.length + i}`,
        ...r,
      }));
      return this;
    }
    upsert(p: Row | Row[]) { return this.insert(p); }
    eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
    neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
    in(col: string, vals: unknown[]) {
      const s = new Set((vals ?? []).map(String));
      this.preds.push((r) => s.has(String(r[col])));
      return this;
    }
    gte() { return this; } lte() { return this; } gt() { return this; }
    not() { return this; } like() { return this; } is() { return this; } or() { return this; }

    /** null when this read is the one the test is failing. */
    private blip(): { message: string } | null {
      if (this.op !== 'select') return null;
      if (fail.has(this.table)) return BLIP;
      const nth = from[this.table];
      if (nth === undefined) return null;
      selectCount[this.table] = (selectCount[this.table] ?? 0) + 1;
      return selectCount[this.table] >= nth ? BLIP : null;
    }

    private run(): Row[] {
      if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
      const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
      if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
      return hit;
    }
    maybeSingle() {
      const e = this.blip();
      if (e) return Promise.resolve({ data: null, error: e });
      return Promise.resolve({ data: this.run()[0] ?? null, error: null });
    }
    single() {
      const e = this.blip();
      if (e) return Promise.resolve({ data: null, error: e });
      const h = this.run();
      return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
    }
    then(res: (v: any) => any, rej?: (e: any) => any) {
      const e = this.blip();
      if (e) return Promise.resolve({ data: null, error: e }).then(res, rej);
      return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
    }
  }
  return {
    from: (t: string) => new FakeQuery((tables[t] ||= []), t),
    rpc: async () => ({ data: true, error: null }),
  };
}

function harness(tables: Record<string, Row[]>, spec: FailSpec = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, makeClient(tables, spec) as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS', name: 'Houzs Century' }] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/sales-invoices', createSalesInvoiceHandler as never);
  app.post('/sales-invoices/from-dos', createSalesInvoiceFromDoLinesHandler as never);
  app.post('/sales-invoices/:id/items/from-do/:doId', appendDoLinesToSalesInvoiceHandler as never);
  app.patch('/sales-invoices/:id/status', patchSalesInvoiceStatusHandler as never);
  app.post('/delivery-returns/from-dos', convertDoLinesToReturn as never);
  return app;
}

const postJson = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const patchJson = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

/* ONE shipped delivery line of 10, already invoiced in full. The honest ceiling
   is 0. Every test below asks for 10 more — a request the ledger refuses when it
   can be read, and used to WAVE THROUGH when it could not. */
const tables = (): Record<string, Row[]> => ({
  delivery_orders: [{
    id: 'do-1', company_id: CO, do_number: 'HC-DO-2608-001', status: 'DISPATCHED',
    debtor_code: 'C1', debtor_name: 'Cust', currency: 'MYR', migrated_no_stock: false,
  }],
  delivery_order_items: [{
    id: 'dl-1', delivery_order_id: 'do-1', company_id: CO, item_code: 'ITEM-1',
    item_group: null, description: null, description2: null, uom: 'UNIT',
    qty: 10, unit_price_sen: 100, unit_cost_sen: 50, discount_sen: 0,
    variants: null, line_no: 0,
  }],
  sales_invoices: [
    { id: 'si-old', company_id: CO, status: 'SENT', invoice_number: 'HC-SI-2608-001' },
    /* A DRAFT destination for the append path — a SENT invoice refuses line
       edits outright (`invoice_issued`) long before any ceiling is consulted. */
    { id: 'si-draft', company_id: CO, status: 'DRAFT', invoice_number: 'HC-SI-2608-002' },
  ],
  sales_invoice_items: [{ id: 'sii-old', sales_invoice_id: 'si-old', company_id: CO, do_item_id: 'dl-1', qty: 10 }],
  delivery_returns: [],
  delivery_return_items: [],
  mfg_products: [{ code: 'ITEM-1', company_id: CO, status: 'ACTIVE' }],
});

const body = async (res: Response) => (await res.json()) as Row;

describe('DO -> Sales Invoice refuses when the Pending ledger cannot be read', () => {
  test('CONTROL: with the ledger readable, a 10-unit pick on a fully-invoiced line is refused as over_remaining', async () => {
    /* Proves the fixture actually reaches the ceiling. Without it, a 503 below
       could be coming from anywhere in the handler. */
    const t = tables();
    const res = await postJson(harness(t), '/sales-invoices/from-dos', { picks: [{ doItemId: 'dl-1', qty: 10 }] });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('over_remaining');
    expect(t.sales_invoices).toHaveLength(2); // only the two pre-existing ones
  });

  test('POST /from-dos refuses 503 and mints no invoice when `invoiced` is unreadable', async () => {
    const t = tables();
    const res = await postJson(
      harness(t, { failing: ['sales_invoice_items'] }),
      '/sales-invoices/from-dos',
      { picks: [{ doItemId: 'dl-1', qty: 10 }] },
    );
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe('remaining_check_failed');
    // The whole point: no second invoice for goods already billed.
    expect(t.sales_invoices).toHaveLength(2);
    expect(t.sales_invoice_items).toHaveLength(1);
  });

  test('POST / refuses 503 on a DO-linked line when the write cap cannot be derived', async () => {
    const t = tables();
    const res = await postJson(
      harness(t, { failing: ['sales_invoice_items'] }),
      '/sales-invoices',
      { debtorName: 'Cust', items: [{ itemCode: 'ITEM-1', doItemId: 'dl-1', qty: 10, unitPriceSen: 100 }] },
    );
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe('remaining_check_failed');
    expect(t.sales_invoices).toHaveLength(2);
  });

  test('POST /:id/items/from-do/:doId appends nothing rather than reporting a fully-billed delivery', async () => {
    /* This path used to answer 200 with zero appended lines — the shape of a
       delivery that has already been invoiced in full. Indistinguishable, on
       screen, from success. */
    const t = tables();
    const res = await postJson(
      harness(t, { failing: ['sales_invoice_items'] }),
      '/sales-invoices/si-draft/items/from-do/do-1',
    );
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe('remaining_check_failed');
    expect(t.sales_invoice_items).toHaveLength(1);
  });
});

describe('DO -> Delivery Return refuses when the Pending ledger cannot be read', () => {
  test('CONTROL: with the ledger readable, returning 10 already-invoiced units is refused', async () => {
    const t = tables();
    const res = await postJson(harness(t), '/delivery-returns/from-dos', {
      picks: [{ doItemId: 'dl-1', qty: 10 }],
    });
    expect(res.status).toBe(409);
    expect(t.delivery_returns).toHaveLength(0);
  });

  test('convert-from-DO refuses 503 and creates no return when `returned` is unreadable', async () => {
    const t = tables();
    const res = await postJson(
      harness(t, { failing: ['delivery_return_items'] }),
      '/delivery-returns/from-dos',
      { picks: [{ doItemId: 'dl-1', qty: 10 }] },
    );
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe('remaining_check_failed');
    /* No return row means no `increaseInventoryForReturn` either — stock is not
       credited for goods that never came back. */
    expect(t.delivery_returns).toHaveLength(0);
    expect(t.delivery_return_items).toHaveLength(0);
  });
});

/* THE POST-INSERT RACE RECHECK — the second half of every convert.
 *
 * The pre-check is read-before-write, so two operators invoicing the same
 * delivery at the same instant can both pass it. Each convert therefore
 * re-derives the ledger AFTER inserting and rolls back when a line has gone
 * negative. That recheck is a read like any other, and when it failed the guard
 * did not degrade — it switched off, which is the exact sentence #2374 was
 * written about.
 *
 * WHY ROLL BACK RATHER THAN KEEP THE DOCUMENT. At this point nothing has
 * escaped: no revenue is posted, no stock has moved, no other document
 * references the header. Undoing therefore costs the operator a keystroke and
 * costs the business nothing, whereas keeping an invoice whose ceiling could not
 * be verified is the double-bill this whole file exists to prevent.
 *
 * WHY NOT UNDER `race_conflict`. Nobody raced them. Telling an operator that a
 * colleague just took the quantity — when the truth is that a read timed out —
 * sends them hunting for a duplicate that does not exist, and blames a person
 * for a database event. The 503 says what actually happened.
 */
const UNCONSUMED = (): Record<string, Row[]> => {
  const t = tables();
  t.sales_invoices = [{ id: 'si-old', company_id: CO, status: 'SENT', invoice_number: 'HC-SI-2608-001' }];
  t.sales_invoice_items = [];   // nothing invoiced yet -> the pre-check passes
  return t;
};

describe('the post-insert race recheck rolls back rather than keeping an unverified document', () => {
  test('CONTROL: the same request SUCCEEDS when every read works — so the rollback cases really do insert first', async () => {
    /* Without this, a 503 in the next test could be the PRE-check failing and
       the rollback path never being entered at all: the tables would look
       identical either way, and the test would be asserting nothing. */
    const t = UNCONSUMED();
    const res = await postJson(harness(t), '/sales-invoices/from-dos', { picks: [{ doItemId: 'dl-1', qty: 5 }] });
    expect(res.status).toBe(201);
    expect(t.sales_invoices).toHaveLength(2);
    expect(t.sales_invoice_items).toHaveLength(1);
  });

  test('SI /from-dos: pre-check passes, recheck cannot run, and no invoice survives', async () => {
    const t = UNCONSUMED();
    /* Fail from the SECOND select onward: the pre-check has to succeed or there
       would be nothing inserted to roll back, which would prove nothing. */
    const res = await postJson(
      harness(t, { failSelectFrom: { sales_invoice_items: 2 } }),
      '/sales-invoices/from-dos',
      { picks: [{ doItemId: 'dl-1', qty: 5 }] },
    );
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.error).toBe('remaining_check_failed');
    expect(b.error).not.toBe('race_conflict');
    // Header AND lines undone — only the pre-existing invoice is left.
    expect(t.sales_invoices.map((r) => r.id)).toEqual(['si-old']);
    expect(t.sales_invoice_items).toHaveLength(0);
  });

  test('CONTROL: the same DR request SUCCEEDS when every read works', async () => {
    const t = UNCONSUMED();
    const res = await postJson(harness(t), '/delivery-returns/from-dos', { picks: [{ doItemId: 'dl-1', qty: 5 }] });
    expect(res.status).toBe(201);
    expect(t.delivery_returns).toHaveLength(1);
    expect(t.delivery_return_items).toHaveLength(1);
  });

  test('DR /from-dos: pre-check passes, recheck cannot run, and no return survives', async () => {
    const t = UNCONSUMED();
    const res = await postJson(
      harness(t, { failSelectFrom: { delivery_return_items: 2 } }),
      '/delivery-returns/from-dos',
      { picks: [{ doItemId: 'dl-1', qty: 5 }] },
    );
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe('remaining_check_failed');
    /* No surviving return means increaseInventoryForReturn never ran either —
       stock is not credited for goods that were never proved to have come back. */
    expect(t.delivery_returns).toHaveLength(0);
    expect(t.delivery_return_items).toHaveLength(0);
  });
});

/* THE FIFTH DOOR — REOPEN, and the sixth, APPEND.
 *
 * Both were left half-closed by the first pass on this branch, and both fail in
 * the direction that costs money rather than the direction that costs a retry.
 *
 * REOPEN reads its own line list to work out what the cancelled invoice would
 * re-consume, then hands that list to checkSiOverRemaining — which begins
 * `if (wanted.size === 0) return null`. So an unreadable read produced an EMPTY
 * list, the ceiling was never consulted at all, and the 503 branch sitting two
 * lines below it could not be reached. The invoice went back to SENT and
 * postSiRevenue re-posted AR/GL for goods a second invoice had already billed.
 *
 * APPEND has the same shape one table earlier: zero candidate DO lines is
 * indistinguishable from "every line is already billed", and the handler says
 * exactly that — 409 `do_fully_invoiced` — to a caller whose read simply failed.
 * A caller that writes that down has unbilled deliveries recorded as billed.
 */
const CANCELLED_AGAINST_A_CONSUMED_LINE = (): Record<string, Row[]> => {
  const t = tables();
  /* si-old (SENT) already consumes all 10 delivered units. si-cxl is the
     cancelled invoice for the SAME delivered line — reopening it would bill
     those 10 units a second time. */
  t.sales_invoices.push({
    id: 'si-cxl', company_id: CO, status: 'CANCELLED', invoice_number: 'HC-SI-2608-003',
  });
  t.sales_invoice_items.push({
    id: 'sii-cxl', sales_invoice_id: 'si-cxl', company_id: CO, do_item_id: 'dl-1', qty: 10,
  });
  return t;
};

describe('reopening a cancelled invoice refuses when the Pending ledger cannot be read', () => {
  test('CONTROL: with every read working, the reopen is refused 409 over_remaining and the invoice stays CANCELLED', async () => {
    const t = CANCELLED_AGAINST_A_CONSUMED_LINE();
    const res = await patchJson(harness(t), '/sales-invoices/si-cxl/status', { status: 'SENT' });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('over_remaining');
    expect(t.sales_invoices.find((r) => r.id === 'si-cxl')?.status).toBe('CANCELLED');
  });

  test('the reopen refuses 503 — not 200 — when its own line list is unreadable', async () => {
    /* THE REGRESSION THIS PINS. Before the fix this returned 200 with
       {"salesInvoice":{"status":"SENT"}}: the empty line list short-circuited
       the ceiling check, so the guard did not degrade, it switched off. */
    const t = CANCELLED_AGAINST_A_CONSUMED_LINE();
    const res = await patchJson(
      harness(t, { failing: ['sales_invoice_items'] }),
      '/sales-invoices/si-cxl/status',
      { status: 'SENT' },
    );
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.error).toBe('remaining_check_failed');
    // Nobody raced them and nobody asked for too much — the check could not run.
    expect(b.error).not.toBe('over_remaining');
    // The money assertion: still cancelled, so no revenue was re-posted.
    expect(t.sales_invoices.find((r) => r.id === 'si-cxl')?.status).toBe('CANCELLED');
  });
});

describe('appending a delivery refuses rather than calling it fully invoiced', () => {
  test('CONTROL: with every read working, an unconsumed delivery really does append', async () => {
    /* Without this the 503 below could be any earlier refusal on the path, and
       the test would prove nothing about the DO-line read at all. */
    const t = UNCONSUMED();
    t.sales_invoices.push({
      id: 'si-draft', company_id: CO, status: 'DRAFT', invoice_number: 'HC-SI-2608-002',
    });
    const res = await postJson(harness(t), '/sales-invoices/si-draft/items/from-do/do-1');
    expect(res.status).toBe(201);
    expect(t.sales_invoice_items).toHaveLength(1);
  });

  test('an unreadable DO-line list answers 503, never 409 do_fully_invoiced', async () => {
    const t = UNCONSUMED();
    t.sales_invoices.push({
      id: 'si-draft', company_id: CO, status: 'DRAFT', invoice_number: 'HC-SI-2608-002',
    });
    const res = await postJson(
      harness(t, { failing: ['delivery_order_items'] }),
      '/sales-invoices/si-draft/items/from-do/do-1',
    );
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.error).toBe('remaining_check_failed');
    /* The sentence that used to come back. A caller acting on it records
       delivered-but-unbilled goods as billed. */
    expect(b.error).not.toBe('do_fully_invoiced');
    expect(t.sales_invoice_items).toHaveLength(0);
  });
});
