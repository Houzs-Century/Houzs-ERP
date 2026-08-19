// Cross-company (multi-tenant) isolation for the leaks NOT covered by
// crossTenantLeaksRound2 (projects/assr by-id writes) nor by
// companyScopeConsignmentPo (the by-id status/cancel writes). The SCM/Houzs
// supabase client is SERVICE-ROLE and bypasses RLS, so a hand-written
// `company_id` predicate on each statement IS the whole tenant boundary.
//
// Findings proven here (see BUG-HISTORY.md 2026-08-19):
//   2. mfg-purchase-orders POST /   — a caller-supplied soItemId from another
//      company was linked onto this company's PO (and its po_qty_picked rolled).
//   3. consignment-orders POST /:docNo/items/:itemId/override — re-prices a
//      line (WRITES MONEY) but never checked scm.so.price_override.
//   4. sofa-combos PUT /:id          — read the source combo by id unscoped, so
//      an edit could clone ANOTHER company's combo price.
//   5. warehouse POST /racks         — inserted racks against a caller-supplied
//      warehouse uuid without verifying it belongs to the active company.
//   6. suppliers POST /:id/bindings[/batch] — stamped company_id on a binding
//      for a supplier that may belong to another company.
//
// Findings 1 (PWP burn) and 2 (PO SO-link) also carry source-anchored wiring
// assertions at the bottom — the guard lives inside a >10k-line core that the
// repo pins by ?raw source anchors (see soConfirmGateWiring.test.ts).
//
// Same fake-PostgREST harness as companyScopeConsignmentPo.test.ts: a bare Hono
// app injects a fake scm supabase client + a company context and mounts the
// EXPORTED handlers (the supabaseAuth bridge cannot run here). Every finding is
// asserted in BOTH directions — A cannot touch B's row (refused, victim
// byte-unchanged) AND A can still act on its OWN row.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';
import poSource from '../src/scm/routes/mfg-purchase-orders.ts?raw';
import { createMfgPurchaseOrderHandler } from '../src/scm/routes/mfg-purchase-orders';
import { consignmentOverridePriceHandler } from '../src/scm/routes/consignment-orders';
import { sofaComboPutHandler } from '../src/scm/routes/sofa-combos';
import { createWarehouseRacksHandler } from '../src/scm/routes/warehouse';
import { createSupplierBindingHandler, createSupplierBindingsBatchHandler } from '../src/scm/routes/suppliers';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — a copy of the one in
   companyScopeConsignmentPo.test.ts, plus `filter`. Every method chains and an
   unknown table reads empty rather than throwing, so a handler can reach far
   past the statement under assertion (audit probes, recomputes) without the
   test having to model all of it. */
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
  like() { return this; }
  filter() { return this; }
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

function harness(
  tables: Record<string, Row[]>,
  companyId: number | undefined,
  perms: string[] = ['*'],
) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(perms) } as never);
    // canViewScmFinance / write-back read c.env — provide an empty env.
    c.env = {} as never;
    await next();
  });
  app.post('/mfg-pos', createMfgPurchaseOrderHandler as never);
  app.post('/consignment/:docNo/items/:itemId/override', consignmentOverridePriceHandler as never);
  app.put('/sofa-combos/:id', sofaComboPutHandler as never);
  app.post('/warehouse/racks', createWarehouseRacksHandler as never);
  app.post('/suppliers/:id/bindings', createSupplierBindingHandler as never);
  app.post('/suppliers/:id/bindings/batch', createSupplierBindingsBatchHandler as never);
  return { app, log, tables };
}

const jsonPost = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const jsonPut = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// ── Finding 2 — mfg PO create must not link another company's SO line ────────
describe('mfg PO create — cross-company SO line link', () => {
  const soItems = (): Row[] => [
    { id: 'so-a', doc_no: 'HC-SO-A-1', company_id: CO_A, qty: 5, po_qty_picked: 0, item_code: 'X', cancelled: false },
    { id: 'so-b', doc_no: '2990-SO-B-1', company_id: CO_B, qty: 5, po_qty_picked: 0, item_code: 'X', cancelled: false },
  ];
  const body = (soItemId: string): Row => ({
    supplierId: 'sup-1',
    expectedAt: '2026-09-01',
    purchaseLocationId: 'wh-1',
    currency: 'MYR',
    items: [{ soItemId, itemCode: 'X', qty: 1, unitPriceSen: 100 }],
  });

  test("A cannot create a PO linked to B's SO line, and B's po_qty_picked stays 0", async () => {
    const t = { mfg_sales_order_items: soItems() };
    const res = await jsonPost(harness(t, CO_A).app, '/mfg-pos', body('so-b'));
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('so_line_not_found');
    expect(t.mfg_sales_order_items.find((r) => r.id === 'so-b')!.po_qty_picked).toBe(0);
    // No PO header/lines minted for the refused create.
    expect((t as Row).purchase_orders ?? []).toHaveLength(0);
  });

  test('an unresolved company degrades (single-company) — no false cross-company 404', async () => {
    // companyId undefined => scopeToCompany no-ops, so an in-tree SO line resolves.
    const t = { mfg_sales_order_items: soItems() };
    const res = await jsonPost(harness(t, undefined).app, '/mfg-pos', body('so-a'));
    expect(res.status).not.toBe(404);
  });
});

// ── Finding 3 — consignment price override needs scm.so.price_override ────────
describe('consignment line price override — permission + company scope', () => {
  const co = (): Row[] => [
    { id: 'cso-a', doc_no: 'HC-CSO-A-1', company_id: CO_A, status: 'PROCESSING' },
    { id: 'cso-b', doc_no: '2990-CSO-B-1', company_id: CO_B, status: 'PROCESSING' },
  ];
  const items = (): Row[] => [
    { id: 'it-b', doc_no: '2990-CSO-B-1', company_id: CO_B, item_code: 'X', unit_price_sen: 9900, qty: 1, discount_sen: 0, line_cost_sen: 5000 },
  ];

  test('a caller with only scm.so.view_all is refused (403), before any read', async () => {
    const t = { consignment_sales_orders: co(), consignment_sales_order_items: items() };
    const res = await jsonPost(
      harness(t, CO_A, ['scm.so.view_all']).app,
      '/consignment/HC-CSO-A-1/items/it-a/override',
      { overridePriceSen: 1 },
    );
    expect(res.status).toBe(403);
    expect((await res.json() as Row).error).toBe('price_override_admin_only');
  });

  test("A (admin) cannot re-price B's consignment line, and B's price stays 9900", async () => {
    const t = { consignment_sales_orders: co(), consignment_sales_order_items: items() };
    const res = await jsonPost(
      harness(t, CO_A, ['*']).app,
      '/consignment/2990-CSO-B-1/items/it-b/override',
      { overridePriceSen: 1 },
    );
    expect(res.status).toBe(404);
    expect(t.consignment_sales_order_items.find((r) => r.id === 'it-b')!.unit_price_sen).toBe(9900);
  });
});

// ── Finding 4 — sofa combo edit reads the source combo scoped ────────────────
describe('sofa combo PUT /:id — source combo read is company-scoped', () => {
  const combos = (): Row[] => [
    { id: 'sc-a', company_id: CO_A, base_model: 'M', modules: [['s']], tier: 'PRICE_1', customer_id: null, supplier_id: null, selling_prices_by_height: { '40': 100 }, pwp_prices_by_height: null, default_free_gifts: [], deleted_at: null },
    { id: 'sc-b', company_id: CO_B, base_model: 'M', modules: [['s']], tier: 'PRICE_1', customer_id: null, supplier_id: null, selling_prices_by_height: { '40': 100 }, pwp_prices_by_height: null, default_free_gifts: [], deleted_at: null },
  ];
  const body = (): Row => ({
    pricesByHeight: { '40': 50 },
    sellingPricesByHeight: { '40': 120 },
    effectiveFrom: '2026-09-01',
  });

  test("A cannot edit B's combo (404), and no clone is minted into company A", async () => {
    const t = { sofa_combo_pricing: combos() };
    const before = t.sofa_combo_pricing.length;
    const res = await jsonPut(harness(t, CO_A, ['*']).app, '/sofa-combos/sc-b', body());
    expect(res.status).toBe(404);
    // The unscoped read would have cloned sc-b's tuple into a NEW company-A row.
    expect(t.sofa_combo_pricing.length).toBe(before);
    expect(t.sofa_combo_pricing.some((r) => r.company_id === CO_A && r.id !== 'sc-a')).toBe(false);
  });

  test('A CAN edit its own combo (new effective row minted for company A)', async () => {
    const t = { sofa_combo_pricing: combos() };
    const res = await jsonPut(harness(t, CO_A, ['*']).app, '/sofa-combos/sc-a', body());
    expect(res.status).toBe(201);
    expect(t.sofa_combo_pricing.some((r) => r.company_id === CO_A && r.selling_prices_by_height?.['40'] === 120)).toBe(true);
  });
});

// ── Finding 5 — rack create validates the target warehouse's company ─────────
describe('warehouse POST /racks — warehouse ownership', () => {
  const warehouses = (): Row[] => [
    { id: 'wh-a', company_id: CO_A, is_active: true },
    { id: 'wh-b', company_id: CO_B, is_active: true },
  ];

  test("A cannot create a rack into B's warehouse (no rack row is inserted)", async () => {
    const t = { warehouses: warehouses(), warehouse_racks: [] as Row[] };
    const res = await jsonPost(harness(t, CO_A, ['*']).app, '/warehouse/racks', { warehouseId: 'wh-b', rack: 'R1' });
    expect(res.status).toBe(400); // foreign warehouse filtered out -> no targets
    expect(t.warehouse_racks).toHaveLength(0);
  });

  test('A CAN create a rack into its own warehouse', async () => {
    const t = { warehouses: warehouses(), warehouse_racks: [] as Row[] };
    const res = await jsonPost(harness(t, CO_A, ['*']).app, '/warehouse/racks', { warehouseId: 'wh-a', rack: 'R1' });
    expect(res.status).toBe(201);
    expect(t.warehouse_racks.some((r) => r.warehouse_id === 'wh-a' && r.company_id === CO_A)).toBe(true);
  });
});

// ── Finding 6 — supplier binding create validates supplier ownership ─────────
describe('suppliers POST /:id/bindings[/batch] — supplier ownership', () => {
  const suppliersRows = (): Row[] => [
    { id: 'sup-a', company_id: CO_A },
    { id: 'sup-b', company_id: CO_B },
  ];
  const bindingBody = (): Row => ({
    materialKind: 'mfg_product', itemCode: 'X', materialName: 'X', supplierSku: 'SKU1',
  });

  test("A cannot bind a material to B's supplier (no binding inserted)", async () => {
    const t = { suppliers: suppliersRows(), supplier_material_bindings: [] as Row[] };
    const res = await jsonPost(harness(t, CO_A, ['*']).app, '/suppliers/sup-b/bindings', bindingBody());
    expect(res.status).toBe(404);
    expect(t.supplier_material_bindings).toHaveLength(0);
  });

  test('A CAN bind a material to its own supplier', async () => {
    const t = { suppliers: suppliersRows(), supplier_material_bindings: [] as Row[] };
    const res = await jsonPost(harness(t, CO_A, ['*']).app, '/suppliers/sup-a/bindings', bindingBody());
    expect(res.status).toBe(201);
    expect(t.supplier_material_bindings.some((r) => r.supplier_id === 'sup-a' && r.company_id === CO_A)).toBe(true);
  });

  test("A cannot batch-bind to B's supplier (no binding inserted)", async () => {
    const t = { suppliers: suppliersRows(), supplier_material_bindings: [] as Row[] };
    const res = await jsonPost(harness(t, CO_A, ['*']).app, '/suppliers/sup-b/bindings/batch', {
      bindings: [bindingBody()],
    });
    expect(res.status).toBe(404);
    expect(t.supplier_material_bindings).toHaveLength(0);
  });
});

// ── Findings 1 & 2 — source-anchored wiring (guard lives in a >10k-line core) ─
describe('PWP voucher burn is company-scoped (createSalesOrderCore)', () => {
  const between = (hay: string, start: string, end: string): string => {
    const s = hay.indexOf(start);
    expect(s, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
    const e = hay.indexOf(end, s + start.length);
    expect(e, `anchor not found after ${start}: ${end}`).toBeGreaterThan(s);
    return hay.slice(s, e);
  };

  // Whitespace-insensitive contains — the ?raw source keeps its own indentation.
  const squish = (s: string) => s.replace(/\s+/g, ' ');
  const hasSquished = (hay: string, needle: string) =>
    squish(hay).includes(squish(needle));

  test('the create-loop prefetch, burn and rollback all carry .eq(company_id)', () => {
    const block = between(routeSource, 'const allPwpCodes = Array.from', 'Default Free Gift validation');
    // one resolved company id, refused up front
    expect(block).toContain('const pwpCompanyId = activeCompanyId(c)');
    expect(block).toContain("error: 'company_unresolved'");
    // read + atomic burn + rollback each scoped
    expect(hasSquished(block, ".in('code', allPwpCodes) .eq('company_id', pwpCompanyId)")).toBe(true);
    expect(hasSquished(block, ".eq('code', code) .eq('company_id', pwpCompanyId)")).toBe(true);
    expect(hasSquished(block, ".eq('code', code).eq('status', 'USED').eq('company_id', pwpCompanyId)")).toBe(true);
  });

  test('the swap reads scope pwp_codes to the active company', () => {
    // both swap-line reads go through scopeToCompany(...) rather than a bare eq(code)
    expect(hasSquished(routeSource, "scopeToCompany(sb.from('pwp_codes') .select('code, reward_category")).toBe(true);
    expect(hasSquished(routeSource, "scopeToCompany(sb.from('pwp_codes') .select('code, reward_combo_ids")).toBe(true);
  });
});

describe('PO create SO-link is company-scoped (source-anchored)', () => {
  test('the create-gate scopes the SO-item read and refuses a foreign soItemId', () => {
    const s = poSource.indexOf('const lineSoItemIds = items');
    expect(s).toBeGreaterThan(0);
    const block = poSource.slice(s, s + 1600);
    expect(block).toContain('scopeToCompany(');
    expect(block).toContain('foreignSoItemId');
    expect(block).toContain("error: 'so_line_not_found'");
  });
});
