import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  posSofaCombosCreateHandler,
  posSofaCombosEditHandler,
  posSofaCombosHistoryHandler,
  posSofaCombosRetireHandler,
} from '../src/scm/routes/pos-sofa-combos';
import { sofaCombosPosHandler } from '../src/scm/routes/pos-pools';
import {
  loadComboModulesById,
  loadLiveCombosByIds,
  loadSellingSofaCombos,
} from '../src/scm/lib/pos-sofa-combos';

/* 2990 POS selling combos live in scm.pos_sofa_combos (owner ruling
   2026-09-26): Houzs's sofa_combo_pricing is Houzs's cost, and the two must not
   touch. These pin (a) the '2990' company reads and writes ONLY the POS table,
   (b) company 1 keeps sofa_combo_pricing exactly as before, (c) writes go
   through the DB functions with the real caller, never a direct table write,
   (d) a failed POS read fails loudly instead of pricing without combos. */

type Row = Record<string, unknown>;
type DataSet = Record<string, Row[]>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[], private err: { message: string } | null) {}
  select() { return this; }
  order() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  is(col: string, val: unknown) { this.preds.push((r) => (val === null ? r[col] == null : String(r[col]) === String(val))); return this; }
  private result() { return this.err ? { data: null, error: this.err } : { data: this.rows.filter((r) => this.preds.every((p) => p(r))), error: null }; }
  maybeSingle() { const r = this.result(); return Promise.resolve(r.error ? r : { data: (r.data ?? [])[0] ?? null, error: null }); }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(this.result()).then(res, rej); }
}

type RpcCall = { name: string; args: Row };
function fakeSupabase(data: DataSet, opts: { failTables?: string[]; rpc?: (name: string, args: Row) => { data: unknown; error: unknown } } = {}) {
  const calls: RpcCall[] = [];
  const writes: string[] = [];
  const from = (table: string) => {
    const q = new FakeQuery(data[table] ?? [], opts.failTables?.includes(table) ? { message: `${table} down` } : null);
    for (const m of ['insert', 'update', 'delete', 'upsert'] as const) {
      (q as unknown as Row)[m] = () => { writes.push(`${table}.${m}`); return q; };
    }
    return q;
  };
  return {
    from,
    schema: () => ({ from }),
    rpc: async (name: string, args: Row) => { calls.push({ name, args }); return opts.rpc ? opts.rpc(name, args) : { data: null, error: null }; },
    calls,
    writes,
  };
}

const COMPANIES = [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }];
const EDITOR = { id: 42, email: 'loo@example.com', name: 'Loo', permissions: ['scm.config.write'] };

function ctxApp(
  sb: ReturnType<typeof fakeSupabase>,
  opts: { companyId: number; companyCode?: string | null; houzsUser?: Row | null },
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, opts.companyId as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    if (opts.companyCode !== null) c.set('companyCode' as never, (opts.companyCode ?? (opts.companyId === 2 ? '2990' : 'HOUZS')) as never);
    c.set('houzsUser' as never, (opts.houzsUser === undefined ? EDITOR : opts.houzsUser) as never);
    c.set('user' as never, { id: '00000000-0000-4000-8000-000000000001' } as never);
    await next();
  });
  app.get('/sofa-combos', sofaCombosPosHandler as never);
  app.get('/sofa-combos/history', posSofaCombosHistoryHandler as never);
  app.post('/sofa-combos', posSofaCombosCreateHandler as never);
  app.put('/sofa-combos/:id', posSofaCombosEditHandler as never);
  app.delete('/sofa-combos/:id', posSofaCombosRetireHandler as never);
  return app;
}

const posRow = (over: Row): Row => ({
  company_id: 2, base_model: 'Xammar', modules: [['1S']], tier: 'PRICE_1',
  selling_prices_by_height: { 24: 149000 }, pwp_prices_by_height: {}, default_free_gifts: [],
  label: null, effective_from: '2026-05-31', deleted_at: null, notes: null,
  created_at: '2026-05-31T00:00:00Z', updated_at: '2026-05-31T00:00:00Z', created_by: null, created_by_name: null,
  ...over,
});

function data(): DataSet {
  return {
    companies: COMPANIES,
    pos_sofa_combos: [
      posRow({ id: 'p1', notes: 'sofa fair', selling_prices_by_height: { 24: 149000, 28: 149000 }, pwp_prices_by_height: { 24: 99000 },
        default_free_gifts: [{ giftProductId: 'g1', qty: 1 }] }),
      posRow({ id: 'p1-old', effective_from: '2026-05-01', created_at: '2026-05-01T00:00:00Z', selling_prices_by_height: { 24: 1 } }),
      posRow({ id: 'p-future', modules: [['2S']], effective_from: '2999-01-01' }),
      posRow({ id: 'p-retired', modules: [['3S']], deleted_at: '2026-06-01T00:00:00Z' }),
      posRow({ id: 'p-co1', company_id: 1, base_model: 'HB' }),
    ],
    sofa_combo_pricing: [
      // Houzs cost rows for company 2 — must never reach a 2990 selling read.
      { id: 'h-cost', company_id: 2, base_model: 'Lotti', modules: [['1S', '2S', '3S']], tier: 'PRICE_1', customer_id: null, supplier_id: null,
        prices_by_height: { 24: 360000 }, selling_prices_by_height: { 24: 360000 }, pwp_prices_by_height: null, label: null,
        effective_from: '2026-09-26', created_at: '2026-09-26T07:33:00Z', deleted_at: null, default_free_gifts: null },
      // company 1 master combo — company 1 keeps reading this table.
      { id: 'h1', company_id: 1, base_model: 'HB', modules: [['A']], tier: 'PRICE_1', customer_id: null, supplier_id: null,
        prices_by_height: { S: 500, M: 700 }, selling_prices_by_height: { S: 900, M: null }, pwp_prices_by_height: null, label: 'H',
        effective_from: '2020-01-01', created_at: '2020-01-01', updated_at: '2020-01-01', deleted_at: null, default_free_gifts: null },
      // the copy of p1 left behind in Houzs's table by the split
      { id: 'p1', company_id: 2, base_model: 'Xammar', modules: [['OLD']], tier: 'PRICE_1', customer_id: null, supplier_id: null,
        prices_by_height: {}, selling_prices_by_height: { 24: 1 }, pwp_prices_by_height: null, label: null,
        effective_from: '2026-05-31', created_at: '2026-05-31', deleted_at: null, default_free_gifts: null },
    ],
  };
}

async function json(res: Response): Promise<Row> {
  return (await res.json()) as Row;
}

describe('GET /pos-pools/sofa-combos — 2990 reads its POS table, company 1 unchanged', () => {
  test('2990: active row per scope from pos_sofa_combos only; retired / future / older / Houzs rows excluded', async () => {
    const res = await ctxApp(fakeSupabase(data()), { companyId: 2 }).request('/sofa-combos?customerId=__all__');
    const rules = (await json(res)).rules as Row[];
    expect(rules.map((r) => r.id)).toEqual(['p1']);
    expect(rules[0]).toMatchObject({
      sellingPricesByHeight: { 24: 149000, 28: 149000 },
      pwpPricesByHeight: { 24: 99000 },
      pricesByHeight: {},
      supplierId: null,
      notes: 'sofa fair',
      defaultFreeGifts: [{ giftProductId: 'g1', qty: 1 }],
    });
  });

  test('2990 without companyCode in context (headless) resolves the code from companies', async () => {
    const res = await ctxApp(fakeSupabase(data()), { companyId: 2, companyCode: null }).request('/sofa-combos');
    expect(((await json(res)).rules as Row[]).map((r) => r.id)).toEqual(['p1']);
  });

  test('company 1: still sofa_combo_pricing, cost stripped, charged = selling ?? cost', async () => {
    const res = await ctxApp(fakeSupabase(data()), { companyId: 1 }).request('/sofa-combos?customerId=__all__');
    const rules = (await json(res)).rules as Row[];
    expect(rules.map((r) => r.id)).toEqual(['h1']);
    expect(rules[0]!.sellingPricesByHeight).toEqual({ S: 900, M: 700 });
    expect(rules[0]!.pricesByHeight).toEqual({});
  });
});

describe('POS combo writes go through the DB functions, as the real caller', () => {
  test('create: company 2 + real actor passed to pos_sofa_combo_insert; no direct table write', async () => {
    const sb = fakeSupabase(data(), {
      rpc: (_n, a) => ({ data: { id: 'new', ...(a.p_row as Row), company_id: a.p_company_id, deleted_at: null, created_by_name: 'Loo' }, error: null }),
    });
    const res = await ctxApp(sb, { companyId: 2 }).request('/sofa-combos', {
      method: 'POST',
      body: JSON.stringify({ baseModel: 'Xammar', modules: [['1A(RHF)', '1A(LHF)'], ['2A(LHF)', '2A(RHF)']], tier: 'PRICE_1',
        sellingPricesByHeight: { 24: 249000, 28: null }, effectiveFrom: '2026-09-27', notes: 'n' }),
    });
    expect(res.status).toBe(201);
    expect(sb.calls).toHaveLength(1);
    const call = sb.calls[0]!;
    expect(call.name).toBe('pos_sofa_combo_insert');
    expect(call.args.p_company_id).toBe(2);
    expect(call.args.p_actor).toEqual({ user_id: 42, name: 'Loo', email: 'loo@example.com' });
    expect(call.args.p_row).toMatchObject({
      base_model: 'Xammar',
      modules: [['1A(LHF)', '1A(RHF)'], ['2A(LHF)', '2A(RHF)']],
      tier: 'PRICE_1',
      selling_prices_by_height: { 24: 249000, 28: null },
      pwp_prices_by_height: {},
      effective_from: '2026-09-27',
    });
    expect(sb.writes).toEqual([]);
    expect((await json(res)).createdByName).toBe('Loo');
  });

  test('create refuses a combo with no selling price at any height', async () => {
    const sb = fakeSupabase(data());
    const res = await ctxApp(sb, { companyId: 2 }).request('/sofa-combos', {
      method: 'POST',
      body: JSON.stringify({ baseModel: 'Xammar', modules: [['1S']], sellingPricesByHeight: { 24: null }, effectiveFrom: '2026-09-27' }),
    });
    expect(res.status).toBe(400);
    expect(sb.calls).toEqual([]);
  });

  test('create without a selling map is refused (no cost fallback on the POS table)', async () => {
    const sb = fakeSupabase(data());
    const res = await ctxApp(sb, { companyId: 2 }).request('/sofa-combos', {
      method: 'POST',
      body: JSON.stringify({ baseModel: 'Xammar', modules: [['1S']], pricesByHeight: { 24: 100 }, effectiveFrom: '2026-09-27' }),
    });
    expect(res.status).toBe(400);
    expect(sb.calls).toEqual([]);
  });

  test('a caller without scm.config.write cannot write', async () => {
    const sb = fakeSupabase(data());
    const res = await ctxApp(sb, { companyId: 2, houzsUser: { id: 7, permissions: [] } }).request('/sofa-combos', {
      method: 'POST',
      body: JSON.stringify({ baseModel: 'Xammar', modules: [['1S']], sellingPricesByHeight: { 24: 1 }, effectiveFrom: '2026-09-27' }),
    });
    expect(res.status).toBe(403);
    expect(sb.calls).toEqual([]);
  });

  test('company 1 has no POS combo table to write', async () => {
    const sb = fakeSupabase(data());
    const res = await ctxApp(sb, { companyId: 1 }).request('/sofa-combos', {
      method: 'POST',
      body: JSON.stringify({ baseModel: 'HB', modules: [['A']], sellingPricesByHeight: { S: 1 }, effectiveFrom: '2026-09-27' }),
    });
    expect(res.status).toBe(404);
    expect(sb.calls).toEqual([]);
  });

  test('the DB guard refusing (42501) surfaces as 403 with its message', async () => {
    const sb = fakeSupabase(data(), { rpc: () => ({ data: null, error: { code: '42501', message: 'pos_sofa_combos: written only by the 2990 POS' } }) });
    const res = await ctxApp(sb, { companyId: 2 }).request('/sofa-combos', {
      method: 'POST',
      body: JSON.stringify({ baseModel: 'Xammar', modules: [['1S']], sellingPricesByHeight: { 24: 1 }, effectiveFrom: '2026-09-27' }),
    });
    expect(res.status).toBe(403);
    expect(((await json(res)).reason as string)).toContain('2990 POS');
  });

  test('edit appends a version of the SAME scope and carries PWP + gifts forward', async () => {
    const sb = fakeSupabase(data(), {
      rpc: (_n, a) => ({ data: { id: 'v2', ...(a.p_row as Row), company_id: 2, deleted_at: null }, error: null }),
    });
    const res = await ctxApp(sb, { companyId: 2 }).request('/sofa-combos/p1', {
      method: 'PUT',
      body: JSON.stringify({ sellingPricesByHeight: { 24: 159000 }, effectiveFrom: '2026-10-01', label: null, notes: null }),
    });
    expect(res.status).toBe(201);
    expect(sb.calls[0]!.args.p_row).toMatchObject({
      base_model: 'Xammar', modules: [['1S']], tier: 'PRICE_1',
      selling_prices_by_height: { 24: 159000 },
      pwp_prices_by_height: { 24: 99000 },
      default_free_gifts: [{ giftProductId: 'g1', qty: 1 }],
      effective_from: '2026-10-01',
    });
  });

  test('edit cannot reach another company\'s combo', async () => {
    const sb = fakeSupabase(data());
    const res = await ctxApp(sb, { companyId: 2 }).request('/sofa-combos/p-co1', {
      method: 'PUT',
      body: JSON.stringify({ sellingPricesByHeight: { 24: 1 }, effectiveFrom: '2026-10-01' }),
    });
    expect(res.status).toBe(404);
    expect(sb.calls).toEqual([]);
  });

  test('retire calls pos_sofa_combo_retire for the active company; nothing retired = 404', async () => {
    const hit = fakeSupabase(data(), { rpc: () => ({ data: true, error: null }) });
    const ok = await ctxApp(hit, { companyId: 2 }).request('/sofa-combos/p1', { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(hit.calls[0]).toMatchObject({ name: 'pos_sofa_combo_retire', args: { p_company_id: 2, p_id: 'p1' } });

    const miss = fakeSupabase(data(), { rpc: () => ({ data: false, error: null }) });
    expect((await ctxApp(miss, { companyId: 2 }).request('/sofa-combos/nope', { method: 'DELETE' })).status).toBe(404);
  });

  test('history returns every version of one scope, retired included, from the POS table only', async () => {
    const sb = fakeSupabase(data());
    const res = await ctxApp(sb, { companyId: 2 }).request(`/sofa-combos/history?baseModel=Xammar&tier=PRICE_1&modules=${encodeURIComponent('[["1S"]]')}`);
    expect(((await json(res)).rules as Row[]).map((r) => r.id)).toEqual(['p1', 'p1-old']);
  });
});

describe('selling loaders', () => {
  const ctx = (companyId: number, companyCode: string | undefined) => ({
    get: (k: string) => ({ companyId, companyCode, allowedCompanyIds: [1, 2] } as Row)[k],
  });

  test('2990 prices from pos_sofa_combos — Houzs cost rows for company 2 never appear', async () => {
    const rows = await loadSellingSofaCombos(fakeSupabase(data()), ctx(2, '2990'));
    expect(rows.map((r) => r.id).sort()).toEqual(['p-future', 'p1', 'p1-old']);
    expect(rows.find((r) => r.id === 'p1')!.pricesByHeight).toEqual({ 24: 149000, 28: 149000 });
  });

  test('company 1 keeps sofa_combo_pricing master rows, charged = selling over cost', async () => {
    const rows = await loadSellingSofaCombos(fakeSupabase(data()), ctx(1, 'HOUZS'));
    expect(rows.map((r) => r.id)).toEqual(['h1']);
    expect(rows[0]!.pricesByHeight).toEqual({ S: 900, M: 700 });
  });

  test('a failed POS read throws instead of pricing a-la-carte', async () => {
    await expect(loadSellingSofaCombos(fakeSupabase(data(), { failTables: ['pos_sofa_combos'] }), ctx(2, '2990')))
      .rejects.toThrow(/pos_sofa_combos read failed/);
  });

  test('combo ids resolve across both tables; the POS row wins over its left-behind copy', async () => {
    const byId = await loadComboModulesById(fakeSupabase(data()), ctx(2, '2990'));
    expect(byId.get('p1')).toEqual([['1S']]);
    expect(byId.get('h-cost')).toEqual([['1S', '2S', '3S']]);

    const live = await loadLiveCombosByIds(fakeSupabase(data()), ['p1', 'p-retired', 'h1']);
    expect([...live.keys()].sort()).toEqual(['h1', 'p1']);
    expect(live.get('p1')!.modules).toEqual([['1S']]);
  });
});
