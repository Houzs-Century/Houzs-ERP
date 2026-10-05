import { describe, expect, test } from 'vitest';
import { patchAssrCase } from '../src/services/assr';

/* Owner 2026-10-05: 「改SO号码也跟着走」 — correcting a case's SO number
   re-stamps its company from that order, exactly as create does
   (scmSoCompanyId). A number that names no order leaves the company alone.
   Drives the real patchAssrCase against a recording fake DB. */

type Call = { sql: string; binds: unknown[] };

function fakeEnv(prevDocNo: string) {
  const calls: Call[] = [];
  const stmt = (sql: string) => ({
    bind(...binds: unknown[]) {
      const call = { sql, binds };
      return {
        async first() {
          calls.push(call);
          if (/SELECT doc_no FROM assr_cases/.test(sql)) return { doc_no: prevDocNo };
          if (/FROM companies WHERE code/.test(sql)) return ({ HOUZS: { id: 1 }, '2990': { id: 2 } } as any)[binds[0] as string] ?? null;
          return null;
        },
        async all() {
          calls.push(call);
          return { results: [] };
        },
        async run() {
          calls.push(call);
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    async all() {
      calls.push({ sql, binds: [] });
      return { results: [] };
    },
  });
  const env = { DB: { prepare: stmt, batch: async (s: unknown[]) => s.map(() => ({ success: true })) } } as any;
  return { env, calls };
}

const caseUpdate = (calls: Call[]) => calls.find((c) => /^\s*UPDATE assr_cases SET/i.test(c.sql));

describe('editing the SO no. re-stamps the case company', () => {
  test('a HOUZS book number moves a 2990-stamped case to HOUZS', async () => {
    const { env, calls } = fakeEnv('DISPLAY');
    await patchAssrCase(env, 7, { doc_no: 'SO-012823' }, 1);
    const upd = caseUpdate(calls)!;
    expect(upd.sql).toMatch(/company_id = \?/);
    expect(upd.binds).toContain(1);
  });

  test('a 2990 number stamps 2990', async () => {
    const { env, calls } = fakeEnv('SO-012823');
    await patchAssrCase(env, 7, { doc_no: '2990-SO-2608-040' }, 1);
    const upd = caseUpdate(calls)!;
    expect(upd.sql).toMatch(/company_id = \?/);
    expect(upd.binds).toContain(2);
  });

  test('a non-order doc keeps the company', async () => {
    const { env, calls } = fakeEnv('SO-012823');
    await patchAssrCase(env, 7, { doc_no: 'PG DISPLAY' }, 1);
    expect(caseUpdate(calls)!.sql).not.toMatch(/company_id/);
  });

  test('an unchanged SO no. (or no SO no. at all) does not touch the company', async () => {
    const same = fakeEnv('SO-012823');
    await patchAssrCase(same.env, 7, { doc_no: 'SO-012823' }, 1);
    expect(caseUpdate(same.calls)!.sql).not.toMatch(/company_id/);
    const other = fakeEnv('SO-012823');
    await patchAssrCase(other.env, 7, { complaint_issue: 'Sagging' }, 1);
    expect(caseUpdate(other.calls)!.sql).not.toMatch(/company_id/);
  });
});
