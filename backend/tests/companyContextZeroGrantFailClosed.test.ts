// Fail-CLOSED for the ZERO-GRANT multi-company user (owner decision,
// docs/TENANT-ISOLATION-ROOT-FIX.md §6.1, 2026-08-19). Sibling of
// companyScopeFailClosed.test.ts — that file pins the COLD-START (master
// unreadable) path; this file pins the NORMAL path where the companies master
// IS readable and multi-company is genuinely active.
//
// The change: when >1 company is active and a RESOLVED user has ZERO
// `user_companies` grant rows, `allowedCompanyIds` is now `[]`
// (restricted-to-nothing) instead of the old fail-OPEN "every company". Every
// other branch is preserved: a granted user still narrows to their grants, a
// single-company install never narrows, a grant-read blip still fails OPEN, and
// the cold-start branch is untouched.
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  companyContext,
  __resetCompanyContextCacheForTest,
  type CompanyRow,
} from '../src/middleware/companyContext';
import { scopeToCompany } from '../src/scm/lib/companyScope';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990
const COMPANIES: CompanyRow[] = [
  { id: CO_A, code: 'HOUZS', name: 'Houzs Century' },
  { id: CO_B, code: '2990', name: "2990's Home" },
];
const SINGLE: CompanyRow[] = [{ id: CO_A, code: 'HOUZS', name: 'Houzs Century' }];

const U_HOUZS = 101; // granted HOUZS only
const U_ZERO = 104; // no grants at all (the case that used to fail OPEN)

type Row = Record<string, any>;

// Minimal awaitable PostgREST builder — scopeToCompany chains .eq / .in and the
// caller awaits the result. An empty `.in('company_id', [])` matches nothing.
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return Promise.resolve({ data: hit, error: null }).then(res, rej);
  }
}

// Fake env.DB. `companies: 'throw'` simulates a master-read blip / cold-start;
// an array returns that master. `grants` maps user id -> granted company ids;
// `'throw'` simulates user_companies being unreadable (a DB blip on that read).
function fakeEnv(opts: { companies: CompanyRow[] | 'throw'; grants: Record<string, number[]> | 'throw' }) {
  return {
    DB: {
      prepare(sql: string) {
        const isCompanies = /from companies/i.test(sql);
        const isGrants = /from user_companies/i.test(sql);
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async all() {
            if (isCompanies) {
              if (opts.companies === 'throw') throw new Error('companies master unreadable');
              return { results: opts.companies };
            }
            if (isGrants) {
              if (opts.grants === 'throw') throw new Error('user_companies unreadable');
              const uid = String(bound[0]);
              return { results: (opts.grants[uid] ?? []).map((company_id) => ({ company_id })) };
            }
            return { results: [] };
          },
        };
        return stmt;
      },
    },
  };
}

function buildApp(userId: number | undefined, dosRows: Row[]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (userId !== undefined) c.set('user' as never, { id: userId } as never);
    await next();
  });
  app.use('*', companyContext as never);
  app.get('/echo', (c) =>
    c.json({
      companyId: (c.get('companyId') as number | undefined) ?? null,
      companyCode: (c.get('companyCode') as string | undefined) ?? null,
      allowedCompanyIds: (c.get('allowedCompanyIds') as number[] | undefined) ?? null,
    }),
  );
  app.get('/dos', async (c) => {
    const { data } = (await scopeToCompany(new FakeQuery(dosRows) as never, c as never)) as { data: Row[] };
    return c.json({ ids: data.map((r) => r.id) });
  });
  return app;
}

const DOS: Row[] = [
  { id: 'do-a', company_id: CO_A },
  { id: 'do-b', company_id: CO_B },
];

beforeEach(() => {
  __resetCompanyContextCacheForTest();
});

// ── (a) multi-company + ZERO grants -> [] (the fix; was ALL) ──────────────────
describe('multi-company active + zero grants fails CLOSED', () => {
  test('allowedCompanyIds is [] (never every company), no active company', async () => {
    const env = fakeEnv({ companies: COMPANIES, grants: {} }); // U_ZERO absent -> [] grants
    const body = await (
      await buildApp(U_ZERO, DOS).request('/echo', { headers: { host: 'erp.houzscentury.com' } }, env as never)
    ).json() as Row;
    expect(body.allowedCompanyIds).toEqual([]); // was [CO_A, CO_B] before the fix
    expect(body.companyId).toBeNull(); // pool is empty -> no active company
  });

  test('the per-company read returns NOTHING (not the host default company)', async () => {
    const env = fakeEnv({ companies: COMPANIES, grants: {} });
    const dos = await buildApp(U_ZERO, DOS).request('/dos', { headers: { host: 'erp.houzscentury.com' } }, env as never);
    expect((await dos.json() as Row).ids).toEqual([]); // never ['do-a'] or ['do-a','do-b']
  });

  test('even a forged X-Company-Id header cannot escape [] — still sees nothing', async () => {
    const env = fakeEnv({ companies: COMPANIES, grants: {} });
    const dos = await buildApp(U_ZERO, DOS).request(
      '/dos',
      { headers: { 'X-Company-Id': String(CO_B) } },
      env as never,
    );
    expect((await dos.json() as Row).ids).toEqual([]);
  });
});

// ── (b) multi-company + 1 grant -> just that company (UNCHANGED) ──────────────
describe('multi-company active + one grant is unchanged', () => {
  test('a HOUZS-only user resolves to HOUZS and reads only HOUZS rows', async () => {
    const env = fakeEnv({ companies: COMPANIES, grants: { [U_HOUZS]: [CO_A] } });
    const body = await (
      await buildApp(U_HOUZS, DOS).request('/echo', { headers: { host: 'erp.houzscentury.com' } }, env as never)
    ).json() as Row;
    expect(body.allowedCompanyIds).toEqual([CO_A]);
    expect(body.companyId).toBe(CO_A);
    const dos = await buildApp(U_HOUZS, DOS).request('/dos', { headers: { host: 'erp.houzscentury.com' } }, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-a']);
  });
});

// ── (b′) grant-read BLIP still fails OPEN (a transient error is not a lockout) ─
describe('multi-company active + grant read error stays fail-OPEN', () => {
  test('user_companies unreadable -> ALL companies, not [] (never lock out on a blip)', async () => {
    const env = fakeEnv({ companies: COMPANIES, grants: 'throw' });
    const body = await (
      await buildApp(U_ZERO, DOS).request('/echo', { headers: { host: 'erp.houzscentury.com' } }, env as never)
    ).json() as Row;
    expect(body.allowedCompanyIds).toEqual([CO_A, CO_B]); // fail OPEN on a read error
    expect(body.companyId).toBe(CO_A);
  });
});

// ── (c) SINGLE-company install is never narrowed ─────────────────────────────
describe('single-company install is unchanged (grant table never consulted)', () => {
  test('a zero-grant user still gets the one company (not [], not narrowed)', async () => {
    const env = fakeEnv({ companies: SINGLE, grants: {} });
    const body = await (
      await buildApp(U_ZERO, [{ id: 'do-a', company_id: CO_A }]).request('/echo', {}, env as never)
    ).json() as Row;
    expect(body.allowedCompanyIds).toEqual([CO_A]); // companies.length <= 1 -> no narrowing
    expect(body.companyId).toBe(CO_A);
    const dos = await buildApp(U_ZERO, [{ id: 'do-a', company_id: CO_A }]).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-a']);
  });
});

// ── (d) COLD-START branch is untouched by this change ────────────────────────
describe('cold-start branch (companies master unreadable) is unchanged', () => {
  test('no master + zero grants -> legacy no-op (unresolved, read unscoped)', async () => {
    const env = fakeEnv({ companies: 'throw', grants: {} });
    const body = await (await buildApp(U_ZERO, DOS).request('/echo', {}, env as never)).json() as Row;
    expect(body.companyId).toBeNull();
    expect(body.allowedCompanyIds).toBeNull(); // undefined -> helpers fail OPEN
    const dos = await buildApp(U_ZERO, DOS).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-a', 'do-b']); // single-company preserved
  });

  test('no master + single grant still resolves to that company', async () => {
    const env = fakeEnv({ companies: 'throw', grants: { [U_HOUZS]: [CO_A] } });
    const dos = await buildApp(U_HOUZS, DOS).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-a']);
  });
});
