import { describe, expect, test } from 'vitest';
import { scmSoCompanyId } from '../src/services/assr';

/* Owner 2026-10-05: a Service Case's company follows its SO. ASSR/2608-016 was
   raised against SO-012823 — the AutoCount book number of HC-SO-012823 — and
   the create path matched scm.mfg_sales_orders on doc_no only, so the
   creator's switcher company (2990) was stamped instead of the order's (HOUZS).
   scmSoCompanyId matches the ERP number OR linked_ac_docno. */

type Seen = { sql: string; binds: unknown[] };

function fakeEnv(answer: (sql: string, binds: unknown[]) => unknown) {
  const seen: Seen[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first() {
                seen.push({ sql, binds });
                return answer(sql, binds);
              },
            };
          },
        };
      },
    },
  } as any;
  return { env, seen };
}

describe('scmSoCompanyId — the case follows its order’s company', () => {
  test('an AutoCount book number resolves through linked_ac_docno', async () => {
    const { env, seen } = fakeEnv(() => ({ company_id: '1' }));
    expect(await scmSoCompanyId(env, 'SO-012823')).toBe(1);
    expect(seen[0]!.sql).toMatch(/LOWER\(o\.doc_no\) = LOWER\(\?\) OR LOWER\(o\.linked_ac_docno\) = LOWER\(\?\)/);
    expect(seen[0]!.sql).toMatch(/ORDER BY CASE WHEN LOWER\(o\.doc_no\) = LOWER\(\?\) THEN 0 ELSE 1 END/);
    expect(seen[0]!.binds).toEqual(['SO-012823', 'SO-012823', 'SO-012823']);
  });

  // SO-012823 itself was never imported (delivered before go-live), so the
  // order lookup misses and the NUMBER names the company.
  const companies = (sql: string, binds: unknown[]) =>
    /FROM companies/.test(sql) ? ({ HOUZS: { id: 1 }, '2990': { id: 2 } } as any)[binds[0] as string] ?? null : null;

  test('an order not in the ERP: SO-<digits> and HC-SO- are HOUZS, 2990-SO- is 2990', async () => {
    const { env, seen } = fakeEnv(companies);
    expect(await scmSoCompanyId(env, 'SO-012823')).toBe(1);
    expect(await scmSoCompanyId(env, 'hc-so-2609-110')).toBe(1);
    expect(await scmSoCompanyId(env, '2990-SO-2608-040')).toBe(2);
    expect(seen.filter((s) => /FROM companies/.test(s.sql)).map((s) => s.binds[0])).toEqual(['HOUZS', 'HOUZS', '2990']);
  });

  test('anything else (display stock, free text) is null, so the switcher company still decides', async () => {
    const { env } = fakeEnv(companies);
    for (const doc of ['DISPLAY ITEM', 'PG AKEMI', 'SO1338', 'S0-00176', 'NA']) {
      expect(await scmSoCompanyId(env, doc)).toBeNull();
    }
  });

  test('a failing DB is null, never a throw', async () => {
    const { env } = fakeEnv(() => {
      throw new Error('no such table: scm.mfg_sales_orders');
    });
    expect(await scmSoCompanyId(env, 'SO-012823')).toBeNull();
  });
});
