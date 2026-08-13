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
} from '../src/scm/routes/purchase-invoices';
import { createPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';

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
    { id: 'pi-a', invoice_number: 'HC-PI-2608-001', company_id: CO_A, status: 'POSTED', paid_centi: 0, total_centi: 100 },
    { id: 'pi-b', invoice_number: '2990-PI-2608-001', company_id: CO_B, status: 'POSTED', paid_centi: 0, total_centi: 900 },
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
        { id: 'pi-b', invoice_number: '2990-PI-2608-002', company_id: CO_B, status: 'DRAFT', paid_centi: 0, total_centi: 900 },
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
   then moves that invoice's paid_centi and status by id alone, so an allocation
   naming the OTHER company's invoice settled it — and could go on to rewrite its
   exchange_rate and re-cost the GRN behind it. Refused where the id enters, so
   nothing has been written when the refusal happens. */
describe('payment voucher allocations (settle a purchase invoice at post time)', () => {
  const pis = (): Row[] => [
    { id: 'pi-a', invoice_number: 'HC-PI-2608-010', company_id: CO_A, status: 'POSTED', paid_centi: 0, total_centi: 5000 },
    { id: 'pi-b', invoice_number: '2990-PI-2608-010', company_id: CO_B, status: 'POSTED', paid_centi: 0, total_centi: 5000 },
  ];
  const body = (piId: string) => ({
    payeeName: 'Freight Co',
    creditAccountCode: '1000',
    purpose: 'SUPPLIER_PAYMENT',
    lines: [{ description: 'payment', debitAccountCode: '2000', amountCenti: 5000 }],
    allocations: [{ piId, amountCenti: 5000 }],
  });

  test("A cannot raise a voucher applied to B's invoice, and no voucher is created", async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), payment_vouchers: [], pv_allocations: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/payment-vouchers', body('pi-b'));
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('allocation_not_in_company');
    // Refused BEFORE the first write — no voucher, no allocation row.
    expect(t.payment_vouchers).toHaveLength(0);
    expect(t.pv_allocations).toHaveLength(0);
  });

  test('A CAN still raise a voucher applied to its own invoice', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), payment_vouchers: [], pv_allocations: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/payment-vouchers', body('pi-a'));
    expect(res.status).toBe(201);
    expect(t.pv_allocations).toHaveLength(1);
    expect(t.pv_allocations[0]!.pi_id).toBe('pi-a');
  });

  test('a voucher with no allocations is unaffected by the guard', async () => {
    const t: Record<string, Row[]> = { purchase_invoices: pis(), payment_vouchers: [], pv_allocations: [] };
    const { allocations: _drop, ...noAlloc } = body('pi-a');
    const res = await jsonPost(harness(t, CO_A).app, '/payment-vouchers', { ...noAlloc, purpose: 'FREIGHT' });
    expect(res.status).toBe(201);
    expect(t.pv_allocations).toHaveLength(0);
  });
});

/* ── GRN → PI conversion ──────────────────────────────────────────────────────
   companyScope.ts states the rule for this shape: a converter whose destination
   stamps the ACTIVE company must REFUSE a cross-company source, because the
   conversion would otherwise move the document between the two companies' books.
   Four converters elsewhere already apply it; none of the purchase-side ones
   did. Converting the other company's receipt here would mint this company's
   supplier invoice, book this company's AP, and re-cost this company's lots for
   goods it never received. */
describe('GRN -> purchase invoice conversion (mints AP against the active company)', () => {
  const grns = (): Row[] => [
    { id: 'grn-a', grn_number: 'HC-GRN-2608-001', company_id: CO_A, status: 'POSTED', supplier_id: 's1', purchase_order_id: null, currency: 'MYR', exchange_rate: 1 },
    { id: 'grn-b', grn_number: '2990-GRN-2608-001', company_id: CO_B, status: 'POSTED', supplier_id: 's9', purchase_order_id: null, currency: 'MYR', exchange_rate: 1 },
  ];

  test("A cannot convert B's goods receipt, and no invoice is created", async () => {
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-invoices/from-grn', { grnId: 'grn-b' });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('cross_company_conversion_blocked');
    expect(t.purchase_invoices).toHaveLength(0);
  });

  test("A's own receipt is not refused by the conversion guard", async () => {
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const res = await jsonPost(harness(t, CO_A).app, '/purchase-invoices/from-grn', { grnId: 'grn-a' });
    /* It stops later, on "nothing_to_invoice" (this fixture has no GRN lines) —
       what matters is that it got PAST the company guard rather than being
       refused for belonging to someone else. */
    expect((await res.json() as Row).error).not.toBe('cross_company_conversion_blocked');
  });

  test('an unresolved company degrades to allowed, as the three-state contract requires', async () => {
    const t: Record<string, Row[]> = { grns: grns(), grn_items: [], purchase_invoices: [] };
    const res = await jsonPost(harness(t, undefined).app, '/purchase-invoices/from-grn', { grnId: 'grn-b' });
    expect((await res.json() as Row).error).not.toBe('cross_company_conversion_blocked');
  });
});
