// Company scoping on the WRITE paths closed in this pass (audit PR #826, items
// 3-9). Sibling of companyWriteScope.test.ts, which covers items 1-2 (PR #841).
//
// Driven end-to-end through a bare Hono app whose middleware injects a fake scm
// supabase client + a company context, mounting the EXPORTED handlers rather
// than the routers — the supabaseAuth bridge cannot run in this harness. Same
// approach as fairReport.route.test.ts.
//
// EVERY item is asserted in BOTH directions, deliberately. The failure mode of
// a scope sweep is not "the leak stayed open", it is "we hid a company's own
// data from its own users" — an outage nobody reports, because you cannot
// report data you cannot see. So each leak test is paired with a same-company
// test proving the legitimate request still works, and each cross-company test
// also asserts the victim row was left UNCHANGED (a 404 that still mutated
// would pass a status-only assertion).
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { postGrnHandler } from '../src/scm/routes/grns';
import { cancelPaymentVoucherHandler, postPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';
import { postStockTakeHandler } from '../src/scm/routes/stock-takes';
import { postPurchaseInvoiceHandler } from '../src/scm/routes/purchase-invoices';
import { patchSalesInvoiceStatusHandler } from '../src/scm/routes/sales-invoices';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder. The handlers under test reach far past the
   statement being asserted (audit probes, rollups, movement writes), so every
   builder method chains and an unknown table reads as empty rather than
   throwing — the assertions are about the company predicate, not the rest. */
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
      /* `.schema('public')` — the real client returns one scoped to that schema.
         These stubs model ONE table namespace, so it returns the stub itself.
         Needed because jePrefixForCompany reads `public.companies` while the SCM
         client is pinned to `scm`; without it the stub throws
         `sb.schema is not a function` and the handler 500s. See docs/bugs/0522. */
      schema(_s: string) { return this; },

      // The entity-audit pre-flight probe. Reports writable so the handlers get
      // past it to the statement under test; without it every one of them 409s
      // on an unreachable audit sink and the scope assertions never run.
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/grns/:id/post', postGrnHandler as never);
  app.post('/payment-vouchers/:id/cancel', cancelPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/post', postPaymentVoucherHandler as never);
  app.patch('/stock-takes/:id/post', postStockTakeHandler as never);
  app.patch('/purchase-invoices/:id/post', postPurchaseInvoiceHandler as never);
  app.patch('/sales-invoices/:id/status', patchSalesInvoiceStatusHandler as never);
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return { app, log };
}

const jsonPatch = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// ── Item 3 — grns.ts: posts stock IN against another company's GRN ───────────
describe('item 3 — GRN confirm (writes inventory IN + rolls up the PO)', () => {
  const grns = (): Row[] => [
    { id: 'g-a', grn_number: 'GRN-A-1', company_id: CO_A, status: 'DRAFT', warehouse_id: 'w1', total_sen: 100 },
    { id: 'g-b', grn_number: 'GRN-B-1', company_id: CO_B, status: 'DRAFT', warehouse_id: 'w9', total_sen: 500 },
  ];

  test('A cannot confirm B\'s GRN, and B\'s GRN stays DRAFT', async () => {
    const t = { grns: grns() };
    const res = await jsonPatch(harness(t, CO_A).app, '/grns/g-b/post');
    expect(res.status).toBe(404);
    // The row itself must be untouched — a refusal that still posted would be
    // invisible to a status-only assertion.
    expect(t.grns.find((g) => g.id === 'g-b')!.status).toBe('DRAFT');
    expect(t.grns.find((g) => g.id === 'g-b')!.posted_at).toBeUndefined();
  });

  test('A CAN still confirm its own GRN', async () => {
    const t = { grns: grns() };
    const res = await jsonPatch(harness(t, CO_A).app, '/grns/g-a/post');
    expect(res.status).toBe(200);
    expect(t.grns.find((g) => g.id === 'g-a')!.status).toBe('POSTED');
  });

  test('an unresolved company refuses rather than posting across all companies', async () => {
    const t = { grns: grns() };
    const res = await jsonPatch(harness(t, undefined).app, '/grns/g-a/post');
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.grns.every((g) => g.status === 'DRAFT')).toBe(true);
  });
});

// ── Item 4 — payment-vouchers.ts: cancels + reverses another company's GL ────
describe('item 4 — PV cancel (reverses the GL entry)', () => {
  const pvs = (): Row[] => [
    { id: 'pv-a', pv_number: 'PV-A-1', company_id: CO_A, status: 'POSTED', purpose: 'FREIGHT' },
    { id: 'pv-b', pv_number: 'PV-B-1', company_id: CO_B, status: 'POSTED', purpose: 'FREIGHT' },
  ];

  test('A cannot cancel B\'s voucher, and B\'s voucher stays POSTED', async () => {
    const t = { payment_vouchers: pvs() };
    const res = await harness(t, CO_A).app.request('/payment-vouchers/pv-b/cancel', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(t.payment_vouchers.find((p) => p.id === 'pv-b')!.status).toBe('POSTED');
  });

  test('A CAN still cancel its own voucher', async () => {
    const t = { payment_vouchers: pvs() };
    const res = await harness(t, CO_A).app.request('/payment-vouchers/pv-a/cancel', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(t.payment_vouchers.find((p) => p.id === 'pv-a')!.status).toBe('CANCELLED');
  });
});

/* ── Item 4b — PV POST: the OTHER half of the same door ───────────────────────
   Item 4 above hardened the CANCEL. The POST was left unscoped and stayed that
   way until 2026-08-13, because it is registered by name
   (`paymentVouchers.post('/:id/post', postPaymentVoucherHandler)`) and the
   scope checker's named-handler resolution was silently dead — a lost backslash
   made its regex unmatchable, so it scanned the wrong function body and
   reported nothing here. Posting writes a balanced journal entry into the
   voucher's company ledger, so this is the money half. */
describe('item 4b — PV post (writes the GL entry)', () => {
  /* approved_at: this suite tests COMPANY SCOPE, so both vouchers arrive
     already through the phase-3 queue — the approval gate itself is
     tests/pvApproval.test.ts's contract. */
  const pvs = (): Row[] => [
    { id: 'pv-a', pv_number: 'PV-A-2', company_id: CO_A, status: 'DRAFT', total_sen: 100, credit_account_code: '1000', voucher_date: '2026-08-13', payee_name: 'A', currency: 'MYR', exchange_rate: 1, approved_at: '2026-08-13T01:00:00Z', approved_by: 'T' },
    { id: 'pv-b', pv_number: 'PV-B-2', company_id: CO_B, status: 'DRAFT', total_sen: 900, credit_account_code: '1000', voucher_date: '2026-08-13', payee_name: 'B', currency: 'MYR', exchange_rate: 1, approved_at: '2026-08-13T01:00:00Z', approved_by: 'T' },
  ];
  const lines = (): Row[] => [
    { pv_id: 'pv-a', line_no: 1, description: 'a', debit_account_code: '5000', amount_sen: 100 },
    { pv_id: 'pv-b', line_no: 1, description: 'b', debit_account_code: '5000', amount_sen: 900 },
  ];

  test("A cannot post B's voucher — it stays DRAFT and writes NO journal entry", async () => {
    const t = { payment_vouchers: pvs(), payment_voucher_lines: lines(), journal_entries: [] as Row[] };
    const res = await harness(t, CO_A).app.request('/payment-vouchers/pv-b/post', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(t.payment_vouchers.find((p) => p.id === 'pv-b')!.status).toBe('DRAFT');
    // The row status alone would not catch a refusal that still touched the GL.
    expect(t.journal_entries).toHaveLength(0);
  });

  test('A CAN still post its own voucher', async () => {
    const t = { payment_vouchers: pvs(), payment_voucher_lines: lines(), journal_entries: [] as Row[] };
    const res = await harness(t, CO_A).app.request('/payment-vouchers/pv-a/post', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(t.payment_vouchers.find((p) => p.id === 'pv-a')!.status).toBe('POSTED');
  });

  test('an unresolved company refuses rather than posting across all companies', async () => {
    const t = { payment_vouchers: pvs(), payment_voucher_lines: lines(), journal_entries: [] as Row[] };
    const res = await harness(t, undefined).app.request('/payment-vouchers/pv-a/post', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(t.payment_vouchers.every((p) => p.status === 'DRAFT')).toBe(true);
  });
});

// ── Item 5 — stock-takes.ts: writes inventory movements ──────────────────────
describe('item 5 — stock take post (writes ADJUSTMENT movements)', () => {
  const takes = (): Row[] => [
    { id: 'st-a', take_no: 'STK-A-1', company_id: CO_A, status: 'OPEN', warehouse_id: 'w1' },
    { id: 'st-b', take_no: 'STK-B-1', company_id: CO_B, status: 'OPEN', warehouse_id: 'w9' },
  ];

  test('A cannot post B\'s stock take, and no movement is written', async () => {
    const t: Record<string, Row[]> = { stock_takes: takes(), inventory_movements: [] };
    const res = await jsonPatch(harness(t, CO_A).app, '/stock-takes/st-b/post');
    expect(res.status).toBe(404);
    expect(t.stock_takes.find((s) => s.id === 'st-b')!.status).toBe('OPEN');
    expect(t.inventory_movements).toHaveLength(0);
  });

  /* The asymmetry that made this item worse than a plain leak: the balances read
     was ALREADY scopeToCompany'd and the movement insert ALREADY stampCompany'd,
     while the flip was blind. So posting B's take compared B's counted qty
     against A's on-hand (no rows -> live 0) and wrote full-quantity phantom
     movements stamped to A. Scoping the flip is what closes it. */
  test('the cross-company post cannot reach the balances/movement pair at all', async () => {
    /* B's take must carry a COUNTED line, otherwise this test is vacuous: with
       no lines there is no variance and no movement would be written even by
       the unfixed code. With a line present, the unfixed code writes a
       full-quantity phantom movement (A's balances read returns nothing for B's
       warehouse, so live = 0 and adjustment = counted). */
    const t: Record<string, Row[]> = {
      stock_takes: takes(),
      stock_take_lines: [
        { stock_take_id: 'st-b', item_code: 'SKU-B', product_name: 'B thing', variant_key: '', counted_qty: 40, notes: null },
      ],
      inventory_balances: [],
      inventory_movements: [],
    };
    const { app, log } = harness(t, CO_A);
    await jsonPatch(app, '/stock-takes/st-b/post');
    expect(log.some((l) => l.startsWith('inventory_movements'))).toBe(false);
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('A CAN still post its own stock take', async () => {
    const t: Record<string, Row[]> = { stock_takes: takes(), stock_take_lines: [], inventory_movements: [] };
    const res = await jsonPatch(harness(t, CO_A).app, '/stock-takes/st-a/post');
    expect(res.status).toBe(200);
    expect(t.stock_takes.find((s) => s.id === 'st-a')!.status).toBe('POSTED');
  });
});

// ── Item 6 — purchase-invoices.ts: posts a PI ────────────────────────────────
describe('item 6 — PI post (Dr Inventory / Cr Payables)', () => {
  const pis = (): Row[] => [
    { id: 'pi-a', invoice_number: 'PI-A-1', company_id: CO_A, status: 'DRAFT', total_sen: 100 },
    { id: 'pi-b', invoice_number: 'PI-B-1', company_id: CO_B, status: 'DRAFT', total_sen: 900 },
    // Already POSTED: reaches the ensure-post GL branch from the LOAD alone,
    // without ever touching the UPDATE. Scoping only the flip would miss it.
    { id: 'pi-b-posted', invoice_number: 'PI-B-2', company_id: CO_B, status: 'POSTED', total_sen: 900 },
  ];

  test('A cannot post B\'s PI, and B\'s PI stays DRAFT', async () => {
    const t = { purchase_invoices: pis() };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-invoices/pi-b/post');
    expect(res.status).toBe(404);
    expect(t.purchase_invoices.find((p) => p.id === 'pi-b')!.status).toBe('DRAFT');
  });

  test('A cannot reach the ensure-post GL branch on B\'s already-POSTED PI', async () => {
    const t = { purchase_invoices: pis() };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-invoices/pi-b-posted/post');
    expect(res.status).toBe(404);
  });

  test('A CAN still post its own PI', async () => {
    const t = { purchase_invoices: pis() };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-invoices/pi-a/post');
    expect(res.status).toBe(200);
    expect(t.purchase_invoices.find((p) => p.id === 'pi-a')!.status).toBe('POSTED');
  });
});

// ── Item 8 (status half) — SI + DO status flips ──────────────────────────────
describe('item 8 — SI status flip (reverses revenue, mints credits)', () => {
  const sis = (): Row[] => [
    { id: 'si-a', invoice_number: 'SI-A-1', company_id: CO_A, status: 'SENT', paid_sen: 0, total_sen: 100 },
    { id: 'si-b', invoice_number: 'SI-B-1', company_id: CO_B, status: 'SENT', paid_sen: 0, total_sen: 900 },
  ];

  test('A cannot cancel B\'s invoice, and B\'s invoice stays SENT', async () => {
    const t = { sales_invoices: sis() };
    const res = await jsonPatch(harness(t, CO_A).app, '/sales-invoices/si-b/status', { status: 'CANCELLED' });
    expect(res.status).toBe(404);
    expect(t.sales_invoices.find((s) => s.id === 'si-b')!.status).toBe('SENT');
  });

  test('A CAN still cancel its own invoice', async () => {
    const t = { sales_invoices: sis() };
    const res = await jsonPatch(harness(t, CO_A).app, '/sales-invoices/si-a/status', { status: 'CANCELLED' });
    expect(res.status).toBe(200);
    expect(t.sales_invoices.find((s) => s.id === 'si-a')!.status).toBe('CANCELLED');
  });
});

describe('item 8 — DO status flip (deducts stock, emails the customer)', () => {
  const dos = (): Row[] => [
    { id: 'do-a', do_number: 'DO-A-1', company_id: CO_A, status: 'DRAFT' },
    { id: 'do-b', do_number: 'DO-B-1', company_id: CO_B, status: 'DRAFT' },
  ];

  test('A cannot flip B\'s delivery order, and B\'s DO stays DRAFT', async () => {
    const t = { delivery_orders: dos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/delivery-orders/do-b/status', { status: 'CANCELLED' });
    expect(res.status).toBe(404);
    expect(t.delivery_orders.find((d) => d.id === 'do-b')!.status).toBe('DRAFT');
  });

  test('A CAN still flip its own delivery order', async () => {
    const t = { delivery_orders: dos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/delivery-orders/do-a/status', { status: 'CANCELLED' });
    expect(res.status).toBe(200);
    expect(t.delivery_orders.find((d) => d.id === 'do-a')!.status).toBe('CANCELLED');
  });
});

// ── The refusal contract itself ──────────────────────────────────────────────
describe('refusal payloads stay inside the client\'s 200-character ceiling', () => {
  // authed-fetch.ts discards any server message of 200+ chars and shows a
  // generic clash line instead, so a long explanation reaches the operator as a
  // blank wall. Both refusals are short by necessity, not by style.
  test('every refusal message is under 200 characters', async () => {
    const t = { grns: [{ id: 'g-b', company_id: CO_B, status: 'DRAFT' }] };
    const notOurs = await jsonPatch(harness(t, CO_A).app, '/grns/g-b/post');
    const unresolved = await jsonPatch(harness(t, undefined).app, '/grns/g-b/post');
    for (const res of [notOurs, unresolved]) {
      const body = await res.json() as Row;
      expect(String(body.message).length).toBeLessThan(200);
      expect(String(body.message)).not.toMatch(/violates|constraint|null value|PGRST/);
    }
  });
});
