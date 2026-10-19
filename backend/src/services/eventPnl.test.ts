import { describe, expect, it } from 'vitest';
import { eventPnl, type CostRate, type PnlLine, type SoTotals } from './eventPnl';

/* The event page's TWO P&Ls (owner 2026-10-16 / 10-19 「这些都要修」): by the
 * Total Sales he keys, and by the Sales Orders opened at the fair. The real
 * case: 2214 ZANOTTI BIGHOME @ Sunway Pyramid on 2026-10-16 — Total Sales RM
 * 114,240; 8 orders opened, RM 46,352, costing RM 17,780 (38.4%). */

const ZANOTTI: CostRate = { transport_pct: 5, merchandise_pct: 2, commission_normal_pct: 13, commission_boost_pct: 15, boost_min_gp_pct: 45, boost_min_sales: null };
const SO_2214: SoTotals = { count: 8, salesRm: 46352, costRm: { mattSofa: 15000, bedframe: 0, accessories: 2780, others: 0 } };
const RENTAL: PnlLine = { kind: 'cost', category: 'rental', amount: 9800 };
const run = (o: Partial<Parameters<typeof eventPnl>[0]> = {}) =>
  eventPnl({ lines: [RENTAL], booksRows: new Set(), lumpSales: 114240, so: SO_2214, rate: ZANOTTI, ...o });

describe('BY TOTAL SALES — the fair as the owner keys it', () => {
  it('COGS is the orders\' cost ratio on Total Sales; the % rows are the rate card on Total Sales', () => {
    const { by_sales: c } = run();
    expect(c).toMatchObject({ sales: 114240, salesFrom: 'box' });
    /* 17,780 / 46,352 = 38.36% of 114,240 */
    expect(c.cogs.from).toBe('so_ratio');
    expect(c.cogs.total).toBeCloseTo(43821.25, 0);
    expect(c.transportFee).toEqual({ amount: 5712, from: 'rate', pct: 5 });
    expect(c.merchandise).toEqual({ amount: 2284.8, from: 'rate', pct: 2 });
    /* GP 61.6% ≥ 45: the boost tier */
    expect(c.commission).toMatchObject({ amount: 17136, from: 'rate', pct: 15, boost: true });
    expect(c.rental).toBe(9800);
    expect(c.totalCost).toBeCloseTo(c.cogs.total + 9800 + 5712 + 2284.8 + 17136, 2);
    expect(c.netProfit).toBeCloseTo(114240 - c.totalCost, 2);
  });

  it('the box empty: the orders\' total, at the orders\' own cost', () => {
    const { by_sales: c } = run({ lumpSales: null });
    expect(c).toMatchObject({ sales: 46352, salesFrom: 'so' });
    expect(c.cogs).toMatchObject({ total: 17780, from: 'so' });
  });

  it('sales lines (the Sales section) come before the box', () => {
    const { by_sales: c } = run({ lines: [RENTAL, { kind: 'income', category: 'sales', amount: 50000, source: 'sales_entry' }] });
    expect(c).toMatchObject({ sales: 50000, salesFrom: 'lines' });
  });

  it('a COGS somebody typed stands — the imported fair reports of older events', () => {
    const { by_sales: c } = run({ lines: [RENTAL, { kind: 'cost', category: 'cogs_matt_sofa', amount: 40000 }] });
    expect(c.cogs).toMatchObject({ mattSofa: 40000, total: 40000, from: 'typed' });
  });

  it('no orders and no typed COGS: nothing to go on, and no P&L by orders', () => {
    const p = run({ so: null });
    expect(p.by_sales.cogs).toMatchObject({ total: 0, from: 'none' });
    expect(p.by_so).toBeNull();
    expect(p.so_count).toBe(0);
  });
});

describe('BY SALES ORDERS — the fair as its orders say', () => {
  it('their total at their own cost; the % rows on their total; the boost judged on THEIR GP', () => {
    const { by_so: c } = run();
    expect(c).not.toBeNull();
    expect(c!).toMatchObject({ sales: 46352, salesFrom: 'so' });
    expect(c!.cogs).toEqual({ mattSofa: 15000, bedframe: 0, accessories: 2780, other: 0, total: 17780, from: 'so' });
    expect(c!.transportFee.amount).toBeCloseTo(2317.6, 2);
    /* GP 61.6% here too → boost */
    expect(c!.commission).toMatchObject({ pct: 15, boost: true });
    /* a typed COGS never enters the orders' P&L */
    const typed = run({ lines: [RENTAL, { kind: 'cost', category: 'cogs_matt_sofa', amount: 40000 }] }).by_so!;
    expect(typed.cogs.total).toBe(17780);
  });

  it('the two columns can land on different commission tiers', () => {
    /* Orders costing 60%: GP 40% < 45 → normal tier, while the box (no typed
       COGS, same ratio) is also 40% — make the box column pass with typed COGS. */
    const p = run({ so: { ...SO_2214, costRm: { mattSofa: 27811.2, bedframe: 0, accessories: 0, others: 0 } }, lines: [RENTAL, { kind: 'cost', category: 'cogs', amount: 30000 }] });
    expect(p.by_sales.commission).toMatchObject({ pct: 15, boost: true });
    expect(p.by_so!.commission).toMatchObject({ pct: 13, boost: false });
  });
});

describe('rows both P&Ls share, and who wins a % row', () => {
  it('Rental, Setup, Transport S&D and Others Costing are the same in both', () => {
    const lines: PnlLine[] = [RENTAL, { kind: 'cost', category: 'setup', amount: 4000 }, { kind: 'cost', category: 'transport_setup_dismantle', amount: 1200 },
      { kind: 'cost', category: 'banner', amount: 300 }, { kind: 'cost', category: 'others', amount: 500, source: 'books' }];
    const p = run({ lines });
    for (const c of [p.by_sales, p.by_so!]) expect([c.rental, c.setup, c.transportSetupDismantle, c.others]).toEqual([9800, 4000, 1200, 800]);
  });

  it('Finance\'s figure fills a % row in both P&Ls', () => {
    const p = run({ lines: [RENTAL, { kind: 'cost', category: 'commission', amount: 9000, source: 'books' }], booksRows: new Set(['commission']) });
    expect(p.by_sales.commission).toMatchObject({ amount: 9000, from: 'books', boost: false });
    expect(p.by_so!.commission).toMatchObject({ amount: 9000, from: 'books' });
  });

  it('a typed % line stands (older events); the old engine\'s stored auto lines are not counted again', () => {
    const p = run({ lines: [RENTAL, { kind: 'cost', category: 'commission', amount: 7000 }, { kind: 'cost', category: 'transport_fee', amount: 999, auto_source: 'auto:transport' }] });
    expect(p.by_sales.commission).toMatchObject({ amount: 7000, from: 'typed' });
    expect(p.by_sales.transportFee).toMatchObject({ amount: 5712, from: 'rate' });
  });

  it('no rate card for the brand: the % rows are empty, not guessed', () => {
    const c = run({ rate: null }).by_sales;
    expect([c.transportFee.from, c.commission.from, c.merchandise.from]).toEqual(['none', 'none', 'none']);
    expect(c.commission.amount).toBe(0);
  });
});
