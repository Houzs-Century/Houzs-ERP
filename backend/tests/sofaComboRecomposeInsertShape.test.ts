import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { sofaComboRecomposeHandler } from '../src/scm/routes/sofa-combos';

type Row = Record<string, unknown>;

const NOT_NULL_COLUMNS = ['created_at', 'effective_from', 'prices_by_height'] as const;

class PostgrestLikeQuery {
  private operation: 'select' | 'update' | 'insert' = 'select';
  private predicates: Array<(row: Row) => boolean> = [];
  private patch: Row = {};
  private insertedRows: Row[] = [];

  constructor(private readonly rows: Row[]) {}

  select(): this { return this; }
  order(): this { return this; }
  range(): this { return this; }
  is(): this { return this; }
  eq(column: string, value: unknown): this {
    this.predicates.push((row) => String(row[column]) === String(value));
    return this;
  }
  in(column: string, values: unknown[]): this {
    const allowed = new Set(values.map(String));
    this.predicates.push((row) => allowed.has(String(row[column])));
    return this;
  }
  update(patch: Row): this { this.operation = 'update'; this.patch = patch; return this; }
  insert(payload: Row | Row[]): this {
    this.operation = 'insert';
    this.insertedRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  private insertLikePostgrest(): { data: Row[] | null; error: { message: string } | null } {
    const columns = [...new Set(this.insertedRows.flatMap((row) => Object.keys(row)))];
    const filled = this.insertedRows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
    );
    const broken = NOT_NULL_COLUMNS.find((column) => columns.includes(column) && filled.some((row) => row[column] === null));
    if (broken) return { data: null, error: { message: `null value in column "${broken}" violates not-null constraint` } };
    this.rows.push(...filled.map((row) => ({ ...row, id: `new-${this.rows.length}-${Math.random()}`, deleted_at: null })));
    return { data: filled, error: null };
  }

  private execute(): { data: Row[] | null; error: { message: string } | null } {
    if (this.operation === 'insert') return this.insertLikePostgrest();
    const hits = this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));
    if (this.operation === 'update') for (const row of hits) Object.assign(row, this.patch);
    return { data: hits, error: null };
  }

  then<T>(resolve: (value: { data: Row[] | null; error: { message: string } | null }) => T): Promise<T> {
    return Promise.resolve(this.execute()).then(resolve);
  }
}

const buildApp = (rows: Row[]): Hono => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: () => new PostgrestLikeQuery(rows) } as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    c.env = {} as never;
    await next();
  });
  app.post('/recompose', sofaComboRecomposeHandler as never);
  return app;
};

const supplierCombo = (): Row => ({
  id: 'combo-1', company_id: 1, base_model: '8038', modules: [['1A(P)(LHF)'], ['1A(P)(RHF)'], ['CSL']],
  tier: 'PRICE_1', customer_id: null, supplier_id: 'sup-1', prices_by_height: { 24: 900 },
  selling_prices_by_height: {}, pwp_prices_by_height: {}, default_free_gifts: [], label: '1A(P)+CSL+1A(P)',
  effective_from: '2026-11-01', created_at: '2026-11-01T00:00:00Z', created_by: 'u0', created_by_name: 'Sim',
  deleted_at: null, notes: null,
});

describe('recompose (Edit compartments) saves a module change', () => {
  test('moves the combo to the new modules instead of failing the insert', async () => {
    const rows = [supplierCombo()];

    const response = await buildApp(rows).request('/recompose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseModel: '8038',
        from: [['1A(P)(LHF)'], ['1A(P)(RHF)'], ['CSL']],
        to: [['1A(P)(LHF)'], ['1A(P)(RHF)'], ['Console']],
        supplierId: 'sup-1',
        label: '1A(P)+CSL+1A(P)',
        notes: null,
      }),
    });

    expect(response.status).toBe(200);
    const live = rows.filter((row) => row.deleted_at === null);
    expect(live).toHaveLength(2);
    expect(live.every((row) => JSON.stringify(row.modules).includes('Console'))).toBe(true);
    expect(live.every((row) => typeof row.created_at === 'string')).toBe(true);
  });
});
