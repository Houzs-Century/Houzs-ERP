import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { listMfgProductsHandler } from '../src/scm/routes/mfg-products';
import { listProductModelsHandler } from '../src/scm/routes/product-models';

/* ────────────────────────────────────────────────────────────────────────────
   SO PRODUCT PICKERS — company isolation, BOTH directions.

   The owner reported the SO product picker showing the OTHER company's products
   in both directions (Houzs <-> 2990). The query IS company-scoped
   (scopeToCompany), but GET /mfg-products and GET /product-models return
   `Cache-Control: private, max-age=60` and, before this fix, carried NO
   `Vary: X-Company-Id`. The active company travels in the X-Company-Id request
   header, so the browser reused the previous company's cached list for up to a
   minute after a top-bar switch (a full page reload does not bypass a still-fresh
   fetch response).

   These drive the EXPORTED list handlers on a bare Hono app whose middleware
   injects a fake scm supabase + the active companyId (the supabaseAuth bridge
   can't run in the harness — same approach as fairReport.route.test.ts). They
   pin two claims that are different: (a) the read is scoped to the active company
   both ways, and (b) the response Varies on X-Company-Id so the cache can't leak.
   ──────────────────────────────────────────────────────────────────────────── */

// ── Fake PostgREST query builder — records predicates, applies to canned rows ──
class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  or() { return this; } // search branch — unused here, must not throw
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.preds.push((r) => r[col] != null);
    return this;
  }
  private apply() {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    return out;
  }
  range(from: number, to: number) { this._range = [from, to]; return this; }
  then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.apply(), error: null as null }).then(res, rej);
  }
}

type DataSet = Record<string, Array<Record<string, unknown>>>;
function fakeSupabase(data: DataSet) {
  return { from: (table: string) => new FakeQuery(data[table] ?? []) };
}

function fixture(): DataSet {
  return {
    mfg_products: [
      { id: 'h1', code: 'H-SOFA-1', name: 'Houzs Sofa', category: 'SOFA', status: 'ACTIVE', company_id: 1, model_id: 'hm1' },
      { id: 'h2', code: 'H-BED-1', name: 'Houzs Bed', category: 'BEDFRAME', status: 'ACTIVE', company_id: 1, model_id: null },
      { id: 'x1', code: 'X-SOFA-1', name: '2990 Sofa', category: 'SOFA', status: 'ACTIVE', company_id: 2, model_id: 'xm1' },
      { id: 'x2', code: 'X-BED-1', name: '2990 Bed', category: 'BEDFRAME', status: 'ACTIVE', company_id: 2, model_id: null },
      // A discontinued Houzs SKU — must never appear (status gate), regardless of company.
      { id: 'h3', code: 'H-OLD-1', name: 'Houzs Old', category: 'SOFA', status: 'DISCONTINUED', company_id: 1, model_id: null },
      // BUG-50: an ACTIVE SKU under a deactivated Model (the join arrives embedded).
      { id: 'h4', code: 'H-PROTECTOR-K', name: 'Houzs Protector', category: 'ACCESSORY', status: 'ACTIVE', company_id: 1, model_id: 'hm2', model: { allowed_options: null, active: false } },
    ],
    product_models: [
      { id: 'hm1', model_code: 'HM1', category: 'SOFA', company_id: 1, allowed_options: { seat: ['a'] } },
      { id: 'xm1', model_code: 'XM1', category: 'SOFA', company_id: 2, allowed_options: { seat: ['b'] } },
    ],
  };
}

/** Bare app that injects the fake supabase + an active company id. `companyId
 *  === null` models the UNRESOLVED state (pre-migration / cold-start), where the
 *  scoping helpers deliberately no-op. */
function appFor(companyId: number | null, handler: (c: never) => unknown, path: string) {
  const supabase = fakeSupabase(fixture());
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, supabase as never);
    if (companyId !== null) {
      c.set('companyId' as never, companyId as never);
      c.set('allowedCompanyIds' as never, [1, 2] as never);
    }
    await next();
  });
  app.get(path, handler as never);
  return app;
}

async function mfgCodes(companyId: number | null): Promise<{ codes: string[]; res: Response }> {
  const res = await appFor(companyId, listMfgProductsHandler, '/mfg-products').request('/mfg-products');
  const body = (await res.clone().json()) as { products: Array<{ code: string }> };
  return { codes: body.products.map((p) => p.code).sort(), res };
}

async function modelCodes(companyId: number | null): Promise<{ codes: string[]; res: Response }> {
  const res = await appFor(companyId, listProductModelsHandler, '/product-models').request('/product-models');
  const body = (await res.clone().json()) as { models: Array<{ model_code: string }> };
  return { codes: body.models.map((m) => m.model_code).sort(), res };
}

describe('GET /mfg-products — the SKU picker isolates by active company', () => {
  test('Houzs (company 1) sees ONLY Houzs active SKUs — not 2990, not discontinued', async () => {
    const { codes } = await mfgCodes(1);
    expect(codes).toEqual(['H-BED-1', 'H-SOFA-1']);
    expect(codes.some((c) => c.startsWith('X-'))).toBe(false);
  });

  test('2990 (company 2) sees ONLY 2990 active SKUs — the other direction', async () => {
    const { codes } = await mfgCodes(2);
    expect(codes).toEqual(['X-BED-1', 'X-SOFA-1']);
    expect(codes.some((c) => c.startsWith('H-'))).toBe(false);
  });

  test('BUG-50: a SKU whose Model was deactivated is not offered, even with its own status ACTIVE', async () => {
    const { codes } = await mfgCodes(1);
    expect(codes).not.toContain('H-PROTECTOR-K');
  });

  test('the response Varies on X-Company-Id so the private cache cannot leak across a switch', async () => {
    const { res } = await mfgCodes(1);
    expect(res.headers.get('vary')).toBe('X-Company-Id');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });

  test('UNRESOLVED company (pre-migration / cold-start) degrades to single-company: no predicate', async () => {
    // scopeToCompany no-ops when the active company is unresolved, so a
    // single-company Houzs install keeps serving its whole active catalogue.
    const { codes } = await mfgCodes(null);
    expect(codes).toEqual(['H-BED-1', 'H-SOFA-1', 'X-BED-1', 'X-SOFA-1']);
  });
});

describe('GET /product-models — the sofa-model picker isolates by active company', () => {
  test('Houzs (company 1) sees ONLY Houzs models', async () => {
    const { codes } = await modelCodes(1);
    expect(codes).toEqual(['HM1']);
  });

  test('2990 (company 2) sees ONLY 2990 models — the other direction', async () => {
    const { codes } = await modelCodes(2);
    expect(codes).toEqual(['XM1']);
  });

  test('the response Varies on X-Company-Id', async () => {
    const { res } = await modelCodes(1);
    expect(res.headers.get('vary')).toBe('X-Company-Id');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });
});
