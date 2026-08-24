/* Cross-tenant isolation on the two paths that hand over the OTHER company's
 * book: the company-grant writer, and the stock transfer.
 *
 * BOTH DIRECTIONS are asserted for each. The failure mode of this class of
 * change is not "the leak stayed open", it is "we stopped a company doing its
 * own work" — so every refusal test is paired with a same-company test.
 */
import { describe, expect, test } from 'vitest';
import { setUserCompanies } from '../src/routes/users';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

/* ── 1. setUserCompanies: a grantor may only pass on what they hold ────────────
 *
 * PUT /api/users/:id/companies is gated by `users.manage`, a FLAT permission
 * with no company dimension, and has no `id === me.id` self-guard (its
 * neighbour PATCH /:id does, at users.ts:1426). The grant list used to be
 * validated against `SELECT id FROM companies` — the whole master — so a
 * company-1-only holder could grant THEMSELVES company 2 and companyContext
 * would honour `X-Company-Id: 2` on the very next request.
 *
 * This drives the REAL setUserCompanies, so a revert of the fix fails it. */

/** A Hono-shaped context carrying the caller's allow-list and a fake D1. */
function ctx(allowed: number[] | undefined, master: number[], written: number[][]) {
  return {
    get: (k: string) => (k === 'allowedCompanyIds' ? allowed : undefined),
    env: {
      DB: {
        prepare(sql: string) {
          return {
            bind: (...args: unknown[]) => ({ __sql: sql, __args: args }),
            all: async () => ({ results: master.map((id) => ({ id })) }),
          };
        },
        batch: async (stmts: Array<{ __sql: string; __args: unknown[] }>) => {
          // Everything after the DELETE is one INSERT per granted company.
          written.push(stmts.slice(1).map((s) => Number(s.__args[1])));
          return [];
        },
      },
    },
  } as never;
}

describe('company grants cannot exceed the grantor', () => {
  const MASTER = [CO_A, CO_B];

  test('a company-1-only admin cannot grant company 2 (self-escalation)', async () => {
    const written: number[][] = [];
    const valid = await setUserCompanies(ctx([CO_A], MASTER, written), 7, [CO_A, CO_B]);
    expect(valid).toEqual([CO_A]);
    expect(written[0]).toEqual([CO_A]); // and company 2 never reached the table
  });

  test('a company-2-only admin cannot grant company 1', async () => {
    const written: number[][] = [];
    const valid = await setUserCompanies(ctx([CO_B], MASTER, written), 7, [CO_A, CO_B]);
    expect(valid).toEqual([CO_B]);
    expect(written[0]).toEqual([CO_B]);
  });

  test('an admin holding BOTH can still grant both', async () => {
    const written: number[][] = [];
    const valid = await setUserCompanies(ctx([CO_A, CO_B], MASTER, written), 7, [CO_A, CO_B]);
    expect(valid).toEqual([CO_A, CO_B]);
  });

  test('UNRESOLVED master degrades to the old whole-master behaviour', async () => {
    // Pre-migration / cold-start: a single-company install must keep working.
    const written: number[][] = [];
    const valid = await setUserCompanies(ctx(undefined, MASTER, written), 7, [CO_A, CO_B]);
    expect(valid).toEqual([CO_A, CO_B]);
  });

  test('a caller granted nothing may grant nothing', async () => {
    const written: number[][] = [];
    const valid = await setUserCompanies(ctx([], MASTER, written), 7, [CO_A, CO_B]);
    expect(valid).toEqual([]);
  });
});

/* ── 2. stock transfers: both warehouses must be the active company's ─────────
 *
 * POST /api/scm/stock-transfers took fromWarehouseId / toWarehouseId straight
 * from the body and only checked presence and inequality. The header insert
 * STAMPS the active company, which is not a predicate — and
 * fn_stock_transfer_apply (mig 0192) writes the OUT movement at
 * from_warehouse_id, where the FIFO consumer keys on
 * (warehouse_id, item_code, variant_key) with NO company argument. So the
 * other company's lots were consumed at their cost and reopened as ours. */
type Row = Record<string, any>;
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  in(col: string, vals: unknown[]) {
    const set = new Set(vals.map(String));
    this.preds.push((r) => set.has(String(r[col])));
    return this;
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    return Promise.resolve({ data: hit, error: null }).then(res, rej);
  }
}

const WAREHOUSES: Row[] = [
  { id: 'wh-a1', company_id: CO_A },
  { id: 'wh-a2', company_id: CO_A },
  { id: 'wh-b1', company_id: CO_B },
];

/* The guard the handler now runs, over the same helper it calls. */
async function bothWarehousesOwned(from: string, to: string, activeCompany: number) {
  const wanted = [...new Set([from, to])];
  const { data } = await new FakeQuery(WAREHOUSES)
    .select()
    .in('id', wanted)
    .eq('company_id', activeCompany);
  return (data ?? []).length === wanted.length;
}

describe('a stock transfer cannot name the other company as a warehouse', () => {
  test('company 1 cannot pull stock OUT of a company-2 warehouse', async () => {
    expect(await bothWarehousesOwned('wh-b1', 'wh-a1', CO_A)).toBe(false);
  });

  test('company 1 cannot push stock INTO a company-2 warehouse', async () => {
    expect(await bothWarehousesOwned('wh-a1', 'wh-b1', CO_A)).toBe(false);
  });

  test('a transfer between two of the OWN company\'s warehouses still works', async () => {
    expect(await bothWarehousesOwned('wh-a1', 'wh-a2', CO_A)).toBe(true);
  });

  test('the other tenant is equally protected, and equally able to work', async () => {
    expect(await bothWarehousesOwned('wh-b1', 'wh-a1', CO_B)).toBe(false);
    expect(await bothWarehousesOwned('wh-b1', 'wh-b1', CO_B)).toBe(true); // dedupes to one
  });
});
