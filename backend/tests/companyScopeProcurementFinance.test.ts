/* Company scoping on the PROCUREMENT / FINANCE write paths (audit 2026-08-13,
   procurement+finance+consignment slice).
 *
 * Sibling of companyScopeHardening.test.ts — same harness, same both-directions
 * discipline. Every leak test is paired with a same-company test proving the
 * legitimate request still works, and each cross-company test also asserts the
 * VICTIM ROW WAS LEFT UNCHANGED: a 404 that still cancelled would sail past a
 * status-only assertion.
 *
 * Driven through a bare Hono app whose middleware injects a fake scm supabase
 * client + a company context, mounting the EXPORTED handler rather than the
 * router — the supabaseAuth bridge cannot run in this harness.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  cancelPurchaseInvoiceHandler,
  createPurchaseInvoiceFromGrnHandler,
  createPurchaseInvoicesFromGrnItemsHandler,
} from '../src/scm/routes/purchase-invoices';
import { createPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';
import { createGrnFromPosHandler, createGrnsFromPoItemsHandler } from '../src/scm/routes/grns';
import { createPcReceiveFromPcosHandler } from '../src/scm/routes/purchase-consignment-receives';
import {
  createPcReturnFromPcReceivesHandler,
  createPcReturnFromPcReceiveHandler,
} from '../src/scm/routes/purchase-consignment-returns';
import {
  createPurchaseReturnFromGrnsHandler,
  createPurchaseReturnFromGrnHandler,
} from '../src/scm/routes/purchase-returns';
import { convertSosToPosCore } from '../src/scm/routes/mfg-purchase-orders';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — copied in shape from
   companyScopeHardening.test.ts. The handler under test reaches far past the
   statement being asserted (audit rows, the GL reversal, the GRN release, the
   re-cost, the AutoCount outbox), so every builder method chains and an unknown
   table reads as empty rather than throwing. The assertions are about the
   company predicate, not the rest. */
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
  gt() { return this; }
  lt() { return this; }
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
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    c.env = { DB: undefined } as never;
    await next();
  });
  app.patch('/purchase-invoices/:id/cancel', cancelPurchaseInvoiceHandler as never);
  app.post('/payment-vouchers', createPaymentVoucherHandler as never);
  app.post('/purchase-invoices/from-grn', createPurchaseInvoiceFromGrnHandler as never);
  app.post('/purchase-invoices/from-grn-items', createPurchaseInvoicesFromGrnItemsHandler as never);
  app.post('/grns/from-pos', createGrnFromPosHandler as never);
  app.post('/grns/from-po-items', createGrnsFromPoItemsHandler as never);
  app.post('/purchase-consignment-receives/from-pcos', createPcReceiveFromPcosHandler as never);
  app.post('/purchase-consignment-returns/from-pc-receives', createPcReturnFromPcReceivesHandler as never);
  app.post('/purchase-consignment-returns/from-pc-receive', createPcReturnFromPcReceiveHandler as never);
  app.post('/purchase-returns/from-grns', createPurchaseReturnFromGrnsHandler as never);
  app.post('/purchase-returns/from-grn', createPurchaseReturnFromGrnHandler as never);
  return { app, log };
}

const jsonPatch = (app: Hono, url: string) =>
  app.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });

const jsonPost = (app: Hono, url: string, body: Row) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/* ── PI cancel — the heaviest write this document has ─────────────────────────
   Cancelling a purchase invoice reverses its AP/GL entry (Dr Payables / Cr
   Inventory contra, keyed off invoice_number), releases the source GRN lines'
   invoiced_qty so the same goods become billable again, re-costs the lots / DO
   / SI behind them, and queues an AutoCount cancel against that company's
   account book. It addressed the row by id alone, so a company-A caller holding
   a company-B invoice uuid did all of that to company B. Its two siblings in
   the same file — PATCH /:id/post and PATCH /:id/payment — were already
   scoped. */
describe('purchase invoice cancel (reverses the AP/GL entry + releases the GRN)', () => {
  const pis = (): Row[] => [
    { id: 'pi-a', invoice_number: 'HC-PI-2608-001', company_id: CO_A, status: 'POSTED', paid_sen: 0, total_sen: 100 },
    { id: 'pi-b', invoice_number: '2990-PI-2608-001', company_id: CO_B, status: 'POSTED', paid_sen: 0, total_sen: 900 },
  ];

  test("A cannot cancel B's invoice — it stays POSTED and no GL reversal is written", async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), journal_entries: [] };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-invoices/pi-b/cancel');
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('not_found_in_company');
    expect(t.purchase_invoices.find((p) => p.id === 'pi-b')!.status).toBe('POSTED');
    // The status alone would not catch a refusal that still touched the ledger.
    expect(t.journal_entries).toHaveLength(0);
  });

  test('A CAN still cancel its own invoice', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), journal_entries: [] };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-invoices/pi-a/cancel');
    expect(res.status).toBe(200);
    expect(t.purchase_invoices.find((p) => p.id === 'pi-a')!.status).toBe('CANCELLED');
    // ... and the other company's invoice was not swept along with it.
    expect(t.purchase_invoices.find((p) => p.id === 'pi-b')!.status).toBe('POSTED');
  });

  test("A cannot cancel B's DRAFT invoice either (the plain-status-flip branch)", async () => {
    const t: Record<string, Row[]> = {
      purchase_invoices: [
        { id: 'pi-b', invoice_number: '2990-PI-2608-002', company_id: CO_B, status: 'DRAFT', paid_sen: 0, total_sen: 900 },
      ],
    };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-invoices/pi-b/cancel');
    expect(res.status).toBe(404);
    expect(t.purchase_invoices[0]!.status).toBe('DRAFT');
  });

  test('an unresolved company refuses rather than cancelling across all companies', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), journal_entries: [] };
    const res = await jsonPatch(harness(t, undefined).app, '/purchase-invoices/pi-a/cancel');
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.purchase_invoices.every((p) => p.status === 'POSTED')).toBe(true);
  });

  test('the UPDATE itself carries the company predicate, not just the load', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), journal_entries: [] };
    const h = harness(t, CO_A);
    await jsonPatch(h.app, '/purchase-invoices/pi-a/cancel');
    /* Load and write are two statements; scoping only the load leaves the write
       addressable by id alone, which is what postJournalEntryHandler's own
       comment warns about ("the one that writes is the one that has to be
       safe"). */
    expect(h.log).toContain('purchase_invoices.update:eq:company_id');
  });
});

/* ── PV → PI allocations — the pi_id is caller-supplied ───────────────────────
   A payment voucher's allocation rows are stamped with the ACTIVE company, but
   the invoice each one names arrives in the request body. Posting the voucher
   then moves that invoice's paid_sen and status by id alone, so an allocation
   naming the OTHER company's invoice settled it — and could go on to rewrite its
   exchange_rate and re-cost the GRN behind it. Refused where the id enters, so
   nothing has been written when the refusal happens. */
describe('payment voucher allocations (settle a purchase invoice at post time)', () => {
  const pis = (): Row[] => [
    { id: 'pi-a', invoice_number: 'HC-PI-2608-010', company_id: CO_A, status: 'POSTED', paid_sen: 0, total_sen: 5000 },
    { id: 'pi-b', invoice_number: '2990-PI-2608-010', company_id: CO_B, status: 'POSTED', paid_sen: 0, total_sen: 5000 },
  ];
  /* Paid From must be a MONEY account since the acc_money guard — each company
     carries its own '1000' bank row, per-company like the real chart. */
  const accts = (): Row[] => [
    { account_code: '1000', account_name: 'Bank', account_type: 'ASSET', acc_money: true, is_active: true, company_id: CO_A },
    { account_code: '1000', account_name: 'Bank', account_type: 'ASSET', acc_money: true, is_active: true, company_id: CO_B },
  ];
  const body = (piId: string) => ({
    payeeName: 'Freight Co',
    creditAccountCode: '1000',
    purpose: 'SUPPLIER_PAYMENT',
    lines: [{ description: 'payment', debitAccountCode: '2000', amountSen: 5000 }],
    allocations: [{ piId, amountSen: 5000 }],
  });

  test("A cannot raise a voucher applied to B's invoice, and no voucher is created", async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), payment_vouchers: [], pv_allocations: [], accounts: accts() };
    const res = await jsonPost(harness(t, CO_A).app, '/payment-vouchers', body('pi-b'));
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('allocation_not_in_company');
    // Refused BEFORE the first write — no voucher, no allocation row.
    expect(t.payment_vouchers).toHaveLength(0);
    expect(t.pv_allocations).toHaveLength(0);
  });

  test('A CAN still raise a voucher applied to its own invoice', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), payment_vouchers: [], pv_allocations: [], accounts: accts() };
    const res = await jsonPost(harness(t, CO_A).app, '/payment-vouchers', body('pi-a'));
    expect(res.status).toBe(201);
    expect(t.pv_allocations).toHaveLength(1);
    expect(t.pv_allocations[0]!.pi_id).toBe('pi-a');
  });

  test('a voucher with no allocations is unaffected by the guard', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), payment_vouchers: [], pv_allocations: [], accounts: accts() };
    const { allocations: _drop, ...noAlloc } = body('pi-a');
    const res = await jsonPost(harness(t, CO_A).app, '/payment-vouchers', { ...noAlloc, purpose: 'FREIGHT' });
    expect(res.status).toBe(201);
    expect(t.pv_allocations).toHaveLength(0);
  });
});

/* ── THE CONVERSION SUITE (purchase side) ─────────────────────────────────────
   A document conversion never crosses a company. As of 2026-08-13 that is held
   by SCOPING THE SOURCE LOAD rather than by comparing companies after loading it
   unscoped, so every test below asserts the same two things in the same shape:

     · the other company's source YIELDS NOTHING — the handler answers with its
       own "I could not find that" error, and no destination document is written;
     · this company's source is STILL VISIBLE — the handler gets past the source
       read and stops on a LATER, unrelated rule.

   The second half is the one that matters most. A scope sweep's real failure
   mode is hiding a company's own documents from its own users, which nobody
   reports as a bug; it just reads as "the button does nothing".

   These assertions changed shape on 2026-08-13. They used to expect
   `cross_company_conversion_blocked` — the 409 the REFUSAL mechanism returned.
   Under the scoped-source mechanism there is no refusal to return, because there
   is no cross-company row to refuse. The cost is the worse message, and that is
   deliberate: see the note in each handler and in check-conversion-guards.mjs. */

describe('GRN -> purchase invoice, whole receipt (mints AP against the active company)', () => {
  const grns = (): Row[] => [
    { id: 'grn-a', grn_number: 'HC-GRN-2608-001', company_id: CO_A, status: 'POSTED', supplier_id: 's1', purchase_order_id: null, currency: 'MYR', exchange_rate: 1 },
    { id: 'grn-b', grn_number: '2990-GRN-2608-001', company_id: CO_B, status: 'POSTED', supplier_id: 's9', purchase_order_id: null, currency: 'MYR', exchange_rate: 1 },
  ];

  test("B's goods receipt is not visible to A — no invoice is created", async () => {
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-invoices/from-grn', { grnId: 'grn-b' });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('grn_not_found');
    expect(t.purchase_invoices).toHaveLength(0);
  });

  test('the SOURCE read carries the company predicate, not just some read', async () => {
    /* Without this the previous test would also pass on a handler that found the
       GRN and then failed for an unrelated reason. */
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const h = harness(t, CO_A);
    await jsonPost(h.app, '/purchase-invoices/from-grn', { grnId: 'grn-a' });
    expect(h.log).toContain('grns.select:eq:company_id');
    expect(h.log).toContain('grn_items.select:eq:company_id');
  });

  test("A's own receipt is still convertible", async () => {
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-invoices/from-grn', { grnId: 'grn-a' });
    /* Stops later, on "nothing_to_invoice" (this fixture has no GRN lines) — the
       proof wanted: the source WAS found, and the refusal was a downstream rule. */
    expect((await res.json() as Row).error).toBe('nothing_to_invoice');
  });

  test('an unresolved company degrades to allowed, as the three-state contract requires', async () => {
    // companies master unreadable (pre-migration / cold start): scopeToCompany
    // adds no predicate at all, so single-company Houzs keeps converting.
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const res = await jsonPost(harness(t, undefined).app, '/purchase-invoices/from-grn', { grnId: 'grn-b' });
    expect((await res.json() as Row).error).not.toBe('grn_not_found');
  });
});

describe('GRN -> purchase invoice, picked lines', () => {
  /* The parent GRN rides a `!inner` embed, so the fixture row carries it the way
     PostgREST returns it. Scoping grn_items therefore closes BOTH ends. */
  const grnItems = (): Row[] => [
    {
      id: 'gi-a', grn_id: 'grn-a', company_id: CO_A, qty_accepted: 5, invoiced_qty: 0, returned_qty: 0,
      item_code: 'M1', material_name: 'Mat', material_kind: 'mfg_product', discount_sen: 0, unit_price_sen: 100,
      grn: { id: 'grn-a', grn_number: 'HC-GRN-2608-001', supplier_id: 's1', purchase_order_id: null, status: 'POSTED', currency: 'MYR', exchange_rate: 1, company_id: CO_A },
    },
    {
      id: 'gi-b', grn_id: 'grn-b', company_id: CO_B, qty_accepted: 5, invoiced_qty: 0, returned_qty: 0,
      item_code: 'M9', material_name: 'Mat', material_kind: 'mfg_product', discount_sen: 0, unit_price_sen: 100,
      grn: { id: 'grn-b', grn_number: '2990-GRN-2608-001', supplier_id: 's9', purchase_order_id: null, status: 'POSTED', currency: 'MYR', exchange_rate: 1, company_id: CO_B },
    },
  ];

  test("B's receipt line is not visible to A", async () => {
    const t: Record<string, Row[]> = { grn_items: grnItems(), purchase_invoices: [], purchase_invoice_items: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-invoices/from-grn-items', {
      picks: [{ grnItemId: 'gi-b', qty: 0 }],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Row).error).toBe('item_not_found');
    expect(t.purchase_invoices).toHaveLength(0);
  });

  test("A's own receipt line IS found — it fails the NEXT rule instead", async () => {
    /* qty 0 on both requests, so the only difference between this test and the
       one above is whether the source row was visible. `item_not_found` is
       checked BEFORE `qty_must_be_positive`, so the two errors discriminate
       exactly on that. */
    const t: Record<string, Row[]> = { grn_items: grnItems(), purchase_invoices: [], purchase_invoice_items: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-invoices/from-grn-items', {
      picks: [{ grnItemId: 'gi-a', qty: 0 }],
    });
    expect((await res.json() as Row).error).toBe('qty_must_be_positive');
  });

  test('the source read carries the company predicate', async () => {
    const t: Record<string, Row[]> = { grn_items: grnItems(), purchase_invoices: [] };
    const h = harness(t, CO_A);
    await jsonPost(h.app, '/purchase-invoices/from-grn-items', { picks: [{ grnItemId: 'gi-a', qty: 0 }] });
    expect(h.log).toContain('grn_items.select:eq:company_id');
  });
});

/* ── GRN -> Purchase Return ───────────────────────────────────────────────────
   Returning the other company's receipt mints THIS company's PRT number and
   refund, pulls the inventory OUT of the warehouse behind that company's GRN,
   and consumes returned_qty on its GRN lines — which in turn moves the PI
   over-bill headroom and the PO re-open gate on a document this company does not
   own. The last pair to leave the refusal mechanism: purchase-returns.ts was
   held by concurrent work during the 2026-08-13 sweep. */
describe('GRN -> purchase return (draws stock back out and consumes the GRN line)', () => {
  const grns = (): Row[] => [
    { id: 'grn-a', grn_number: 'HC-GRN-2608-020', company_id: CO_A, status: 'POSTED', supplier_id: 's1', purchase_order_id: null },
    { id: 'grn-b', grn_number: '2990-GRN-2608-020', company_id: CO_B, status: 'POSTED', supplier_id: 's9', purchase_order_id: null },
  ];
  /* Nothing left to return on either receipt (qty_rejected 0, and qty_accepted
     already fully returned), so BOTH converters stop on their own "nothing left
     to return" rule the moment the source becomes visible. That stop is the
     marker the source WAS found — the half a scope sweep breaks silently. */
  const grnItems = (): Row[] => [
    { id: 'gi-a', grn_id: 'grn-a', company_id: CO_A, qty_accepted: 2, qty_rejected: 0, returned_qty: 2, unit_price_sen: 100, item_code: 'M1', material_name: 'Mat', material_kind: 'mfg_product', item_group: null, variants: null, description: null, description2: null, uom: 'UNIT', rejection_reason: null },
    { id: 'gi-b', grn_id: 'grn-b', company_id: CO_B, qty_accepted: 2, qty_rejected: 0, returned_qty: 2, unit_price_sen: 100, item_code: 'M9', material_name: 'Mat', material_kind: 'mfg_product', item_group: null, variants: null, description: null, description2: null, uom: 'UNIT', rejection_reason: null },
  ];
  const tables = (): Record<string, Row[]> => ({
    grns: grns(),
    grn_items: grnItems(),
    purchase_returns: [],
    purchase_return_items: [],
  });

  test("batch: B's receipt is not visible to A — no return is created", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-returns/from-grns', { grnIds: ['grn-b'] });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('grns_not_found');
    expect(t.purchase_returns).toHaveLength(0);
    expect(t.purchase_return_items).toHaveLength(0);
  });

  test("batch: A's own receipt is still convertible", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-returns/from-grns', { grnIds: ['grn-a'] });
    // Past the source read and past the POSTED / same-supplier gates.
    expect((await res.json() as Row).error).toBe('no_rejected_qty');
  });

  test("single: B's receipt is not visible to A — no return is created", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-returns/from-grn', { grnId: 'grn-b' });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('grn_not_found');
    expect(t.purchase_returns).toHaveLength(0);
    expect(t.purchase_return_items).toHaveLength(0);
  });

  test("single: A's own receipt is still convertible", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-returns/from-grn', { grnId: 'grn-a' });
    expect((await res.json() as Row).error).toBe('nothing_to_return');
  });

  test('BOTH source reads carry the company predicate, on both converters', async () => {
    /* The line table is an entry point in its own right: it is keyed on the same
       caller-supplied grn ids, and adjustGrnReturnedQty writes returned_qty on
       whatever it returns. Header-only scoping would pass the two tests above
       and still consume the other company's GRN lines. */
    const cases: Array<[string, Row]> = [
      ['/purchase-returns/from-grns', { grnIds: ['grn-a'] }],
      ['/purchase-returns/from-grn', { grnId: 'grn-a' }],
    ];
    for (const [url, body] of cases) {
      const h = harness(tables(), CO_A);
      await jsonPost(h.app, url, body);
      expect(h.log).toContain('grns.select:eq:company_id');
      expect(h.log).toContain('grn_items.select:eq:company_id');
    }
  });

  test('an unresolved company degrades to allowed, as the three-state contract requires', async () => {
    const t = tables();
    const res = await jsonPost(harness(t, undefined).app, '/purchase-returns/from-grns', { grnIds: ['grn-b'] });
    expect((await res.json() as Row).error).not.toBe('grns_not_found');
  });
});

/* ── PO -> GRN ────────────────────────────────────────────────────────────────
   Receiving the other company's purchase order would write stock IN — and the
   cost behind it — into this company's inventory and books. */
describe('PO -> GRN, whole purchase orders', () => {
  const pos = (): Row[] => [
    { id: 'po-a', po_number: 'HC-PO-2608-001', company_id: CO_A, supplier_id: 's1', status: 'SUBMITTED', currency: 'MYR' },
    { id: 'po-b', po_number: '2990-PO-2608-001', company_id: CO_B, supplier_id: 's9', status: 'SUBMITTED', currency: 'MYR' },
  ];

  test("B's purchase order is not visible to A — no GRN is created", async () => {
    const t: Record<string, Row[]> = { purchase_orders: pos(), purchase_order_items: [], grns: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/grns/from-pos', { purchaseOrderIds: ['po-b'] });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('pos_not_found');
    expect(t.grns).toHaveLength(0);
  });

  test("A's own purchase order is still convertible", async () => {
    const t: Record<string, Row[]> = { purchase_orders: pos(), purchase_order_items: [], grns: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/grns/from-pos', { purchaseOrderIds: ['po-a'] });
    // Past the source read and past the receivable-status gate; stops on the
    // fixture having no outstanding lines.
    expect((await res.json() as Row).error).toBe('nothing_outstanding');
  });

  test('BOTH source reads carry the company predicate — header and lines', async () => {
    const t: Record<string, Row[]> = { purchase_orders: pos(), purchase_order_items: [], grns: [] };
    const h = harness(t, CO_A);
    await jsonPost(h.app, '/grns/from-pos', { purchaseOrderIds: ['po-a'] });
    expect(h.log).toContain('purchase_orders.select:eq:company_id');
    expect(h.log).toContain('purchase_order_items.select:eq:company_id');
  });

  test('an unresolved company degrades to allowed', async () => {
    const t: Record<string, Row[]> = { purchase_orders: pos(), purchase_order_items: [], grns: [] };
    const res = await jsonPost(harness(t, undefined).app, '/grns/from-pos', { purchaseOrderIds: ['po-b'] });
    expect((await res.json() as Row).error).not.toBe('pos_not_found');
  });
});

describe('PO -> GRN, picked lines', () => {
  const poItems = (): Row[] => [
    {
      id: 'poi-a', purchase_order_id: 'po-a', company_id: CO_A, qty: 5, received_qty: 0,
      item_code: 'M1', material_name: 'Mat', material_kind: 'mfg_product', unit_price_sen: 100,
      po: { id: 'po-a', po_number: 'HC-PO-2608-001', supplier_id: 's1', status: 'SUBMITTED', purchase_location_id: 'wh1', currency: 'MYR' },
    },
    {
      id: 'poi-b', purchase_order_id: 'po-b', company_id: CO_B, qty: 5, received_qty: 0,
      item_code: 'M9', material_name: 'Mat', material_kind: 'mfg_product', unit_price_sen: 100,
      po: { id: 'po-b', po_number: '2990-PO-2608-001', supplier_id: 's9', status: 'SUBMITTED', purchase_location_id: 'wh9', currency: 'MYR' },
    },
  ];

  test("B's PO line is not visible to A", async () => {
    const t: Record<string, Row[]> = { purchase_order_items: poItems(), grns: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/grns/from-po-items', { picks: [{ poItemId: 'poi-b', qty: 0 }] });
    expect(res.status).toBe(400);
    expect((await res.json() as Row).error).toBe('item_not_found');
    expect(t.grns).toHaveLength(0);
  });

  test("A's own PO line IS found — it fails the NEXT rule instead", async () => {
    const t: Record<string, Row[]> = { purchase_order_items: poItems(), grns: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/grns/from-po-items', { picks: [{ poItemId: 'poi-a', qty: 0 }] });
    expect((await res.json() as Row).error).toBe('qty_must_be_positive');
  });

  test('the source read carries the company predicate', async () => {
    const t: Record<string, Row[]> = { purchase_order_items: poItems(), grns: [] };
    const h = harness(t, CO_A);
    await jsonPost(h.app, '/grns/from-po-items', { picks: [{ poItemId: 'poi-a', qty: 0 }] });
    expect(h.log).toContain('purchase_order_items.select:eq:company_id');
  });
});

/* ── Consignment: PC Order -> PC Receive, PC Receive -> PC Return ─────────────
   Receiving or returning the other company's consigned goods moves that
   company's received_qty and books the stock movement here. */
describe('PC Order -> PC Receive', () => {
  const pcos = (): Row[] => [
    { id: 'pco-a', pc_number: 'HC-PC-2608-001', company_id: CO_A, supplier_id: 's1', status: 'SUBMITTED' },
    { id: 'pco-b', pc_number: '2990-PC-2608-001', company_id: CO_B, supplier_id: 's9', status: 'SUBMITTED' },
  ];

  test("B's consignment order is not visible to A — no receive is created", async () => {
    const t: Record<string, Row[]> = {
      purchase_consignment_orders: pcos(), purchase_consignment_order_items: [],
      purchase_consignment_receives: [],
    };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-consignment-receives/from-pcos', {
      purchaseConsignmentOrderIds: ['pco-b'],
    });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('pcos_not_found');
    expect(t.purchase_consignment_receives).toHaveLength(0);
  });

  test("A's own consignment order is still convertible", async () => {
    const t: Record<string, Row[]> = {
      purchase_consignment_orders: pcos(), purchase_consignment_order_items: [],
      purchase_consignment_receives: [],
    };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-consignment-receives/from-pcos', {
      purchaseConsignmentOrderIds: ['pco-a'],
    });
    expect((await res.json() as Row).error).toBe('nothing_outstanding');
  });

  test('BOTH source reads carry the company predicate — header and lines', async () => {
    const t: Record<string, Row[]> = {
      purchase_consignment_orders: pcos(), purchase_consignment_order_items: [],
      purchase_consignment_receives: [],
    };
    const h = harness(t, CO_A);
    await jsonPost(h.app, '/purchase-consignment-receives/from-pcos', { purchaseConsignmentOrderIds: ['pco-a'] });
    expect(h.log).toContain('purchase_consignment_orders.select:eq:company_id');
    expect(h.log).toContain('purchase_consignment_order_items.select:eq:company_id');
  });
});

describe('PC Receive -> PC Return', () => {
  const receives = (): Row[] => [
    { id: 'pcr-a', receive_number: 'HC-PCR-2608-001', company_id: CO_A, supplier_id: 's1', purchase_consignment_order_id: null, status: 'POSTED' },
    { id: 'pcr-b', receive_number: '2990-PCR-2608-001', company_id: CO_B, supplier_id: 's9', purchase_consignment_order_id: null, status: 'POSTED' },
  ];
  /* qty_rejected 0 and qty_accepted fully returned, so BOTH converters stop on
     their own "nothing left to return" rule once the source is visible. */
  const receiveItems = (): Row[] => [
    { id: 'pcri-a', pc_receive_id: 'pcr-a', company_id: CO_A, qty_accepted: 2, qty_rejected: 0, returned_qty: 2, unit_price_sen: 100, item_code: 'M1', material_name: 'Mat', material_kind: 'mfg_product', item_group: null, variants: null, description: null, description2: null, uom: 'UNIT', rejection_reason: null },
    { id: 'pcri-b', pc_receive_id: 'pcr-b', company_id: CO_B, qty_accepted: 2, qty_rejected: 0, returned_qty: 2, unit_price_sen: 100, item_code: 'M9', material_name: 'Mat', material_kind: 'mfg_product', item_group: null, variants: null, description: null, description2: null, uom: 'UNIT', rejection_reason: null },
  ];
  const tables = (): Record<string, Row[]> => ({
    purchase_consignment_receives: receives(),
    purchase_consignment_receive_items: receiveItems(),
    purchase_consignment_returns: [],
    purchase_consignment_return_items: [],
  });

  test("batch: B's receive is not visible to A — no return is created", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-consignment-returns/from-pc-receives', {
      pcReceiveIds: ['pcr-b'],
    });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('pc_receives_not_found');
    expect(t.purchase_consignment_returns).toHaveLength(0);
  });

  test("batch: A's own receive is still convertible", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-consignment-returns/from-pc-receives', {
      pcReceiveIds: ['pcr-a'],
    });
    expect((await res.json() as Row).error).toBe('no_rejected_qty');
  });

  test("single: B's receive is not visible to A — no return is created", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-consignment-returns/from-pc-receive', {
      pcReceiveId: 'pcr-b',
    });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('pc_receive_not_found');
    expect(t.purchase_consignment_returns).toHaveLength(0);
  });

  test("single: A's own receive is still convertible", async () => {
    const t = tables();
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-consignment-returns/from-pc-receive', {
      pcReceiveId: 'pcr-a',
    });
    expect((await res.json() as Row).error).toBe('nothing_to_return');
  });

  test('BOTH source reads carry the company predicate, on both converters', async () => {
    for (const url of [
      '/purchase-consignment-returns/from-pc-receives',
      '/purchase-consignment-returns/from-pc-receive',
    ]) {
      const h = harness(tables(), CO_A);
      await jsonPost(h.app, url, { pcReceiveIds: ['pcr-a'], pcReceiveId: 'pcr-a' });
      expect(h.log).toContain('purchase_consignment_receives.select:eq:company_id');
      expect(h.log).toContain('purchase_consignment_receive_items.select:eq:company_id');
    }
  });
});

/* ── SO -> PO ─────────────────────────────────────────────────────────────────
   Driven through convertSosToPosCore rather than the route, because the core is
   the single authority both the HTTP picker and the Procurement Agent's headless
   createDraftPosFromPicks run — testing the route would leave the agent path
   unproven, and the agent supplies its own reconstructed company context. */
describe('SO -> PO (convertSosToPosCore, shared by the picker and the agent)', () => {
  const soItems = (): Row[] => [
    {
      id: 'soi-a', doc_no: 'HC-SO-2608-001', company_id: CO_A, item_code: 'M1', description: null,
      item_group: null, variants: null, qty: 5, po_qty_picked: 0, unit_price_sen: 100,
      line_delivery_date: null, warehouse_id: null, photo_urls: null, cancelled: false,
      so: { sales_location: null, customer_delivery_date: null },
    },
    {
      id: 'soi-b', doc_no: '2990-SO-2608-001', company_id: CO_B, item_code: 'M9', description: null,
      item_group: null, variants: null, qty: 5, po_qty_picked: 0, unit_price_sen: 100,
      line_delivery_date: null, warehouse_id: null, photo_urls: null, cancelled: false,
      so: { sales_location: null, customer_delivery_date: null },
    },
  ];

  const runCore = (tables: Record<string, Row[]>, companyId: number | undefined, body: unknown) => {
    const log: string[] = [];
    const sb = {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      rpc: async () => ({ data: true, error: null }),
    };
    const get = (key: string): unknown => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'u1' };
      if (key === 'houzsUser') return undefined;
      if (key === 'companyId') return companyId;
      if (key === 'allowedCompanyIds') return undefined;
      if (key === 'companyCode') return companyId === CO_B ? '2990' : 'HOUZS';
      return undefined;
    };
    return convertSosToPosCore({
      req: { json: async () => body },
      get: get as never,
      env: { DB: undefined } as never,
      json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
    });
  };

  test("B's SO line is not visible to A — no PO is raised", async () => {
    const t: Record<string, Row[]> = { mfg_sales_order_items: soItems(), purchase_orders: [] };
    const out = await runCore(t, CO_A, { picks: [{ soItemId: 'soi-b', qty: 0 }] });
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('item_not_found');
    expect(t.purchase_orders).toHaveLength(0);
  });

  test("A's own SO line IS found — it fails the NEXT rule instead", async () => {
    const t: Record<string, Row[]> = { mfg_sales_order_items: soItems(), purchase_orders: [] };
    const out = await runCore(t, CO_A, { picks: [{ soItemId: 'soi-a', qty: 0 }] });
    expect(out.body.error).toBe('qty_must_be_positive');
  });

  test('the legacy (doc_no, item_code) branch is scoped too', async () => {
    /* This branch FABRICATES a line when nothing matches, so an unscoped read
       returning the other company's row would have been used verbatim — qty and
       price copied off another company's order. Scoped, it simply does not
       match, and the fabricated row carries only what the caller sent. */
    const t: Record<string, Row[]> = { mfg_sales_order_items: soItems(), purchase_orders: [] };
    const out = await runCore(t, CO_A, {
      soItems: [{ soDocNo: '2990-SO-2608-001', itemCode: 'M9', itemName: 'Mat', qty: 1 }],
    });
    // Falls through to the "no orderable SO" / unbound-SKU path rather than
    // pricing off 2990's line. What must NOT happen is a PO row.
    expect(t.purchase_orders).toHaveLength(0);
    expect(out.status).toBeGreaterThanOrEqual(400);
  });

  test('an unresolved company degrades to allowed', async () => {
    const t: Record<string, Row[]> = { mfg_sales_order_items: soItems(), purchase_orders: [] };
    const out = await runCore(t, undefined, { picks: [{ soItemId: 'soi-b', qty: 0 }] });
    expect(out.body.error).not.toBe('item_not_found');
  });
});
