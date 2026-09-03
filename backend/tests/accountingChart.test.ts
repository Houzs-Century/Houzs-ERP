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
  chartRenameHandler, chartUpdateHandler, chartDeleteHandler, chartCreateHandler,
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
  delete() { this.op = 'delete'; return this; }
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
    if (this.op === 'delete') {
      for (const r of hit) {
        const at = this.rows.indexOf(r);
        if (at >= 0) this.rows.splice(at, 1);
      }
    }
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(
  tables: Record<string, Row[]>,
  opts?: { allowed?: number[]; rpcError?: string; rpcCalls?: Array<{ fn: string; args: Row }> },
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
      rpc(fn: string, args: Row) {
        opts?.rpcCalls?.push({ fn, args });
        return Promise.resolve(opts?.rpcError
          ? { data: null, error: { message: opts.rpcError } }
          : { data: { accounts: 2, journal_lines: 3 }, error: null });
      },
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
  app.put('/chart/rename', chartRenameHandler as never);
  app.put('/chart/update', chartUpdateHandler as never);
  app.post('/chart/account', chartCreateHandler as never);
  app.delete('/chart/account', chartDeleteHandler as never);
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

describe('POST /chart/account — one door, definition lands per tick', () => {
  test('creates in the chosen companies with the parent chain riding along', async () => {
    const tables = { accounts: [
      acct(1, '305-0000', { account_name: 'OTHER DEBTOR', special_type: 'SDC' }),
    ] };
    const app = harness(tables);
    const res = await app.request('/chart/account', {
      method: 'POST',
      body: JSON.stringify({ code: '305-0010', name: 'AHMAD BIN ALI', accountType: 'asset', parentCode: '305-0000', companyIds: [1, 2] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: '305-0010', companies: [1, 2] });
    for (const co of [1, 2]) {
      const child = tables.accounts.find((r) => r.company_id === co && r.account_code === '305-0010');
      expect(child, `child in company ${co}`).toMatchObject({ account_type: 'ASSET', parent_code: '305-0000', is_active: true });
      const parent = tables.accounts.find((r) => r.company_id === co && r.account_code === '305-0000');
      expect(parent, `parent in company ${co}`).toMatchObject({ special_type: 'SDC', is_active: true });
    }
  });

  test('an existing code is refused toward the tick column; bad shapes and foreign companies refuse too', async () => {
    const tables = { accounts: [acct(1, '905-0000')] };
    const app = harness(tables);
    const dup = await app.request('/chart/account', {
      method: 'POST', body: JSON.stringify({ code: '905-0000', name: 'X', accountType: 'EXPENSE' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(dup.status).toBe(409);
    expect((await dup.json() as { error: string }).error).toBe('code_exists');
    const bad = await app.request('/chart/account', {
      method: 'POST', body: JSON.stringify({ code: 'nope', name: 'X', accountType: 'EXPENSE' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    const foreign = await app.request('/chart/account', {
      method: 'POST', body: JSON.stringify({ code: '906-0000', name: 'X', accountType: 'EXPENSE', companyIds: [3] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(foreign.status).toBe(403);
    const orphan = await app.request('/chart/account', {
      method: 'POST', body: JSON.stringify({ code: '906-0000', name: 'X', accountType: 'EXPENSE', parentCode: '999-0000' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(orphan.status).toBe(400);
    expect((await orphan.json() as { error: string }).error).toBe('parent_unknown');
  });
});

describe('PUT /chart/rename — 改码全账跟 through one RPC', () => {
  test('a clean rename calls the database function with both codes and reports its counts', async () => {
    const rpcCalls: Array<{ fn: string; args: Row }> = [];
    const app = harness({ accounts: [] }, { rpcCalls });
    const res = await app.request('/chart/rename', {
      method: 'PUT', body: JSON.stringify({ oldCode: '310-0010', newCode: '311-0010' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, oldCode: '310-0010', newCode: '311-0010', moved: { accounts: 2 } });
    expect(rpcCalls).toEqual([{ fn: 'acc_rename_account', args: { p_old: '310-0010', p_new: '311-0010' } }]);
  });

  test("the function's own refusals come back as 400 with the database sentence", async () => {
    const app = harness({ accounts: [] }, { rpcError: 'account 311-0010 already exists — renaming onto a live code would merge two books; refused' });
    const res = await app.request('/chart/rename', {
      method: 'PUT', body: JSON.stringify({ oldCode: '310-0010', newCode: '311-0010' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('rename_refused');
  });

  test('a malformed new code never reaches the database', async () => {
    const rpcCalls: Array<{ fn: string; args: Row }> = [];
    const app = harness({ accounts: [] }, { rpcCalls });
    const res = await app.request('/chart/rename', {
      method: 'PUT', body: JSON.stringify({ oldCode: '310-0010', newCode: 'nope' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('PUT /chart/update — one definition, every company', () => {
  test('name and type change on the code in BOTH companies at once', async () => {
    const tables = { accounts: [
      acct(1, '905-0000', { account_name: 'Rent', account_type: 'EXPENSE' }),
      acct(2, '905-0000', { account_name: 'Rent', account_type: 'EXPENSE' }),
      acct(1, '910-0000', { account_name: 'Utilities' }),
    ] };
    const app = harness(tables);
    const res = await app.request('/chart/update', {
      method: 'PUT', body: JSON.stringify({ code: '905-0000', name: 'RENTAL', accountType: 'expense' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, companies: 2 });
    for (const co of [1, 2]) {
      expect(tables.accounts.find((r) => r.company_id === co && r.account_code === '905-0000'))
        .toMatchObject({ account_name: 'RENTAL', account_type: 'EXPENSE' });
    }
    expect(tables.accounts.find((r) => r.account_code === '910-0000')!.account_name).toBe('Utilities');
  });

  test('an unknown code is a 404, an empty patch a 400', async () => {
    const app = harness({ accounts: [acct(1, '905-0000')] });
    const miss = await app.request('/chart/update', {
      method: 'PUT', body: JSON.stringify({ code: '888-0000', name: 'X' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(miss.status).toBe(404);
    const empty = await app.request('/chart/update', {
      method: 'PUT', body: JSON.stringify({ code: '905-0000' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.status).toBe(400);
  });
});

describe('PUT /chart/update parentCode — 拖动改父户, the target carries the rule', () => {
  const put = (app: ReturnType<typeof harness>, body: Row) => app.request('/chart/update', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });

  test('re-parents in every company and instantiates the header where missing', async () => {
    const tables: Record<string, Row[]> = { accounts: [
      acct(1, '360-0000', { account_name: 'PREPAYMENT & ADVANCE' }),
      acct(1, '370-0000', { account_name: 'ACCRUAL - GIK' }),
      acct(2, '370-0000', { account_name: 'ACCRUAL - GIK' }),
    ] };
    const app = harness(tables);
    const res = await put(app, { code: '370-0000', parentCode: '360-0000' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    for (const co of [1, 2]) {
      expect(tables.accounts.find((r) => r.company_id === co && r.account_code === '370-0000'))
        .toMatchObject({ parent_code: '360-0000' });
    }
    /* Company 2 had no 360-0000 — the header was instantiated for it. */
    expect(tables.accounts.find((r) => r.company_id === 2 && r.account_code === '360-0000'))
      .toMatchObject({ is_active: true });
  });

  test('an empty parent moves the account back to the root', async () => {
    const tables = { accounts: [acct(1, '360-0010', { parent_code: '360-0000' }), acct(1, '360-0000')] };
    const app = harness(tables);
    const res = await put(app, { code: '360-0010', parentCode: null });
    expect(res.status).toBe(200);
    expect(tables.accounts.find((r) => r.account_code === '360-0010')!.parent_code).toBeNull();
  });

  test('cycles, cross-type parents and self-parenting refuse', async () => {
    const tables = { accounts: [
      acct(1, '360-0000'),
      acct(1, '360-0010', { parent_code: '360-0000' }),
      acct(1, '905-0000', { account_type: 'EXPENSE' }),
    ] };
    const app = harness(tables);
    expect((await put(app, { code: '360-0000', parentCode: '360-0010' })).status).toBe(400); // loop
    expect((await put(app, { code: '360-0000', parentCode: '905-0000' })).status).toBe(400); // type
    expect((await put(app, { code: '360-0000', parentCode: '360-0000' })).status).toBe(400); // self
  });

  test('a target with postings refuses (父户不记账); a target already a header passes as-is', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [
        acct(1, '360-0050'),
        acct(1, '370-0000'),
        acct(1, '380-0000'),
        acct(1, '380-0010', { parent_code: '380-0000' }),
      ],
      journal_entry_lines: [{ company_id: 1, account_code: '360-0050' }],
    };
    const app = harness(tables);
    const refused = await put(app, { code: '370-0000', parentCode: '360-0050' });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe('parent_has_postings');

    const header = await put(app, { code: '370-0000', parentCode: '380-0000' });
    expect(header.status).toBe(200);
  });
});

describe('DELETE /chart/account — only a never-used code dies', () => {
  test('one journal line anywhere blocks the delete and names the holdout', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [acct(1, '905-0000'), acct(2, '905-0000')],
      journal_entry_lines: [{ company_id: 2, account_code: '905-0000' }],
    };
    const app = harness(tables);
    const res = await app.request('/chart/account?code=905-0000', { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; used: string[] };
    expect(body.error).toBe('account_in_use');
    expect(body.used).toEqual(['GL journal lines']);
    expect(tables.accounts).toHaveLength(2); // nothing died
  });

  test('a child under it blocks too — the tree never loses a floor', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [acct(1, '310-0000'), acct(1, '310-0010', { parent_code: '310-0000' })],
    };
    const app = harness(tables);
    const res = await app.request('/chart/account?code=310-0000', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json() as { used: string[] }).used).toEqual(['sub-accounts under it']);
  });

  test('a clean code disappears from EVERY company; an unknown one is a 404', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [acct(1, '2990-4100'), acct(2, '2990-4100'), acct(1, '905-0000')],
    };
    const app = harness(tables);
    const res = await app.request('/chart/account?code=2990-4100', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, companies: 2 });
    expect(tables.accounts.map((r) => r.account_code)).toEqual(['905-0000']);
    const miss = await app.request('/chart/account?code=2990-4100', { method: 'DELETE' });
    expect(miss.status).toBe(404);
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

  test('a control account (SDC/SCC/SBS) refuses even as a leaf — 由模块自动过账; SBK books on', async () => {
    const tables = { accounts: [
      acct(1, '300-0000', { special_type: 'SDC' }),
      acct(1, '400-0000', { account_type: 'LIABILITY', special_type: 'SCC' }),
      acct(1, '330-0000', { special_type: 'SBS' }),
      acct(1, '310-0010', { acc_money: true, special_type: 'SBK' }),
    ] };
    for (const code of ['300-0000', '400-0000', '330-0000']) {
      const refusal = await requireLeafAccount(ctx(tables), 1, code);
      expect(refusal, `${code} should refuse`).not.toBeNull();
      expect((await refusal!.json() as { error: string }).error).toBe('control_account_locked');
    }
    expect(await requireLeafAccount(ctx(tables), 1, '310-0010')).toBeNull();
  });
});
