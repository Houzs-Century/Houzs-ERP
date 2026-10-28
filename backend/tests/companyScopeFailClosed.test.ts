// Fail-CLOSED hardening of the UNRESOLVED-company READ path (owner-approved,
// 2026-07-20). Sibling of companyScopeHardening.test.ts (writes) — this file
// pins the READ side: when the companies master is momentarily unreadable, a
// per-company list must resolve to the caller's own company (single-grant) or
// return NOTHING (multi-grant, no pick), and must NEVER fall open to every
// company's rows now that a second company's data shares this database.
//
// Two layers are asserted, in BOTH directions (the failure mode of a scope
// change is not only "the leak stayed open" but also "we blanked a company's
// own data"):
//   1. companyContext middleware — the cold-start resolution + last-known-good.
//   2. scopeToCompany / activeCompanySql / scopeToAllowedCompanies — the helper
//      fail-closed net that the middleware leans on.
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  companyContext,
  __resetCompanyContextCacheForTest,
  type CompanyRow,
} from '../src/middleware/companyContext';
import {
  scopeToCompany,
  activeCompanySql,
  scopeToAllowedCompanies,
} from '../src/scm/lib/companyScope';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990
const COMPANIES: CompanyRow[] = [
  { id: CO_A, code: 'HOUZS', name: 'Houzs Century' },
  { id: CO_B, code: '2990', name: "2990's Home" },
];

// Numeric user ids — the real auth user id is a bigint, and companyContext
// resolves grants only for a finite positive `Number(user.id)`.
const U_HOUZS = 101; // granted HOUZS only
const U_2990 = 102; // granted 2990 only
const U_BOTH = 103; // granted both
const U_ADMIN = 104; // no grants (0-grant admin, or a single-company install)

type Row = Record<string, any>;

// Minimal awaitable PostgREST builder — scopeToCompany chains .eq / .in and the
// caller awaits the result. An empty `.in('company_id', [])` matches nothing,
// exactly as it does in prod.
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
// `'throw'` simulates user_companies being unreadable too.
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

// A bare app: inject the authenticated user, run companyContext, then expose the
// resolved context (/echo) and a per-company list read (/dos) so the SAME
// resolution can be asserted both as raw context and as an actual scoped read.
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
  // Each test starts from a genuinely cold isolate — no cache, no last-known-good.
  __resetCompanyContextCacheForTest();
});

// ── (a) single-grant user with no header resolves to THEIR company ───────────
describe('cold-start resolution — single grant resolves (never empty, never all)', () => {
  test('a HOUZS-only user with no switcher header resolves to HOUZS during a master blip', async () => {
    const env = fakeEnv({ companies: 'throw', grants: { [U_HOUZS]: [CO_A] } });
    const echo = await buildApp(U_HOUZS, DOS).request('/echo', {}, env as never);
    const body = await echo.json() as Row;
    expect(body.companyId).toBe(CO_A);
    expect(body.allowedCompanyIds).toEqual([CO_A]);

    // ...and the actual per-company read returns ONLY their rows — not empty.
    const dos = await buildApp(U_HOUZS, DOS).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-a']);
  });

  test('a 2990-only user with no header resolves to 2990 during a master blip', async () => {
    const env = fakeEnv({ companies: 'throw', grants: { [U_2990]: [CO_B] } });
    const dos = await buildApp(U_2990, DOS).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-b']);
  });
});

// ── (b) unresolved MULTI-company context returns EMPTY, never other rows ──────
describe('cold-start resolution — unresolved multi-company fails CLOSED', () => {
  test('two grants + no header: allow-list is set but there is NO active company', async () => {
    const env = fakeEnv({ companies: 'throw', grants: { [U_BOTH]: [CO_A, CO_B] } });
    const body = await (await buildApp(U_BOTH, DOS).request('/echo', {}, env as never)).json() as Row;
    expect(body.companyId).toBeNull();
    expect(body.allowedCompanyIds).toEqual([CO_A, CO_B]);
  });

  test('two grants + no header: the per-company read returns NOTHING (not the other company)', async () => {
    const env = fakeEnv({ companies: 'throw', grants: { [U_BOTH]: [CO_A, CO_B] } });
    const dos = await buildApp(U_BOTH, DOS).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual([]); // never ['do-a','do-b'] or ['do-b']
  });

  test('two grants + a VALID header pick still resolves to the picked company', async () => {
    const env = fakeEnv({ companies: 'throw', grants: { [U_BOTH]: [CO_A, CO_B] } });
    const dos = await buildApp(U_BOTH, DOS).request('/dos', { headers: { 'X-Company-Id': String(CO_B) } }, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-b']);
  });
});

// ── legacy preserved: genuine single-company / pre-migration stays fail-OPEN ──
describe('cold-start resolution — a genuinely single-company install is NOT blanked', () => {
  test('no readable grants + no master: legacy no-op (read is unscoped, not empty)', async () => {
    // A brand-new isolate, master unreadable, and the user has no grants (a
    // 0-grant admin OR a genuine single-company install). We cannot prove
    // multi-company from here, so the read degrades to no predicate — the same
    // behaviour as before this change, so single-company Houzs is never blanked.
    const env = fakeEnv({ companies: 'throw', grants: {} });
    const body = await (await buildApp(U_ADMIN, DOS).request('/echo', {}, env as never)).json() as Row;
    expect(body.companyId).toBeNull();
    expect(body.allowedCompanyIds).toBeNull(); // undefined -> helpers fail OPEN
    const dos = await buildApp(U_ADMIN, DOS).request('/dos', {}, env as never);
    expect((await dos.json() as Row).ids).toEqual(['do-a', 'do-b']);
  });

  test('grants unreadable too: still legacy no-op, never a leak-by-guess', async () => {
    const env = fakeEnv({ companies: 'throw', grants: 'throw' });
    const body = await (await buildApp(U_BOTH, DOS).request('/echo', {}, env as never)).json() as Row;
    expect(body.companyId).toBeNull();
    expect(body.allowedCompanyIds).toBeNull();
  });
});

// ── last-known-good: a master blip AFTER a good load never falls open ─────────
describe('last-known-good master survives a transient read failure', () => {
  // Uses a GRANTED user (HOUZS-only), not a 0-grant admin: since the §6.1
  // fail-CLOSED change (docs/TENANT-ISOLATION-ROOT-FIX.md), a resolved
  // zero-grant multi-company user is restricted to `[]`, not handed the
  // hostname default — so the last-known-good property (a master blip AFTER a
  // good load never falls OPEN to every company) is now demonstrated through a
  // user whose grant filter needs the master rows to resolve. The zero-grant
  // fail-closed case itself is covered in companyContextZeroGrantFailClosed.test.ts.
  test('a granted user still resolves to THEIR company (not all) during a post-load blip', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      // Request 1: master reads OK -> cache + last-known-good populated.
      const good = fakeEnv({ companies: COMPANIES, grants: { [U_HOUZS]: [CO_A] } });
      const r1 = await buildApp(U_HOUZS, DOS).request('/echo', { headers: { host: 'erp.houzscentury.com' } }, good as never);
      expect((await r1.json() as Row).companyId).toBe(CO_A);

      // Advance well past the healthy TTL so the next call re-queries the master.
      vi.setSystemTime(11 * 60 * 1000);
      // The master now THROWS, but last-known-good is served, so the grant still
      // maps to a real company and the user resolves to HOUZS — NOT the
      // unresolved all-companies fail-open, and NOT an empty list.
      const down = fakeEnv({ companies: 'throw', grants: { [U_HOUZS]: [CO_A] } });
      const r2 = await buildApp(U_HOUZS, DOS).request('/echo', { headers: { host: 'erp.houzscentury.com' } }, down as never);
      const body = await r2.json() as Row;
      expect(body.companyId).toBe(CO_A);
      expect(body.allowedCompanyIds).toEqual([CO_A]);
      const dos = await buildApp(U_HOUZS, DOS).request('/dos', { headers: { host: 'erp.houzscentury.com' } }, down as never);
      expect((await dos.json() as Row).ids).toEqual(['do-a']); // scoped to HOUZS, not both
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── the helper fail-closed net, unit-level (mirrors the three-state sentinel) ─
const ctx = (vals: Record<string, unknown>) => ({ get: (k: string) => vals[k] }) as never;

describe('scopeToCompany / activeCompanySql — resolved-but-no-active fails CLOSED', () => {
  test('active company set -> scopes to it', async () => {
    const { data } = (await scopeToCompany(new FakeQuery(DOS) as never, ctx({ companyId: CO_A }))) as { data: Row[] };
    expect(data.map((r) => r.id)).toEqual(['do-a']);
    expect(activeCompanySql(ctx({ companyId: CO_A }))).toBe(' AND company_id = 1');
  });

  test('no active company but allow-list RESOLVED (multi) -> matches NOTHING', async () => {
    const c = ctx({ companyId: undefined, allowedCompanyIds: [CO_A, CO_B] });
    const { data } = (await scopeToCompany(new FakeQuery(DOS) as never, c)) as { data: Row[] };
    expect(data).toEqual([]); // fail closed, never the other company's rows
    expect(activeCompanySql(c)).toBe(' AND 1=0');
  });

  test('restricted-to-nothing ([]) -> matches NOTHING (unchanged)', async () => {
    const c = ctx({ companyId: undefined, allowedCompanyIds: [] });
    const { data } = (await scopeToCompany(new FakeQuery(DOS) as never, c)) as { data: Row[] };
    expect(data).toEqual([]);
    expect(activeCompanySql(c)).toBe(' AND 1=0');
  });

  test('genuinely UNRESOLVED (allow-list undefined) -> no predicate (legacy fail-open)', async () => {
    const c = ctx({ companyId: undefined, allowedCompanyIds: undefined });
    const { data } = (await scopeToCompany(new FakeQuery(DOS) as never, c)) as { data: Row[] };
    expect(data.map((r) => r.id)).toEqual(['do-a', 'do-b']); // single-company preserved
    expect(activeCompanySql(c)).toBe('');
  });
});

describe('scopeToAllowedCompanies (cross-company views) is unchanged', () => {
  test('widens to the resolved allow-list; no-op only when truly unresolved', async () => {
    const widened = (await scopeToAllowedCompanies(new FakeQuery(DOS) as never, ctx({ allowedCompanyIds: [CO_B] }))) as { data: Row[] };
    expect(widened.data.map((r) => r.id)).toEqual(['do-b']);
    const open = (await scopeToAllowedCompanies(new FakeQuery(DOS) as never, ctx({ allowedCompanyIds: undefined }))) as { data: Row[] };
    expect(open.data.map((r) => r.id)).toEqual(['do-a', 'do-b']);
  });
});
