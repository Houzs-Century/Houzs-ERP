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

const params = (over: Partial<SoListParams>): SoListParams => ({ status: null, q: null, sort: null, from: null, to: null, f: [], debtorNames: null, currencies: null, brandings: null, cols: null, ...over });

async function docNos(rows: Row[], p: SoListParams, companyId = 1, more: Record<string, Row[]> = {}): Promise<string[]> {
  const sb = fakeSb({ mfg_sales_orders_with_payment_totals: rows, mfg_sales_order_payments: [], ...more });
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
    expect(readSoListParams((k) => q[k], (k) => (k === 'f' ? ['a:is:1', 'b:is:2'] : undefined), false))
      .toEqual({ status: 'CONFIRMED', q: 'x', sort: 'doc_no:asc', from: null, to: null, f: ['a:is:1', 'b:is:2'], debtorNames: null, currencies: null, brandings: null, cols: null });
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

  /* Owner 2026-10-17: BRANDING = ZANOTTI filtered only the loaded page (9 of 50)
     while the footer kept "of 3,465". The funnel now narrows the READ, so the
     total and the pages are the filtered set's. */
  it('pushes the Branding funnel into the query so it matches across pages', async () => {
    const rows = [
      so({ doc_no: 'A', branding: 'ZANOTTI' }),
      so({ doc_no: 'B', branding: 'AKEMI' }),
      so({ doc_no: 'C', branding: 'ZANOTTI' }),
      so({ doc_no: 'D', branding: 'NONE' }),
      so({ doc_no: 'E', branding: null }),
      so({ doc_no: 'F', branding: 'ZANOTTI', company_id: 2 }),
    ];
    // A brand on headers: exact, placeholder-header orders NOT admitted, other company never.
    expect(await docNos(rows, params({ brandings: ['ZANOTTI'], sort: 'doc_no:asc' }))).toEqual(['A', 'C']);
    expect(await docNos(rows, params({ brandings: ['ZANOTTI', 'AKEMI'], sort: 'doc_no:asc' }))).toEqual(['A', 'B', 'C']);
    // A label that is only ever derived ("Accessory"): the blank/placeholder-header
    // orders are admitted (their cell is derived from lines; the grid trims the page).
    expect(await docNos(rows, params({ brandings: ['Accessory'], sort: 'doc_no:asc' }))).toEqual(['D', 'E']);
    expect(await docNos(rows, params({ brandings: ['ZANOTTI', 'Accessory'], sort: 'doc_no:asc' }))).toEqual(['A', 'C', 'D', 'E']);
  });

  it('keeps a brand with reserved characters intact in the or= expression', async () => {
    const rows = [so({ doc_no: 'A', branding: 'HAPPI, S (MATT)' }), so({ doc_no: 'B', branding: 'ZANOTTI' })];
    expect(await docNos(rows, params({ brandings: ['HAPPI, S (MATT)'] }))).toEqual(['A']);
  });

  it('parses the brandings funnel param as a JSON array', () => {
    const q: Record<string, string> = { brandings: JSON.stringify(['ZANOTTI', '2990s Sofa']) };
    expect(readSoListParams((k) => q[k], () => undefined, false).brandings).toEqual(['ZANOTTI', '2990s Sofa']);
  });

  /* Owner 2026-10-17: every column funnel runs over all orders, not the loaded
     page — lib/so-list-column-funnels.ts. */
  it('pushes plain header-column funnels into the query, blank cells included', async () => {
    const rows = [
      so({ doc_no: 'A', city: 'KL', status: 'CONFIRMED', so_date: '2026-09-01', local_total_sen: 1000 }),
      so({ doc_no: 'B', city: 'JB', status: 'DRAFT', so_date: '2026-09-02', local_total_sen: 2000 }),
      so({ doc_no: 'C', city: null, status: 'CONFIRMED', so_date: '2026-09-02', local_total_sen: 1000 }),
      so({ doc_no: 'D', city: '', status: 'CONFIRMED', so_date: '2026-09-03', local_total_sen: null }),
      so({ doc_no: 'E', city: 'KL', company_id: 2 }),
    ];
    const s = 'doc_no:asc';
    expect(await docNos(rows, params({ cols: { city: ['KL'] }, sort: s }))).toEqual(['A']);
    expect(await docNos(rows, params({ cols: { city: ['—'] }, sort: s }))).toEqual(['C', 'D']);
    expect(await docNos(rows, params({ cols: { so_date: ['2026-09-02'] }, sort: s }))).toEqual(['B', 'C']);
    expect(await docNos(rows, params({ cols: { amount: ['1000', '—'] }, sort: s }))).toEqual(['A', 'C', 'D']);
    // Two funnels AND together; status is matched exactly.
    expect(await docNos(rows, params({ cols: { status: ['CONFIRMED'], so_date: ['2026-09-02', '2026-09-03'] }, sort: s }))).toEqual(['C', 'D']);
    // A value no order can carry matches nothing rather than everything.
    expect(await docNos(rows, params({ cols: { amount: ['not-a-number'] }, sort: s }))).toEqual([]);
  });

  it('admits a blank currency under MYR, the value its cell shows', async () => {
    const rows = [so({ doc_no: 'A', currency: 'MYR' }), so({ doc_no: 'B', currency: null }), so({ doc_no: 'C', currency: 'USD' })];
    expect(await docNos(rows, params({ currencies: ['MYR'], sort: 'doc_no:asc' }))).toEqual(['A', 'B']);
    expect(await docNos(rows, params({ currencies: ['USD'], sort: 'doc_no:asc' }))).toEqual(['C']);
  });

  it('matches a money cell that shows 0 for an empty column', async () => {
    const rows = [so({ doc_no: 'A', paid_total_sen: 0 }), so({ doc_no: 'B', paid_total_sen: null }), so({ doc_no: 'C', paid_total_sen: 500 })];
    expect(await docNos(rows, params({ cols: { paid: ['0'] }, sort: 'doc_no:asc' }))).toEqual(['A', 'B']);
  });

  it('matches the derived cells as a superset: book doc no, reference, venue spelling, salesperson, location', async () => {
    const rows = [
      so({ doc_no: 'A', ref: 'R-1', customer_so_no: null, venue: 'sutera mall', agent: null, salesperson_id: 'aaaaaaaa-0000-0000-0000-000000000001', sales_location: 'Johor Bahru', so_line_warehouse_ids: ['wh-1'] }),
      so({ doc_no: 'B', ref: null, customer_so_no: 'R-1', venue: 'IOI', agent: 'NICO', sales_location: 'KL', so_line_warehouse_ids: [] }),
      so({ doc_no: 'C', ref: null, customer_so_no: null, venue: null, agent: 'OTHER', sales_location: 'BALAKONG', so_line_warehouse_ids: [] }),
    ];
    const more = {
      mfg_sales_orders: [{ doc_no: 'C', company_id: 1, linked_ac_docno: 'SO-AC-9' }],
      staff: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'ALICE TAN' }],
      warehouses: [{ id: 'wh-1', company_id: 1, code: 'BALAKONG', name: 'Balakong Warehouse' }, { id: 'wh-2', company_id: 2, code: 'BALAKONG', name: 'Other company' }],
    };
    const s = 'doc_no:asc';
    expect(await docNos(rows, params({ cols: { doc_no: ['SO-AC-9'] }, sort: s }), 1, more)).toEqual(['C']);
    expect(await docNos(rows, params({ cols: { reference: ['R-1'] }, sort: s }), 1, more)).toEqual(['A', 'B']);
    expect(await docNos(rows, params({ cols: { reference: ['—'] }, sort: s }), 1, more)).toEqual(['B', 'C']); // superset: B shows R-1, the grid trims it
    expect(await docNos(rows, params({ cols: { venue: ['SUTERA MALL'] }, sort: s }), 1, more)).toEqual(['A']);
    expect(await docNos(rows, params({ cols: { salesperson: ['ALICE TAN'] }, sort: s }), 1, more)).toEqual(['A']);
    expect(await docNos(rows, params({ cols: { salesperson: ['NICO'] }, sort: s }), 1, more)).toEqual(['B']);
    // The primary line's warehouse label, else the free-text location.
    expect(await docNos(rows, params({ cols: { sales_location: ['BALAKONG'] }, sort: s }), 1, more)).toEqual(['A', 'C']);
  });

  it('reads the cols param, dropping unknown keys, condition tokens and finance columns for a non-finance caller', () => {
    const raw = JSON.stringify({ city: ['KL', 'KL'], nonsense: ['x'], so_date: ['\u0001dateRange:2026-01-01..'], total_cost_sen: ['100'] });
    expect(readSoListParams((k) => (k === 'cols' ? raw : undefined), () => undefined, false).cols).toEqual({ city: ['KL'] });
    expect(readSoListParams((k) => (k === 'cols' ? raw : undefined), () => undefined, true).cols).toEqual({ city: ['KL'], total_cost_sen: ['100'] });
    expect(readSoListParams((k) => (k === 'cols' ? '[1]' : undefined), () => undefined, true).cols).toBeNull();
  });

  it('parses the debtorNames / currencies funnel params as JSON arrays (commas in names survive)', () => {
    const q: Record<string, string> = { debtorNames: JSON.stringify(['ALICE, INC', 'BOB']), currencies: JSON.stringify(['MYR']) };
    const p = readSoListParams((k) => q[k], () => undefined, false);
    expect(p.debtorNames).toEqual(['ALICE, INC', 'BOB']);
    expect(p.currencies).toEqual(['MYR']);
    expect(readSoListParams((k) => (k === 'debtorNames' ? 'not json' : undefined), () => undefined, false).debtorNames).toBeNull();
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
