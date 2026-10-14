// HC-0006 T5: a field edited on a scanned DRAFT, then confirmed, lands as a
// CONFIRMED so_scan_samples row carrying that edit. The capture itself lives in
// noteScanDraftAccepted (unit-tested in scan-sample-review.test.ts); this pins
// the ROUTE wiring: PATCH /mfg-sales-orders/:docNo/status DRAFT -> CONFIRMED,
// the path desktop (SalesOrderDetail) and mobile (mobile-so-concurrency) share.
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

type Row = Record<string, any>;

/* Permissive fake PostgREST builder (same shape as soCancelScopeAndAtomicCancels):
   every method chains, eq/neq/in filter, an unknown table reads as empty. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  gte() { return this; }
  lte() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  /* Only the shapes the learning hook sends: not(col,'is',null) and
     not('action','in','("A","B")'). */
  not(col: string, op: string, val: unknown) {
    if (op === 'is') this.preds.push((r) => r[col] != null);
    if (op === 'in') {
      const s = new Set(String(val).replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));
      this.preds.push((r) => !s.has(String(r[col])));
    }
    return this;
  }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

let tables: Record<string, Row[]> = {};
const client = () => ({ from: (t: string) => new FakeQuery((tables[t] ||= [])), rpc: async () => ({ data: true, error: null }) });

vi.mock('../src/db/supabase', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSupabaseService: () => client(),
}));

/* The brand question after a confirm reads D1; not under test here. */
vi.mock('../src/scm/lib/vp-brand-ask', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadVpBrandAsk: async () => null,
}));

import { patchMfgSalesOrderStatusHandler } from '../src/scm/routes/mfg-sales-orders';

const CO = 1;
const DOC = 'HC-SO-2610-001';

const extracted = {
  customerName: 'Tan Ah Kow', address: '12 Jalan Mawar', addressLine1: '12 Jalan Mawar',
  city: 'Skudai', postcode: '81300', addressStateMatch: { value: 'Johor', confidence: 0.9, reason: 'read' },
  phones: ['127778888'], customerSoRef: 'HC14032', depositRm: null, approvalCode: null,
  paymentMethodMatch: null, bankMatch: null, customerTypeMatch: null, buildingTypeMatch: null,
  deliveryDate: null, lines: [],
};

function world(auditAfterCreate: Row[]) {
  tables = {
    mfg_sales_orders: [{
      doc_no: DOC, company_id: CO, status: 'DRAFT', version: 2, debtor_code: 'C1',
      salesperson_id: 'staff-1', venue: 'JB fair',
      // The operator corrected the name the scan misread.
      debtor_name: 'Tan Ah Kaw', phone: '+60127778888', emergency_contact_phone: null,
      address1: '12 Jalan Mawar', city: 'Skudai', postcode: '81300', customer_state: 'Johor',
      customer_so_no: 'HC14032', customer_type: null, building_type: null, payment_method: null,
      merchant_provider: null, approval_code: null, deposit_sen: 0, customer_delivery_date: null,
    }],
    mfg_sales_order_items: [],
    scan_jobs: [{ id: 'job-1', company_id: CO, so_doc_no: DOC, sample_id: 'smp-1', created_at: '2026-10-14T00:00:00Z' }],
    so_scan_samples: [{ id: 'smp-1', company_id: CO, status: 'EXTRACTED', extracted, corrected: null }],
    mfg_so_audit_log: [{ id: 1, so_doc_no: DOC, action: 'CREATE', source: 'web' }, ...auditAfterCreate],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, client() as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/mfg-sales-orders/:docNo/status', patchMfgSalesOrderStatusHandler as never);
  return app;
}

const confirm = (app: Hono) => app.request(`/mfg-sales-orders/${DOC}/status`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'CONFIRMED', expectedStatus: 'DRAFT', version: 2 }),
}, { DB: {} });

/* The hook runs in waitUntil (a floating promise off-Workers); let it settle. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };

describe('confirming an edited scan draft records the correction', () => {
  test('a name edited before confirm lands as a CONFIRMED sample carrying the new name', async () => {
    const app = world([{ id: 2, so_doc_no: DOC, action: 'UPDATE_DETAILS', source: 'web' }]);
    const res = await confirm(app);
    expect(res.status).toBe(200);
    await settle();
    const s = tables.so_scan_samples![0]!;
    expect(s.status).toBe('CONFIRMED');
    expect(s.corrected.customerName).toBe('Tan Ah Kaw');
    expect(s.corrected.customerSoRef).toBe('HC14032');
  });

  test('confirmed with no edit lands ACCEPTED, corrected = extracted', async () => {
    const app = world([]);
    expect((await confirm(app)).status).toBe(200);
    await settle();
    const s = tables.so_scan_samples![0]!;
    expect(s.status).toBe('ACCEPTED');
    expect(s.corrected).toBe(extracted);
  });
});
