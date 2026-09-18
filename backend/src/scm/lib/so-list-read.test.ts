// lib/so-list-read — the Sales Order list's ONE predicate set.
//
// Two things are asserted:
//   1. Behaviour, over the fake PostgREST: the tab, the search (phone included),
//      the date window, the second-level `f` rows and the company all narrow the
//      read.
//   2. Wiring, in the routeSource idiom of tests/mineBoardViewAllTier.test.ts:
//      the list handler builds its PAGE and its MONEY STRIP through the same
//      `header` — the money strip used to carry its own copy of the search term
//      without the phone arm, so a phone search counted the right orders and
//      summed the wrong money (docs/bugs, the SO money strip ignored a phone
//      search).
import { describe, expect, it } from 'vitest';
import { soRouterSource } from '../../../tests/lib/so-router-source';
import { fakeSb } from './fake-postgrest';
import { orderSoList, prepareSoListRead, readSoListParams, type SoListParams } from './so-list-read';
const routeSource = soRouterSource();

type Row = Record<string, unknown>;

const so = (over: Row): Row => ({
  doc_no: 'HC-SO-000001', company_id: 1, status: 'CONFIRMED', on_hold: false, so_date: '2026-09-01',
  debtor_name: 'ALICE', debtor_code: '300-A001', agent: 'NICO', sales_location: 'KL', ref: null,
  customer_so_no: null, branding: 'ZANOTTI', phone: '012-345 6789', ...over,
});

const params = (over: Partial<SoListParams>): SoListParams => ({ status: null, q: null, sort: null, from: null, to: null, f: [], debtorNames: null, currencies: null, ...over });

async function docNos(rows: Row[], p: SoListParams, companyId = 1): Promise<string[]> {
  const sb = fakeSb({ mfg_sales_orders_with_payment_totals: rows, mfg_sales_order_payments: [] });
  const c = { get: (k: string) => (k === 'companyId' ? companyId : undefined) };
  const read = await prepareSoListRead(sb, c, p, null, null, new Date('2026-09-15T04:00:00Z'));
  if (!read.ok) throw new Error(JSON.stringify(read.body));
  const q = orderSoList(read.header(sb.from('mfg_sales_orders_with_payment_totals').select('doc_no')), p.sort);
  const { data } = (await q) as { data: Row[] };
  return data.map((r) => String(r.doc_no));
}

describe('the Sales Order list predicate set', () => {
  it('holds the tab, with SHIPPED folded into Delivered', async () => {
    const rows = [so({ doc_no: 'A', status: 'CONFIRMED' }), so({ doc_no: 'B', status: 'SHIPPED' }), so({ doc_no: 'C', status: 'DELIVERED' })];
    expect(await docNos(rows, params({ status: 'DELIVERED', sort: 'doc_no:asc' }))).toEqual(['B', 'C']);
    expect(await docNos(rows, params({ status: 'all', sort: 'doc_no:asc' }))).toEqual(['A', 'B', 'C']);
  });

  it('finds an order by the customer phone typed with punctuation', async () => {
    const rows = [so({ doc_no: 'A', phone: '60123456789' }), so({ doc_no: 'B', phone: '60190000000' })];
    expect(await docNos(rows, params({ q: '012-345 6789' }))).toEqual(['A']);
  });

  it('applies a second-level filter row and the company', async () => {
    const rows = [
      so({ doc_no: 'A', so_date: '2026-08-10' }),
      so({ doc_no: 'B', so_date: '2026-09-10' }),
      so({ doc_no: 'C', so_date: '2026-08-11', company_id: 2 }),
    ];
    expect(await docNos(rows, params({ f: ['orderDate:between:2026-08-01~2026-08-31'] }))).toEqual(['A']);
  });

  it('refuses an invalid filter row with 400 rather than ignoring it', async () => {
    const sb = fakeSb({ mfg_sales_order_payments: [] });
    const read = await prepareSoListRead(sb, { get: () => 1 }, params({ f: ['nonsense:is:x'] }), null, null, new Date());
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.status).toBe(400);
  });

  it('reads the query string the list sends, repeated f rows included', () => {
    const q: Record<string, string> = { status: 'CONFIRMED', q: 'x', sort: 'doc_no:asc' };
    expect(readSoListParams((k) => q[k], (k) => (k === 'f' ? ['a:is:1', 'b:is:2'] : undefined)))
      .toEqual({ status: 'CONFIRMED', q: 'x', sort: 'doc_no:asc', from: null, to: null, f: ['a:is:1', 'b:is:2'], debtorNames: null, currencies: null });
  });

  it('pushes the Customer (debtor) Name funnel into the query so it matches across pages', async () => {
    const rows = [
      so({ doc_no: 'A', debtor_name: 'ALICE' }),
      so({ doc_no: 'B', debtor_name: 'BOB' }),
      so({ doc_no: 'C', debtor_name: 'ALICE' }),
    ];
    // Only ALICE's orders, regardless of which page they sit on — the point of
    // the server-side push (multi-value, so a second customer could be added).
    expect(await docNos(rows, params({ debtorNames: ['ALICE'], sort: 'doc_no:asc' }))).toEqual(['A', 'C']);
    expect(await docNos(rows, params({ debtorNames: ['ALICE', 'BOB'], sort: 'doc_no:asc' }))).toEqual(['A', 'B', 'C']);
  });

  it('pushes the Currency funnel into the query', async () => {
    const rows = [
      so({ doc_no: 'A', currency: 'MYR' }),
      so({ doc_no: 'B', currency: 'USD' }),
    ];
    expect(await docNos(rows, params({ currencies: ['USD'], sort: 'doc_no:asc' }))).toEqual(['B']);
  });

  it('parses the debtorNames / currencies funnel params as JSON arrays (commas in names survive)', () => {
    const q: Record<string, string> = { debtorNames: JSON.stringify(['ALICE, INC', 'BOB']), currencies: JSON.stringify(['MYR']) };
    const p = readSoListParams((k) => q[k], () => undefined);
    expect(p.debtorNames).toEqual(['ALICE, INC', 'BOB']);
    expect(p.currencies).toEqual(['MYR']);
    expect(readSoListParams((k) => (k === 'debtorNames' ? 'not json' : undefined), () => undefined).debtorNames).toBeNull();
  });
});

describe('the list handler reads through it', () => {
  const listBlock = (): string => {
    const start = routeSource.indexOf("mfgSalesOrders.get('/', ");
    expect(start).toBeGreaterThan(-1);
    const rest = routeSource.slice(start + 1);
    const next = rest.search(/mfgSalesOrders\.(get|post|patch|put|delete)\(/);
    return routeSource.slice(start, next === -1 ? undefined : start + 1 + next);
  };

  it('prepares the one predicate set', () => {
    expect(listBlock()).toContain('prepareSoListRead(');
  });

  it('builds the money strip through the same header as the page', () => {
    const block = listBlock();
    const money = /const applyMoneyFilters = [^;]*;/.exec(block)?.[0] ?? '';
    expect(money).toContain('.header(');
    expect(block).not.toMatch(/moneyQ\.or\(`doc_no\.ilike/);
  });
});
