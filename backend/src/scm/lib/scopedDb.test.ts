import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from './fake-postgrest';
import {
  scmDb,
  companyScope,
  companyIdScope,
  allowedScope,
  CENTRALISED,
  type ScmClient,
} from './scopedDb';

type Vars = { companyId?: number; allowedCompanyIds?: number[] };

function mk(tables: Record<string, Row[]>, vars: Vars = {}) {
  const fake = fakeSb(tables);
  const ctx = {
    get: (k: string) => (k === 'supabase' ? (fake as unknown as ScmClient) : (vars as Record<string, unknown>)[k]),
  };
  return { db: scmDb(ctx), ctx, tables };
}

const twoCompanies = (): Record<string, Row[]> => ({
  stock_transfers: [
    { id: 'a', company_id: 1, status: 'POSTED' },
    { id: 'b', company_id: 2, status: 'POSTED' },
    { id: 'c', company_id: 2, status: 'CANCELLED' },
  ],
});

const idsOf = (r: { data: unknown }) => ((r.data ?? []) as Array<{ id: string }>).map((x) => x.id);

describe('THE THREE-STATE SENTINEL — allowedScope delegates, it does not re-derive', () => {
  test('UNRESOLVED (undefined) → NO predicate, so single-company Houzs still serves', async () => {
    const { db, ctx } = mk(twoCompanies(), { allowedCompanyIds: undefined });
    expect(idsOf(await db.from('stock_transfers', allowedScope(ctx)).select('*'))).toEqual(['a', 'b', 'c']);
  });

  test('RESTRICTED TO NOTHING ([]) → matches NOTHING, never fails open', async () => {
    const { db, ctx } = mk(twoCompanies(), { allowedCompanyIds: [] });
    expect(idsOf(await db.from('stock_transfers', allowedScope(ctx)).select('*'))).toEqual([]);
  });

  test('GRANTED SET (non-empty) → exactly that set, widened not isolated', async () => {
    const { db, ctx } = mk(twoCompanies(), { allowedCompanyIds: [2] });
    expect(idsOf(await db.from('stock_transfers', allowedScope(ctx)).select('*'))).toEqual(['b', 'c']);
  });
});

describe('THE THREE-STATE SENTINEL — companyScope degrades exactly as scopeToCompany does', () => {
  test('active company resolved → isolated to it', async () => {
    const { db, ctx } = mk(twoCompanies(), { companyId: 2, allowedCompanyIds: [1, 2] });
    expect(idsOf(await db.from('stock_transfers', companyScope(ctx)).select('*'))).toEqual(['b', 'c']);
  });

  test('no active company but the context RESOLVED → fails CLOSED (matches nothing)', async () => {
    const { db, ctx } = mk(twoCompanies(), { companyId: undefined, allowedCompanyIds: [] });
    expect(idsOf(await db.from('stock_transfers', companyScope(ctx)).select('*'))).toEqual([]);
  });

  test('genuinely UNRESOLVED (pre-migration / cold start) → no predicate, not a blank screen', async () => {
    const { db, ctx } = mk(twoCompanies(), {});
    expect(idsOf(await db.from('stock_transfers', companyScope(ctx)).select('*'))).toEqual(['a', 'b', 'c']);
  });
});

describe('the other two constructors', () => {
  test('companyIdScope — strict, no degrade branch to get wrong', async () => {
    const { db } = mk(twoCompanies());
    expect(idsOf(await db.from('stock_transfers', companyIdScope(1)).select('*'))).toEqual(['a']);
  });

  test('CENTRALISED — no predicate, and the reason is REQUIRED', async () => {
    const { db } = mk(twoCompanies());
    const res = await db.from('stock_transfers', CENTRALISED('every company shares this lookup')).select('*');
    expect(idsOf(res)).toEqual(['a', 'b', 'c']);

    expect(() => CENTRALISED('')).toThrow(/reason IS the mechanism/);
    expect(() => CENTRALISED('   ')).toThrow(/reason IS the mechanism/);
    // @ts-expect-error — a reason is not optional. TS2578 here if it becomes one.
    expect(() => CENTRALISED()).toThrow();
  });
});

describe('THE MECHANISM — omitting the scope does not compile', () => {
  test('from(table) with no scope is TS2554', () => {
    const { db } = mk(twoCompanies());
    // @ts-expect-error — Expected 2 arguments, but got 1. This IS the feature:
    const builder = db.from('stock_transfers');
    expect(builder).toBeDefined();
  });

  test('unscoped() hands back the raw client, and demands a reason for it', () => {
    const { db } = mk(twoCompanies());
    expect(() => db.unscoped('')).toThrow(/reason IS the mechanism/);
    expect(db.unscoped('mintMonthlyDocNo partitions by the company doc prefix')).toBeTruthy();
  });
});

describe('THE INSERT ARM STAMPS; EVERY OTHER ARM PREDICATES', () => {
  test('insert STAMPS the scope company onto the new row', async () => {
    const { db, tables } = mk({ stock_transfer_lines: [] });
    await db.from('stock_transfer_lines', companyIdScope(7)).insert({ product_code: 'X' });
    expect(tables.stock_transfer_lines).toHaveLength(1);
    expect(tables.stock_transfer_lines[0]!.company_id).toBe(7);
  });

  test('insert stamps EVERY row of an array, and an explicit company_id still wins', async () => {
    const { db, tables } = mk({ stock_transfer_lines: [] });
    await db
      .from('stock_transfer_lines', companyIdScope(7))
      .insert([{ product_code: 'A' }, { product_code: 'B', company_id: 9 }]);
    expect(tables.stock_transfer_lines.map((r) => r.company_id)).toEqual([7, 9]);
  });

  test('an UNRESOLVED context stamps NOTHING — the same degrade the read side has', async () => {
    const { db, ctx, tables } = mk({ stock_transfer_lines: [] });
    await db.from('stock_transfer_lines', companyScope(ctx)).insert({ product_code: 'X' });
    expect(tables.stock_transfer_lines[0]).not.toHaveProperty('company_id');
  });

  test('a CROSS-COMPANY scope stamps the ACTIVE company, because a SET is not a company', async () => {
    const { db, ctx, tables } = mk({ trips: [] }, { companyId: 2, allowedCompanyIds: [1, 2] });
    await db.from('trips', allowedScope(ctx)).insert({ trip_no: 'T-1' });
    expect(tables.trips[0]!.company_id).toBe(2);
  });

  test('CENTRALISED stamps nothing — a deliberately company-less row stays company-less', async () => {
    const { db, tables } = mk({ audit: [] });
    await db.from('audit', CENTRALISED('system ledger, shared by both books')).insert({ note: 'x' });
    expect(tables.audit[0]).not.toHaveProperty('company_id');
  });

  test('update PREDICATES and never stamps — the seven-money-writes shape, inverted', async () => {
    const { db, tables } = mk(twoCompanies());
    await db.from('stock_transfers', companyIdScope(2)).update({ status: 'CANCELLED' });
    const rows = tables.stock_transfers;
    expect(rows.find((r) => r.id === 'a')).toMatchObject({ company_id: 1, status: 'POSTED' });
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ company_id: 2, status: 'CANCELLED' });
  });

  test("update composes with the caller's own by-id predicate, and the company one still holds", async () => {
    const { db, tables } = mk(twoCompanies());
    await db.from('stock_transfers', companyIdScope(2)).update({ status: 'CANCELLED' }).eq('id', 'a');
    expect(tables.stock_transfers.find((r) => r.id === 'a')).toMatchObject({ status: 'POSTED' });
  });

  test("delete PREDICATES — another company's row survives its own id", async () => {
    const { db, tables } = mk(twoCompanies());
    await db.from('stock_transfers', companyIdScope(2)).delete().eq('id', 'a');
    expect(tables.stock_transfers.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    await db.from('stock_transfers', companyIdScope(2)).delete().eq('id', 'b');
    expect(tables.stock_transfers.map((r) => r.id)).toEqual(['a', 'c']);
  });

  test("select composes: the scope predicate AND the caller's filters both apply", async () => {
    const { db } = mk(twoCompanies());
    const res = await db.from('stock_transfers', companyIdScope(2)).select('*').eq('status', 'POSTED');
    expect(idsOf(res)).toEqual(['b']);
  });
});
