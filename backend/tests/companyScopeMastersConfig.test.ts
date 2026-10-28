// Company scoping on the MASTER + CONFIG write paths closed in this pass (the
// "A4/A5" group from the isolation sweep — cross-company master/config leaks
// beyond #851). Sibling of companyScopeHardening.test.ts (items 3-9) and
// companyWriteScope.test.ts (items 1-2).
//
// Same harness as companyScopeHardening.test.ts: a bare Hono app whose
// middleware injects a fake scm supabase client + a company context, mounting
// the EXPORTED handlers rather than the routers (the supabaseAuth bridge can't
// run here).
//
// EVERY item is asserted in BOTH directions, deliberately. The failure mode of
// a scope sweep is not "the leak stayed open", it is "we hid a company's own
// data from its own users" — an outage nobody reports. So each leak test is
// paired with a same-company test proving the legitimate request still works,
// and each cross-company test also asserts the victim row was left UNCHANGED (a
// 404 that still mutated would pass a status-only assertion).
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchSupplierHandler } from '../src/scm/routes/suppliers';
import { deleteMfgProductHandler } from '../src/scm/routes/mfg-products';
import { patchAddonHandler } from '../src/scm/routes/addons';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — same shape as companyScopeHardening's.
   Every builder method chains and an unknown table reads as empty rather than
   throwing; the assertions are about the company predicate, not the rest. */
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
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/suppliers/:id', patchSupplierHandler as never);
  app.delete('/mfg-products/:id', deleteMfgProductHandler as never);
  app.patch('/addons/:id', patchAddonHandler as never);
  return { app, log };
}

const jsonPatch = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// ── A4 — suppliers.ts: supplier PII + costing edit ───────────────────────────
describe('A4 — supplier edit (PATCH /suppliers/:id)', () => {
  const suppliers = (): Row[] => [
    { id: 's-a', code: 'SUP-A', name: 'Alpha Supplies', company_id: CO_A },
    { id: 's-b', code: 'SUP-B', name: 'Beta Supplies', company_id: CO_B },
  ];

  test("A cannot edit B's supplier, and B's row is unchanged", async () => {
    const t = { suppliers: suppliers() };
    const res = await jsonPatch(harness(t, CO_A).app, '/suppliers/s-b', { name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('not_found_in_company');
    expect(t.suppliers.find((s) => s.id === 's-b')!.name).toBe('Beta Supplies');
  });

  test('A CAN still edit its own supplier', async () => {
    const t = { suppliers: suppliers() };
    const res = await jsonPatch(harness(t, CO_A).app, '/suppliers/s-a', { name: 'Alpha Renamed' });
    expect(res.status).toBe(200);
    expect(t.suppliers.find((s) => s.id === 's-a')!.name).toBe('Alpha Renamed');
  });

  test('an unresolved company refuses rather than editing across all companies', async () => {
    const t = { suppliers: suppliers() };
    const res = await jsonPatch(harness(t, undefined).app, '/suppliers/s-a', { name: 'X' });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.suppliers.find((s) => s.id === 's-a')!.name).toBe('Alpha Supplies');
  });
});

// ── A4 — mfg-products.ts: SKU delete ─────────────────────────────────────────
describe('A4 — SKU delete (DELETE /mfg-products/:id)', () => {
  const products = (): Row[] => [
    { id: 'p-a', code: 'SKU-A', company_id: CO_A, status: 'ACTIVE' },
    { id: 'p-b', code: 'SKU-B', company_id: CO_B, status: 'ACTIVE' },
  ];

  test("A cannot delete B's SKU, and B's SKU survives", async () => {
    const t = { mfg_products: products() };
    const res = await harness(t, CO_A).app.request('/mfg-products/p-b', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('not_found_in_company');
    expect(t.mfg_products.some((p) => p.id === 'p-b')).toBe(true);
  });

  test('A CAN still delete its own SKU', async () => {
    const t = { mfg_products: products() };
    const res = await harness(t, CO_A).app.request('/mfg-products/p-a', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(t.mfg_products.some((p) => p.id === 'p-a')).toBe(false);
  });

  test('an unresolved company refuses rather than deleting across all companies', async () => {
    const t = { mfg_products: products() };
    const res = await harness(t, undefined).app.request('/mfg-products/p-a', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.mfg_products.some((p) => p.id === 'p-a')).toBe(true);
  });
});

// ── A5 — addons.ts: order add-on config edit ─────────────────────────────────
describe('A5 — add-on edit (PATCH /addons/:id)', () => {
  const addons = (): Row[] => [
    { id: 'dispose', company_id: CO_A, label: 'Dispose', enabled: true, kind: 'flat', price: 5000 },
    { id: 'lift', company_id: CO_B, label: 'Lift', enabled: true, kind: 'flat', price: 8000 },
  ];

  test("A cannot edit B's add-on, and B's row is unchanged", async () => {
    const t = { addons: addons() };
    const res = await jsonPatch(harness(t, CO_A).app, '/addons/lift', { enabled: false });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('not_found_in_company');
    expect(t.addons.find((a) => a.id === 'lift')!.enabled).toBe(true);
  });

  test('A CAN still edit its own add-on', async () => {
    const t = { addons: addons() };
    const res = await jsonPatch(harness(t, CO_A).app, '/addons/dispose', { enabled: false });
    expect(res.status).toBe(200);
    expect(t.addons.find((a) => a.id === 'dispose')!.enabled).toBe(false);
  });
});
