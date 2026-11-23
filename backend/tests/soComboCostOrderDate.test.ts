// Owner 2026-11-19: an order's cost is the internal cost of its own date; a set
// price created after the order never re-costs it. recomputeTotals runs on every
// line edit and every approved amendment (a delivery-date-only one too:
// applySoAmendment -> rederiveDeliveryFee -> recomputeTotals), and it spread
// TODAY's set price, so 2990-SO-2609-033 (opened 2026-09-20) took a set price
// from 2026-10-19 when only its delivery date was amended. These pin the spread
// to the order's date. Figures are made up.
import { describe, expect, test } from 'vitest';
import { recomputeTotals } from '../src/scm/routes/mfg-sales-orders';
import { comboCostAsOf, combosStandingOn } from '../src/scm/lib/sofa-combo-cost-spread';

/* Chainable supabase stub, as in soDeliveryFeeLineIntegrity.test.ts: awaiting a
   builder (or .single()/.maybeSingle()) resolves through `resolve`. */
function makeSb(resolve: (table: string, select: string, single: boolean) => unknown) {
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const makeBuilder = (table: string): unknown => {
    let select = '';
    const builder: any = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const result = resolve(table, select, false);
          return (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(resolve(table, select, true));
        return (...args: unknown[]) => {
          if (prop === 'select') select = String(args[0] ?? '');
          if (prop === 'update') updates.push({ table, patch: (args[0] ?? {}) as Record<string, unknown> });
          return builder;
        };
      },
    });
    return builder;
  };
  return { sb: { from: (table: string) => makeBuilder(table), rpc: () => Promise.resolve({ data: null, error: null }) }, updates };
}

const ctx = { get: () => undefined } as any;

// A two-piece set: pieces at 500.00 and 700.00 on their own, 1,000.00 as a set
// from 2026-10-10.
const PIECES = [
  { id: 'a', item_code: 'M100-1A(LHF)', item_group: 'sofa', variants: { seatHeight: '28' }, qty: 1, total_sen: 90000, line_cost_sen: 50000 },
  { id: 'b', item_code: 'M100-2A(RHF)', item_group: 'sofa', variants: { seatHeight: '28' }, qty: 1, total_sen: 130000, line_cost_sen: 70000 },
];
const SET_PRICE = {
  id: 'set', base_model: 'M100', modules: [['1A(LHF)', '1A(RHF)'], ['2A(LHF)', '2A(RHF)']], tier: 'PRICE_2', customer_id: null,
  prices_by_height: { 28: 100000 }, label: null, effective_from: '2026-10-10', created_at: '2026-10-10T02:00:00Z', deleted_at: null,
};

function orderOn(soDate: string | null, dateReadFails = false, setRow: Record<string, unknown> = SET_PRICE, setCostDay: string | null = null) {
  return makeSb((table, select, single) => {
    if (table === 'mfg_sales_order_items') return { data: PIECES.map((p) => ({ ...p, set_cost_day: setCostDay })), error: null };
    if (table === 'sofa_combo_pricing') return { data: [setRow], error: null };
    if (table === 'mfg_sales_orders' && select.includes('so_date')) {
      return dateReadFails ? { data: null, error: { message: 'read failed' } } : { data: { so_date: soDate }, error: null };
    }
    return single ? { data: null, error: null } : { data: [], error: null };
  });
}

const lineCosts = (updates: Array<{ table: string; patch: Record<string, unknown> }>) =>
  updates.filter((u) => u.table === 'mfg_sales_order_items' && 'line_cost_sen' in u.patch).map((u) => u.patch.line_cost_sen);
const headerCost = (updates: Array<{ table: string; patch: Record<string, unknown> }>) =>
  updates.find((u) => u.table === 'mfg_sales_orders' && 'total_cost_sen' in u.patch)?.patch.total_cost_sen;

describe('recomputeTotals prices a sofa set as of the order date', () => {
  test('an order opened before the set price keeps its pieces at their own cost', async () => {
    const { sb, updates } = orderOn('2026-09-30');
    await recomputeTotals(sb, 'HC-SO-TEST-1', ctx);
    expect(lineCosts(updates)).toEqual([]);
    expect(headerCost(updates)).toBe(120000);
  });

  test('an order opened once the set price existed costs the set price, shared by own cost', async () => {
    const { sb, updates } = orderOn('2026-10-20');
    await recomputeTotals(sb, 'HC-SO-TEST-2', ctx);
    expect(lineCosts(updates)).toEqual([41666, 58334]);
    expect(headerCost(updates)).toBe(100000);
  });

  // Owner 2026-11-20: the set price that STOOD on the order date.
  test('a set price deleted after the order date still costs it', async () => {
    const { sb, updates } = orderOn('2026-10-20', false, { ...SET_PRICE, deleted_at: '2026-11-18T02:10:00Z' });
    await recomputeTotals(sb, 'HC-SO-TEST-4', ctx);
    expect(lineCosts(updates)).toEqual([41666, 58334]);
    expect(headerCost(updates)).toBe(100000);
  });

  test('a set price deleted before the order date does not', async () => {
    const { sb, updates } = orderOn('2026-10-20', false, { ...SET_PRICE, deleted_at: '2026-10-15T02:00:00Z' });
    await recomputeTotals(sb, 'HC-SO-TEST-5', ctx);
    expect(lineCosts(updates)).toEqual([]);
    expect(headerCost(updates)).toBe(120000);
  });

  test('a set price created after the order date never costs it, even with an earlier start date', async () => {
    const { sb, updates } = orderOn('2026-10-20', false, { ...SET_PRICE, effective_from: '2026-05-31', created_at: '2026-10-25T02:00:00Z' });
    await recomputeTotals(sb, 'HC-SO-TEST-6', ctx);
    expect(lineCosts(updates)).toEqual([]);
    expect(headerCost(updates)).toBe(120000);
  });

  // Owner 2026-11-23 (rule 2): a set re-costed on the day its pieces changed
  // keeps that cost; a later save must not put the order-date set price back.
  test('a set re-costed by a later product change is left as it is', async () => {
    const { sb, updates } = orderOn('2026-10-20', false, SET_PRICE, '2026-11-05');
    await recomputeTotals(sb, 'HC-SO-TEST-7', ctx);
    expect(lineCosts(updates)).toEqual([]);
    expect(headerCost(updates)).toBe(120000);
  });

  test('a failed order-date read writes nothing: today\'s set price would re-cost the order', async () => {
    const { sb, updates } = orderOn(null, true);
    await recomputeTotals(sb, 'HC-SO-TEST-3', ctx);
    expect(updates).toEqual([]);
  });
});

describe('comboCostAsOf', () => {
  test('is the order date', () => {
    expect(comboCostAsOf('2026-09-30')).toBe('2026-09-30');
    expect(comboCostAsOf('2026-09-30T00:00:00+00:00')).toBe('2026-09-30');
  });
  test('is null (today) only without a readable date', () => {
    expect(comboCostAsOf(null)).toBeNull();
    expect(comboCostAsOf('')).toBeNull();
  });
});

describe('combosStandingOn', () => {
  const row = (createdAt: string, deletedAt: string | null) => ({
    id: 'r', baseModel: 'M100', modules: [['1A(LHF)']], tier: null, customerId: null, pricesByHeight: { 28: 1 },
    label: null, effectiveFrom: '2026-01-01', createdAt, deletedAt,
  });
  test('created by the day, in Malaysia, and not deleted by then', () => {
    // 17:00 UTC on the 9th is 01:00 on the 10th in Malaysia.
    expect(combosStandingOn([row('2026-06-09T17:00:00Z', null)], '2026-06-09')).toHaveLength(0);
    expect(combosStandingOn([row('2026-06-09T17:00:00Z', null)], '2026-06-10')).toHaveLength(1);
    expect(combosStandingOn([row('2026-06-01T02:00:00Z', '2026-07-04T07:19:00Z')], '2026-07-03')).toHaveLength(1);
    expect(combosStandingOn([row('2026-06-01T02:00:00Z', '2026-07-04T07:19:00Z')], '2026-07-04')).toHaveLength(0);
  });
  test('a row it keeps reads as live to the matcher', () => {
    expect(combosStandingOn([row('2026-06-01T02:00:00Z', '2026-07-04T07:19:00Z')], '2026-06-20')[0]?.deletedAt).toBeNull();
  });
});
