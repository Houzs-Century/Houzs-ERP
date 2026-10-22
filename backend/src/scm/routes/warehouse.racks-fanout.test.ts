// POST /warehouse/racks with alsoSiblingCompanies: the rows it INSERTS.
//
// The label fan-out across warehouse RECORDS was always per company. The flag
// widens it to the other companies' records of the same building (same code),
// and the one thing that must not slip is the stamp: a row created under
// HOUZS's KL WAREHOUSE must carry HOUZS's company_id even though 2990's user
// asked for it — the per-company scoping of every rack read and write depends
// on that column telling the truth.
import { describe, expect, it } from 'vitest';
import { createWarehouseRacksHandler } from './warehouse';

type Row = Record<string, unknown>;

const WAREHOUSES: Row[] = [
  { id: 'hc-kl', code: 'KL WAREHOUSE', company_id: 1, is_active: true },
  { id: 'hc-pg', code: 'PG WAREHOUSE', company_id: 1, is_active: true },
  { id: '2990-kl', code: 'KL WAREHOUSE', company_id: 2, is_active: true },
  { id: '2990-pj', code: 'PJ SHOWROOM', company_id: 2, is_active: true },
];

/** A supabase-ish fake: filters applied through .eq / .in are honoured on
 *  `warehouses`; `warehouse_racks` starts with the rows given and records what
 *  the handler inserts. */
function fakeSupabase(existingRacks: Row[]) {
  const inserted: Row[] = [];
  const query = (rows: Row[]) => {
    const filters: Array<(r: Row) => boolean> = [];
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
      then: (resolve: (v: { data: Row[]; error: null }) => void) =>
        resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return b;
  };
  const sb = {
    from: (table: string) => {
      if (table === 'warehouses') return query(WAREHOUSES);
      if (table === 'warehouse_racks') {
        return {
          ...query(existingRacks),
          insert: (rows: Row[]) => {
            inserted.push(...rows);
            return { select: async () => ({ data: rows.map((r, i) => ({ id: `new-${i}`, ...r })), error: null }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { sb, inserted };
}

function ctx(body: Row, sb: unknown, active: number, allowed: number[]) {
  const vars: Record<string, unknown> = {
    supabase: sb, companyId: active, allowedCompanyIds: allowed,
    companies: [{ id: 1, code: 'HC' }, { id: 2, code: '2990' }],
  };
  let status = 200;
  let payload: unknown;
  return {
    c: {
      get: (k: string) => vars[k],
      req: { json: async () => body },
      json: (p: unknown, s?: number) => { payload = p; status = s ?? 200; return { payload, status }; },
    },
    result: () => ({ status, payload }),
  };
}

describe('POST /warehouse/racks — alsoSiblingCompanies', () => {
  it('creates the label under the other company\'s same-code warehouse, stamped with THAT company', async () => {
    const { sb, inserted } = fakeSupabase([]);
    const { c, result } = ctx({ warehouseId: '2990-kl', rack: 'Rack U1.1', alsoSiblingCompanies: true }, sb, 2, [1, 2]);
    await createWarehouseRacksHandler(c);
    expect(result().status).toBe(201);
    expect(inserted.map((r) => [r.warehouse_id, r.company_id, r.rack])).toEqual([
      ['2990-kl', 2, 'Rack U1.1'],
      ['hc-kl', 1, 'Rack U1.1'],
    ]);
  });

  it('seeds the grid into both records, skipping labels a record already has', async () => {
    const { sb, inserted } = fakeSupabase([{ warehouse_id: 'hc-kl', rack: 'Rack L1.1' }]);
    const { c } = ctx({ warehouseId: '2990-kl', count: 1, series: 'L', levels: 2, alsoSiblingCompanies: true }, sb, 2, [1, 2]);
    await createWarehouseRacksHandler(c);
    expect(inserted.map((r) => `${r.warehouse_id}:${r.company_id}:${r.rack}`)).toEqual([
      '2990-kl:2:Rack L1.1', '2990-kl:2:Rack L1.2', 'hc-kl:1:Rack L1.2',
    ]);
  });

  it('without the flag, nothing changes: own warehouse only, active company stamp', async () => {
    const { sb, inserted } = fakeSupabase([]);
    const { c } = ctx({ warehouseId: '2990-kl', rack: 'Rack U1.1' }, sb, 2, [1, 2]);
    await createWarehouseRacksHandler(c);
    expect(inserted).toEqual([expect.objectContaining({ warehouse_id: '2990-kl', company_id: 2 })]);
  });

  it('a company the caller may not see never receives a row', async () => {
    const { sb, inserted } = fakeSupabase([]);
    const { c } = ctx({ warehouseId: '2990-kl', rack: 'Rack U1.1', alsoSiblingCompanies: true }, sb, 2, [2]);
    await createWarehouseRacksHandler(c);
    expect(inserted.map((r) => r.warehouse_id)).toEqual(['2990-kl']);
  });
});
