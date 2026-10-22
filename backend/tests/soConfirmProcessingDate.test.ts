// HC-0113 (Sim 2026-10-16): HC-SO-2609-077 was drafted with Processing Date 18/9
// and confirmed on 13/10, and reached purchasing still dated 18/9. A DRAFT
// confirm now proceeds on the confirm day when the stored date has passed; the
// rule is processingDateOnConfirm (shared/so-proceeded-status.ts), this pins the
// route that desktop and mobile both confirm through.
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
const DOC = 'HC-SO-2609-077';

function world(dates: { proc: string | null; deliv: string | null }) {
  tables = {
    mfg_sales_orders: [{
      doc_no: DOC, company_id: CO, status: 'DRAFT', version: 2, debtor_code: 'C1',
      salesperson_id: 'staff-1', venue: 'SUNWAY PYRAMID',
      debtor_name: 'LIM YEW SHEN', phone: '+60122200495', address1: 'B-08-16 Block B',
      city: 'Subang Jaya', postcode: '47500', customer_state: 'Selangor',
      processing_date: dates.proc, customer_delivery_date: dates.deliv,
    }],
    mfg_sales_order_items: [],
    mfg_so_audit_log: [],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, client() as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Mei Ting' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Mei Ting', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/mfg-sales-orders/:docNo/status', patchMfgSalesOrderStatusHandler as never);
  return app;
}

const confirm = (app: Hono) => app.request(`/mfg-sales-orders/${DOC}/status`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'CONFIRMED', expectedStatus: 'DRAFT', version: 2 }),
}, { DB: {} });

const so = () => tables.mfg_sales_orders![0]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T09:14:00Z')); // 17:14 MYT
});
afterEach(() => { vi.useRealTimers(); });

describe('HC-0113: confirming a draft whose Processing Date has passed', () => {
  test('moves the Processing Date to the confirm day and logs it beside the status', async () => {
    const app = world({ proc: '2026-09-18', deliv: '2026-10-26' });
    expect((await confirm(app)).status).toBe(200);
    expect(so().processing_date).toBe('2026-10-13');
    expect(so().status).toBe('IN_PRODUCTION');
    const audit = tables.mfg_so_audit_log!.find((r) => r.action === 'UPDATE_STATUS')!;
    expect(audit.field_changes).toContainEqual({ field: 'processingDate', from: '2026-09-18', to: '2026-10-13' });
  });

  test('keeps a Processing Date of today or later', async () => {
    const app = world({ proc: '2026-10-20', deliv: '2026-10-26' });
    expect((await confirm(app)).status).toBe(200);
    expect(so().processing_date).toBe('2026-10-20');
    const audit = tables.mfg_so_audit_log!.find((r) => r.action === 'UPDATE_STATUS')!;
    expect(audit.field_changes.some((f: Row) => f.field === 'processingDate')).toBe(false);
  });

  test('refuses when the Delivery Date has passed too, and leaves the draft as it was', async () => {
    const app = world({ proc: '2026-09-18', deliv: '2026-10-01' });
    const res = await confirm(app);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; problems: Array<{ code: string }> };
    expect(body.error).toBe('validation_failed');
    expect(body.problems.map((p) => p.code)).toEqual(['confirm_delivery_date_past']);
    expect(so().status).toBe('DRAFT');
    expect(so().processing_date).toBe('2026-09-18');
  });

  test('a draft with no dates confirms as before', async () => {
    const app = world({ proc: null, deliv: null });
    expect((await confirm(app)).status).toBe(200);
    expect(so().status).toBe('CONFIRMED');
    expect(so().processing_date).toBeNull();
  });
});
