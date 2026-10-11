import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { listInventoryHandler } from '../src/scm/routes/inventory';

/* ────────────────────────────────────────────────────────────────────────────
   INVENTORY "all SKUs" view (GET /inventory?showAll=true) — company isolation,
   BOTH directions. Isolation sweep item A3.

   The leak: showAll reads scm.v_inventory_all_skus, which CROSS JOINs
   mfg_products x warehouses with NO company predicate and (before mig 0154) NO
   company_id column, so the route DELIBERATELY skipped scoping it. A user in one
   company therefore saw the OTHER company's catalogue, warehouses, on-hand qty,
   valuation and main supplier. Migration 0154 adds company_id to the view (and
   pairs a product only with its own company's warehouse); this handler now scopes
   EVERY read — the default balances read AND the showAll rollup — by the active
   company.

   These drive the EXPORTED handler on a bare Hono app whose middleware injects a
   fake scm supabase + the active companyId (the supabaseAuth bridge can't run in
   the harness — same approach as productPickerCompanyScope.route tests).

   NOTE: the view's own SQL (the cross join + `p.company_id = w.company_id`
   pairing + the appended company_id) is PL/pgSQL-free but still a DB view, so it
   cannot execute in this harness — it is validated STAGING-FIRST (see the 0154
   header). What this test pins is the ROUTE contract: showAll now applies the
   `.eq('company_id', <active>)` predicate, so a fixture that tags each row with a
   company_id can only ever come back with the active company's rows — including
   the crucial COLLIDING-CODE case (a product_code that exists in both companies),
   which is exactly what a cross-company qty leak looks like.
   ──────────────────────────────────────────────────────────────────────────── */

// ── Fake PostgREST query builder — records predicates, applies to canned rows ──
class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  or() { return this; } // search / warehouses OR branch — no-op, must not throw
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
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

// SHARED-(K) is the colliding-code case: it exists in BOTH companies (staging has
// 17 such codes today — CODY-(K), FENRIR-(Q), ...). Each company's row must show
// ONLY its own qty / product name / warehouse, never the other's.
function fixture(): DataSet {
  return {
    v_inventory_all_skus: [
      { product_code: 'H-SOFA-1', product_name: 'Houzs Sofa', warehouse_id: 'wh1', warehouse_code: 'KL', warehouse_name: 'KL Warehouse', category: 'SOFA', size_label: null, qty: 5, last_movement_at: '2026-07-01', value_sen: 5000, main_supplier_code: 'HS1', main_supplier_name: 'Houzs Supplier', company_id: 1 },
      { product_code: 'SHARED-(K)', product_name: 'Houzs Shared King', warehouse_id: 'wh1', warehouse_code: 'KL', warehouse_name: 'KL Warehouse', category: 'BEDFRAME', size_label: 'K', qty: 3, last_movement_at: '2026-07-02', value_sen: 3000, main_supplier_code: 'HS1', main_supplier_name: 'Houzs Supplier', company_id: 1 },
      { product_code: 'X-BED-1', product_name: '2990 Bed', warehouse_id: 'wh2', warehouse_code: 'PJ', warehouse_name: 'PJ Warehouse', category: 'BEDFRAME', size_label: null, qty: 7, last_movement_at: '2026-07-03', value_sen: 7000, main_supplier_code: 'XS1', main_supplier_name: '2990 Supplier', company_id: 2 },
      { product_code: 'SHARED-(K)', product_name: '2990 Shared King', warehouse_id: 'wh2', warehouse_code: 'PJ', warehouse_name: 'PJ Warehouse', category: 'BEDFRAME', size_label: 'K', qty: 9, last_movement_at: '2026-07-04', value_sen: 9000, main_supplier_code: 'XS1', main_supplier_name: '2990 Supplier', company_id: 2 },
    ],
    warehouses: [
      { id: 'wh1', code: 'KL', name: 'KL Warehouse', is_consignment: false },
      { id: 'wh2', code: 'PJ', name: 'PJ Warehouse', is_consignment: false },
    ],
  };
}

type Balance = {
  product_code: string; product_name: string; qty: number;
  warehouse_id: string; value_sen: number; company_id: number;
};

/** Bare app that injects the fake supabase + an active company id. `companyId
 *  === null` models the UNRESOLVED state (pre-migration / cold-start), where the
 *  scoping helper deliberately no-ops. */
function appFor(companyId: number | null) {
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
  app.get('/', listInventoryHandler as never);
  return app;
}

async function showAll(companyId: number | null): Promise<Balance[]> {
  const res = await appFor(companyId).request('/?showAll=true');
  const body = (await res.json()) as { balances: Balance[] };
  return body.balances;
}

const codesOf = (rows: Balance[]) => rows.map((r) => r.product_code).sort();

describe('GET /inventory?showAll=true — the all-SKUs rollup isolates by active company (A3)', () => {
  test('Houzs (company 1) sees ONLY its own SKUs — not 2990 products, warehouses or stock', async () => {
    const rows = await showAll(1);
    expect(codesOf(rows)).toEqual(['H-SOFA-1', 'SHARED-(K)']);
    // No 2990-only product.
    expect(rows.some((r) => r.product_code === 'X-BED-1')).toBe(false);
    // No 2990 warehouse anywhere in the result.
    expect(rows.every((r) => r.warehouse_id === 'wh1')).toBe(true);
    expect(rows.every((r) => r.company_id === 1)).toBe(true);
  });

  test('2990 (company 2) sees ONLY its own SKUs — the other direction', async () => {
    const rows = await showAll(2);
    expect(codesOf(rows)).toEqual(['SHARED-(K)', 'X-BED-1']);
    expect(rows.some((r) => r.product_code === 'H-SOFA-1')).toBe(false);
    expect(rows.every((r) => r.warehouse_id === 'wh2')).toBe(true);
    expect(rows.every((r) => r.company_id === 2)).toBe(true);
  });

  test('a COLLIDING product_code (SHARED-(K)) returns each company its OWN qty, never the sum', async () => {
    const h = (await showAll(1)).find((r) => r.product_code === 'SHARED-(K)')!;
    const x = (await showAll(2)).find((r) => r.product_code === 'SHARED-(K)')!;
    // Houzs sees 3 (its own), 2990 sees 9 (its own) — never 12, and never each
    // other's product name.
    expect(h.qty).toBe(3);
    expect(h.product_name).toBe('Houzs Shared King');
    expect(x.qty).toBe(9);
    expect(x.product_name).toBe('2990 Shared King');
  });

  test('UNRESOLVED company (pre-migration / cold-start) degrades to single-company: no predicate', async () => {
    // scopeToCompany no-ops when the active company is unresolved, so a
    // single-company Houzs install keeps serving its whole all-SKUs rollup.
    const rows = await showAll(null);
    expect(rows).toHaveLength(4);
    expect(codesOf(rows)).toEqual(['H-SOFA-1', 'SHARED-(K)', 'SHARED-(K)', 'X-BED-1']);
  });
});
