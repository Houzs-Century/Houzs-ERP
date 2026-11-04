import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { mfgSalesOrders, tbcSwapSofaCommandHandler, tbcUpdateCommandHandler } from '../src/scm/routes/mfg-sales-orders';

/** Inclusion is a server result. A client must not create a stored marker on
 *  an ordinary line and then have the next colour edit treat that line as free. */
const reserved: Array<[string, unknown]> = [
  ['sofaComboIncluded', { buildKey: 'forged', pieceIds: ['piece'] }],
  ['sofaAccessoryGroupKey', 'forged'],
  ['sofaAccessories', [{ id: 'piece', modelId: 'cushion', cellId: 'cell' }]],
  ['sofaAccessoryOfKey', 'forged-parent'],
  ['sofaAccessoryPieceIds', ['piece']],
];

function harness() {
  const from = vi.fn(() => { throw new Error('A refused payload must not reach the database.'); });
  const rpc = vi.fn(() => { throw new Error('A refused payload must not run an RPC.'); });
  const sb = { from, rpc };
  const app = new Hono();
  app.use('*', async (c, next) => {
    // The auth bridge has already adapted the signed-in caller in production.
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 42, name: 'Salesperson' } as never);
    c.set('companyId' as never, 2 as never);
    c.set('supabase' as never, sb as never);
    await next();
  });
  // Exercise the real add-line registration: a guard on PATCH alone does not
  // protect this separate INSERT entry point.
  app.route('/orders', mfgSalesOrders as never);
  app.post('/swap/:docNo/:itemId', (c) => tbcSwapSofaCommandHandler(c, sb));
  return { app, from, rpc };
}

describe('server-owned sofa combo markers at order mutation ingress', () => {
  it.each(reserved)('rejects %s through POST add-line before any database access', async (name, value) => {
    const { app, from, rpc } = harness();
    const res = await app.request('/orders/SO-TEST/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemCode: 'BC06', itemGroup: 'fabric_accessory', qty: 1, unitPriceSen: 25000, variants: { [name]: value } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'sofa_combo_requires_complete_order' });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(reserved)('rejects %s in replacement-sofa variants before any database access', async (name, value) => {
    const { app, from, rpc } = harness();
    const res = await app.request('/swap/SO-TEST/old-sofa', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { itemCode: 'SOFA-2NA', qty: 1, unitPriceSen: 112500,
        variants: { cells: [{ id: 'cell', moduleId: '2NA', x: 0, y: 0, rot: 0 }], depth: '24', [name]: value } } }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'sofa_combo_requires_complete_edit' });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps ordinary add-line validation reachable without any combo metadata', async () => {
    const { app, from, rpc } = harness();
    const res = await app.request('/orders/SO-TEST/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'item_code_required' });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

// Like soLineFreezeRoutes.test.ts, exercise the actual inline handler against
// an in-memory PostgREST surface. Every write is recorded for refusal checks.
type Row = Record<string, any>;
class StoredQuery {
  private predicates: Array<(row: Row) => boolean> = [];
  private operation = 'select';
  private patch: Row = {};
  private added: Row[] = [];
  constructor(private rows: Row[], private table: string, private writes: Array<{ table: string; operation: string; patch: Row }>) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  like() { return this; }
  gte() { return this; }
  lte() { return this; }
  gt() { return this; }
  lt() { return this; }
  not() { return this; }
  or() { return this; }
  filter() { return this; }
  contains() { return this; }
  eq(column: string, value: unknown) { this.predicates.push((row) => String(row[column]) === String(value)); return this; }
  neq(column: string, value: unknown) { this.predicates.push((row) => String(row[column]) !== String(value)); return this; }
  is(column: string, value: unknown) { this.predicates.push((row) => (row[column] ?? null) === value); return this; }
  in(column: string, values: unknown[]) { this.predicates.push((row) => values.map(String).includes(String(row[column]))); return this; }
  update(patch: Row) { this.operation = 'update'; this.patch = patch; return this; }
  delete() { this.operation = 'delete'; return this; }
  insert(rows: Row | Row[]) { this.operation = 'insert'; this.added = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[]) { return this.insert(rows); }
  private run() {
    if (this.operation !== 'select') this.writes.push({ table: this.table, operation: this.operation, patch: this.patch });
    if (this.operation === 'insert') { this.rows.push(...this.added); return this.added; }
    const matches = this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));
    if (this.operation === 'update') for (const row of matches) Object.assign(row, this.patch);
    if (this.operation === 'delete') for (const row of matches) this.rows.splice(this.rows.indexOf(row), 1);
    return matches;
  }
  private result(data: unknown) { return { data, error: null, count: Array.isArray(data) ? data.length : null }; }
  maybeSingle() { return Promise.resolve(this.result(this.run()[0] ?? null)); }
  single() { return this.maybeSingle(); }
  then(resolve: (value: any) => any, reject?: (error: any) => any) { return Promise.resolve(this.result(this.run())).then(resolve, reject); }
}

function storedHarness(includedParent = true) {
  const writes: Array<{ table: string; operation: string; patch: Row }> = [];
  const parent: Row = {
    id: 'sofa', doc_no: 'SO-TEST', company_id: 2, item_code: 'SOFA-2NA', item_group: 'sofa',
    qty: 1, unit_price_sen: 112500, discount_sen: 0, unit_cost_sen: 50000, total_sen: 112500,
    cancelled: false, line_no: 1,
    variants: {
      cells: [{ id: 'cell', moduleId: '2NA', x: 0, y: 0, rot: 0 }], depth: '24', fabricCode: 'BLUE',
      ...(includedParent ? {
        sofaAccessoryGroupKey: 'build-1',
        sofaAccessories: [{ id: 'piece', modelId: 'cushion', cellId: 'cell' }],
      } : {}),
    },
  };
  const child: Row = {
    id: 'cushion', doc_no: 'SO-TEST', company_id: 2, item_code: 'BC06', item_group: 'fabric_accessory',
    qty: 1, unit_price_sen: 0, discount_sen: 0, total_sen: 0, unit_cost_sen: 12000, cancelled: false, line_no: 2,
    variants: { fabricCode: 'BLUE', sofaComboIncluded: { buildKey: 'build-1', pieceIds: ['piece'] } },
  };
  const tables: Record<string, Row[]> = {
    mfg_sales_orders: [{
      doc_no: 'SO-TEST', company_id: 2, status: 'DRAFT', processing_date: null, salesperson_id: 42,
      edit_lease_token: 'lease', edit_lease_expires_at: new Date(Date.now() + 600000).toISOString(), edit_lease_user_id: 42,
    }],
    mfg_sales_order_items: includedParent ? [parent, child] : [parent],
    mfg_products: [
      { code: 'SOFA-2NA', company_id: 2, category: 'SOFA', status: 'ACTIVE', sell_price_sen: 250000 },
      { code: 'BC06', company_id: 2, category: 'FABRIC_ACCESSORY', status: 'ACTIVE', sell_price_sen: 25000 },
    ],
  };
  const sb = {
    from: (table: string) => new StoredQuery(tables[table] ||= [], table, writes),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: 42, name: 'Salesperson', permissions_set: new Set(['scm.so.view_all']) } as never);
    c.set('companyId' as never, 2 as never);
    c.set('companyCode' as never, '2990' as never);
    c.set('supabase' as never, sb as never);
    await next();
  });
  app.route('/orders', mfgSalesOrders as never);
  app.post('/colour/:docNo/:itemId', (c) => tbcUpdateCommandHandler(c, sb));
  const call = (body: Row, method = 'PATCH', path = '/orders/SO-TEST/items/sofa') => app.request(path, {
    method, headers: { 'Content-Type': 'application/json', 'X-SO-Edit-Lease': 'lease' },
    ...(method !== 'DELETE' ? { body: JSON.stringify(body) } : {}),
  }, {} as never, { waitUntil: () => undefined, passThroughOnException: () => undefined } as never);
  return { parent, child, tables, writes, call };
}

describe('editing an existing accessory-inclusive sofa parent', () => {
  it('keeps the stored package price on an untouched-variants description save', async () => {
    const { parent, child, call } = storedHarness();
    const variants = { ...parent.variants };
    delete variants.sofaAccessoryGroupKey; // Older clients omit server-owned keys.
    const res = await call({ description: 'Two seats with cushion', variants });
    expect(res.status, await res.text()).toBe(200);
    expect(parent.unit_price_sen).toBe(112500);
    expect(parent.variants.sofaAccessoryGroupKey).toBe('build-1');
    expect(child.unit_price_sen).toBe(0);
  });

  it.each([0, 250000])('ignores a replacement unit price of %s without losing the package price', async (unitPriceSen) => {
    const { parent, child, call } = storedHarness();
    const res = await call({ unitPriceSen });
    expect(res.status, await res.text()).toBe(200);
    expect(parent.unit_price_sen).toBe(112500);
    expect(child.unit_price_sen).toBe(0);
  });

  it('keeps the package base and included child at zero when the colour editor makes a same-tier change', async () => {
    const { parent, child, call } = storedHarness();
    const res = await call({ variants: { fabricCode: 'RED' } }, 'POST', '/colour/SO-TEST/sofa');
    expect(res.status, await res.text()).toBe(200);
    expect(parent.variants.fabricCode).toBe('RED');
    expect(parent.variants.sofaAccessoryGroupKey).toBe('build-1');
    expect(parent.unit_price_sen).toBe(112500);
    expect(child.unit_price_sen).toBe(0);
  });

  it.each([
    ['modules', (parent: Row) => ({ variants: { ...parent.variants, cells: [{ id: 'cell', moduleId: '1NA', x: 0, y: 0, rot: 0 }] } })],
    ['quantity', () => ({ qty: 2 })],
    ['cancelled', () => ({ cancelled: true })],
    ['colour outside its dedicated editor', (parent: Row) => ({ variants: { ...parent.variants, fabricCode: 'RED' } })],
  ] as const)('refuses changing %s before any write', async (_label, patch) => {
    const { parent, call, writes } = storedHarness();
    const before = structuredClone(parent);
    const res = await call(patch(parent));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'sofa_combo_requires_complete_edit' });
    expect(writes).toEqual([]);
    expect(parent).toEqual(before);
  });

  it('refuses deleting the parent while its included child remains', async () => {
    const { parent, call, writes, tables } = storedHarness();
    const res = await call({}, 'DELETE');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'sofa_combo_requires_complete_edit' });
    expect(writes).toEqual([]);
    expect(tables.mfg_sales_order_items).toContain(parent);
  });

  it('strips forged inclusion markers from a normal paid line', async () => {
    const { parent, call } = storedHarness(false);
    const res = await call({ variants: {
      ...parent.variants,
      sofaAccessoryGroupKey: 'forged',
      sofaComboIncluded: { buildKey: 'forged', pieceIds: ['piece'] },
    } });
    expect(res.status, await res.text()).toBe(200);
    expect(parent.variants.sofaAccessoryGroupKey).toBeUndefined();
    expect(parent.variants.sofaComboIncluded).toBeUndefined();
    expect(parent.unit_price_sen).toBe(112500);
  });
});
