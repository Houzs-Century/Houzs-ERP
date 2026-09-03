/* The Chart of Accounts maintenance surface (roadmap A) — the owner's
 * selective sharing (2026-09-02: 可能类似recon setup 我tick 后选择这个公司要
 * 不要用). What is pinned:
 *
 *   · GET /chart unions every granted company's rows into one row per code,
 *     definition led by the lowest company id, with a per-company active map;
 *   · PUT /tick on=true INSTANTIATES the row from the master definition —
 *     parent included, the tree stays whole — and on=false cascades DOWN
 *     (untick a header, its children go too);
 *   · a company outside the caller's grants is refused by name;
 *   · POST /import upserts the accountant's rows into the target company and
 *     copies the rows marked shared into every other granted company,
 *     parents riding along; a row whose parent is not in the file is refused;
 *   · requireLeafAccount refuses a header with active children — 父户不记账
 *     at typing time (the GL gate already refuses it at posting).
 *
 * Same bare-Hono + fake-PostgREST harness as tests/pvVendorMemory.test.ts.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  chartUnionHandler, chartTickHandler, chartImportHandler, requireLeafAccount,
} from '../src/scm/routes/accounting-chart';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private orderCol: string | null = null;
  private limitN: number | null = null;
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order(col: string) { this.orderCol = col; return this; }
  limit(n: number) { this.limitN = n; return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  upsert(p: Row | Row[], opts?: { onConflict?: string }) {
    const rows = Array.isArray(p) ? p : [p];
    const keys = (opts?.onConflict ?? 'id').split(',').map((s) => s.trim());
    for (const r of rows) {
      const hit = this.rows.find((ex) => keys.every((k) => String(ex[k]) === String(r[k])));
      if (hit) Object.assign(hit, r); else this.rows.push({ ...r });
    }
    this.preds.push(() => false);
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.orderCol) hit = [...hit].sort((a, b) => Number(a[this.orderCol!]) - Number(b[this.orderCol!]));
    if (this.limitN != null) hit = hit.slice(0, this.limitN);
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, opts?: { allowed?: number[] }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
    } as never);
    c.set('companyId' as never, 1 as never);
    c.set('allowedCompanyIds' as never, (opts?.allowed ?? [1, 2]) as never);
    c.set('companies' as never, [
      { id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }, { id: 3, code: 'GHOST' },
    ] as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.get('/chart', chartUnionHandler as never);
  app.put('/chart/tick', chartTickHandler as never);
  app.post('/chart/import', chartImportHandler as never);
  return app;
}

const acct = (company_id: number, code: string, over: Row = {}): Row => ({
  company_id, account_code: code, account_name: `Name ${code}`,
  account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, ...over,
});

describe('GET /chart — the union', () => {
  test('one row per code, lowest company leads the definition, per-company active map', async () => {
    const tables = { accounts: [
      acct(1, '310-0000', { account_name: 'CASH AT BANK' }),
      acct(1, '310-0010', { account_name: 'CASH AT BANK - MAYBANK', parent_code: '310-0000', acc_money: true }),
      acct(2, '310-0010', { account_name: 'stale 2990 name', parent_code: '310-0000', acc_money: true, is_active: false }),
      acct(2, '900-X001', { account_name: '2990-only expense', account_type: 'EXPENSE' }),
    ] };
    const app = harness(tables);
    const res = await app.request('/chart');
    expect(res.status).toBe(200);
    const body = await res.json() as { companies: Array<Row>; accounts: Array<Row> };
    /* GHOST (id 3) is not granted — it is not a column. */
    expect(body.companies.map((c) => c.id)).toEqual([1, 2]);
    const mbb = body.accounts.find((a) => a.code === '310-0010')!;
    expect(mbb.name).toBe('CASH AT BANK - MAYBANK'); // company 1 leads
    expect(mbb.perCompany).toEqual({ 1: { active: true }, 2: { active: false } });
    const only2990 = body.accounts.find((a) => a.code === '900-X001')!;
    expect(only2990.perCompany).toEqual({ 2: { active: true } });
  });
});

describe('PUT /chart/tick', () => {
  test('ticking on instantiates the row AND its parent from the master definition', async () => {
    const tables = { accounts: [
      acct(1, '310-0000', { account_name: 'CASH AT BANK' }),
      acct(1, '310-0010', { account_name: 'CASH AT BANK - MAYBANK', parent_code: '310-0000', acc_money: true }),
    ] };
    const app = harness(tables);
    const res = await app.request('/chart/tick', {
      method: 'PUT', body: JSON.stringify({ companyId: 2, code: '310-0010', active: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const co2 = tables.accounts.filter((r) => r.company_id === 2).map((r) => r.account_code).sort();
    expect(co2).toEqual(['310-0000', '310-0010']); // the parent rode along
    const child = tables.accounts.find((r) => r.company_id === 2 && r.account_code === '310-0010')!;
    expect(child).toMatchObject({ acc_money: true, is_active: true, parent_code: '310-0000' });
  });

  test('unticking a header cascades down — 子 follows 父, per the owner', async () => {
    const tables = { accounts: [
      acct(2, '310-0000', { account_name: 'CASH AT BANK' }),
      acct(2, '310-0010', { parent_code: '310-0000' }),
      acct(2, '310-0020', { parent_code: '310-0000' }),
      acct(2, '900-X001'),
    ] };
    const app = harness(tables);
    const res = await app.request('/chart/tick', {
      method: 'PUT', body: JSON.stringify({ companyId: 2, code: '310-0000', active: false }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const off = tables.accounts.filter((r) => !r.is_active).map((r) => r.account_code).sort();
    expect(off).toEqual(['310-0000', '310-0010', '310-0020']);
    expect(tables.accounts.find((r) => r.account_code === '900-X001')!.is_active).toBe(true);
  });

  test('a company outside the grants is refused by name', async () => {
    const app = harness({ accounts: [acct(1, '310-0000')] }, { allowed: [1] });
    const res = await app.request('/chart/tick', {
      method: 'PUT', body: JSON.stringify({ companyId: 2, code: '310-0000', active: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('company_not_yours');
  });
});

describe('POST /chart/import', () => {
  const rows = [
    { code: '201-0000', name: 'FURNITURE & FITTINGS', accountType: 'ASSET', parentCode: null, accMoney: false, shared: true },
    { code: '201-1000', name: 'F&F (OFFICE)', accountType: 'ASSET', parentCode: '201-0000', accMoney: false, shared: true },
    { code: '310-0010', name: 'CASH AT BANK - MAYBANK', accountType: 'ASSET', parentCode: null, accMoney: true, shared: false },
  ];

  test('upserts the target company and copies ONLY shared rows (parents riding along) to the others', async () => {
    const tables: Record<string, Row[]> = { accounts: [] };
    const app = harness(tables);
    const res = await app.request('/chart/import', {
      method: 'POST', body: JSON.stringify({ companyId: 1, rows }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 3, shared: 2, sharedTo: [2] });
    const co1 = tables.accounts.filter((r) => r.company_id === 1).map((r) => r.account_code).sort();
    expect(co1).toEqual(['201-0000', '201-1000', '310-0010']);
    const co2 = tables.accounts.filter((r) => r.company_id === 2).map((r) => r.account_code).sort();
    expect(co2).toEqual(['201-0000', '201-1000']); // the HOUZS bank stayed home
  });

  test('a row naming a parent not in the file is refused with its code', async () => {
    const app = harness({ accounts: [] });
    const res = await app.request('/chart/import', {
      method: 'POST',
      body: JSON.stringify({ companyId: 1, rows: [{ code: '201-1000', name: 'X', accountType: 'ASSET', parentCode: '201-0000' }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toMatch(/201-1000 names parent 201-0000/);
  });
});

describe('requireLeafAccount — 父户不记账 at typing time', () => {
  const ctx = (tables: Record<string, Row[]>) => ({
    get: (k: string) => (k === 'supabase' ? { from: (t: string) => new FakeQuery((tables[t] ||= []), t) } : undefined),
    json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }),
  });

  test('a header with an ACTIVE child refuses with the owner sentence; a leaf passes', async () => {
    const tables = { accounts: [
      acct(1, '310-0000'),
      acct(1, '310-0010', { parent_code: '310-0000' }),
      acct(1, '900-X001'),
    ] };
    const refusal = await requireLeafAccount(ctx(tables), 1, '310-0000');
    expect(refusal).not.toBeNull();
    expect((await refusal!.json() as { error: string }).error).toBe('not_a_leaf_account');
    expect(await requireLeafAccount(ctx(tables), 1, '900-X001')).toBeNull();
  });

  test('a header whose children are all INACTIVE books again — the tick page can retire a level', async () => {
    const tables = { accounts: [
      acct(1, '310-0000'),
      acct(1, '310-0010', { parent_code: '310-0000', is_active: false }),
    ] };
    expect(await requireLeafAccount(ctx(tables), 1, '310-0000')).toBeNull();
  });
});
