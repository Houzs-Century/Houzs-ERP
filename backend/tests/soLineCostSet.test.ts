// set-so-line-cost.mjs: named lines of one order on an owner-decided cost, the
// header moving with them. Amounts are made up.
import { describe, expect, test } from 'vitest';
import { costColumnOf, parseLineCosts, planLineCosts } from '../scripts/lib/so-line-cost-set.mjs';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const D = '00000000-0000-4000-8000-00000000000d';
const order = (over = {}) => ({
  doc_no: 'X', status: 'IN_PRODUCTION', total_cost_sen: 150000, total_revenue_sen: 300000, total_margin_sen: 150000,
  mattress_sofa_cost_sen: 150000, bedframe_cost_sen: 0, accessories_cost_sen: 0, service_cost_sen: 0, others_cost_sen: 0, ...over,
});
const lines = [
  { id: A, item_code: 'M100-1A(LHF)', item_group: 'sofa', qty: 1, total_sen: 100000, line_cost_sen: 60000, cancelled: false },
  { id: B, item_code: 'M100-2A(RHF)', item_group: 'sofa', qty: 1, total_sen: 175000, line_cost_sen: 90000, cancelled: false },
  { id: D, item_code: 'SVC-DELIVERY', item_group: 'service', qty: 1, total_sen: 25000, line_cost_sen: 0, cancelled: false },
];

describe('planLineCosts', () => {
  test('named lines take their cost; header cost, sofa column, margin and basis move with them', () => {
    const r = planLineCosts(order(), lines, new Map([[A, 58000], [B, 89000]]));
    expect(r.status).toBe('set');
    if (r.status !== 'set') return;
    expect(r.changes.map((c) => [c.id, c.from, c.to])).toEqual([[A, 60000, 58000], [B, 90000, 89000]]);
    expect(r.header).toEqual({ total_cost_sen: 147000, mattress_sofa_cost_sen: 147000, total_margin_sen: 153000, margin_pct_basis: 5100 });
  });
  test('a line already at its cost is not a change; a second run has nothing to change', () => {
    const r = planLineCosts(order(), lines, new Map([[A, 60000], [B, 89000]]));
    expect(r.status === 'set' && r.changes.map((c) => c.id)).toEqual([B]);
    expect(planLineCosts(order(), lines, new Map([[A, 60000]]))).toEqual({ status: 'refused', why: 'nothing to change: the named lines already carry those costs' });
  });
  test('refused: a cancelled order, a header that is not its lines, a line the order does not hold', () => {
    expect(planLineCosts(order({ status: 'CANCELLED' }), lines, new Map([[A, 1]])).status).toBe('refused');
    expect(planLineCosts(order({ total_cost_sen: 1 }), lines, new Map([[A, 1]])).status).toBe('refused');
    expect(planLineCosts(order(), lines, new Map([['00000000-0000-4000-8000-0000000000ff', 1]])).status).toBe('refused');
    expect(planLineCosts(order(), lines.map((l) => (l.id === A ? { ...l, cancelled: true } : l)), new Map([[A, 1]])).status).toBe('refused');
  });
  test('no revenue on the header: the margin moves, its basis stays 0', () => {
    const r = planLineCosts(order({ total_revenue_sen: 0, total_margin_sen: -150000 }), lines, new Map([[A, 58000]]));
    expect(r.status === 'set' && r.header).toEqual({ total_cost_sen: 148000, mattress_sofa_cost_sen: 148000, total_margin_sen: -148000, margin_pct_basis: 0 });
  });
});

describe('parseLineCosts / costColumnOf', () => {
  test('reads id:sen pairs and refuses anything else', () => {
    expect([...parseLineCosts(`${A}:60358, ${B}:90842`)]).toEqual([[A, 60358], [B, 90842]]);
    expect(() => parseLineCosts('')).toThrow();
    expect(() => parseLineCosts(`${A}:603.58`)).toThrow();
    expect(() => parseLineCosts(`${A}:1,${A}:2`)).toThrow();
  });
  test('a line cost belongs to its category column', () => {
    expect(costColumnOf('sofa')).toBe('mattress_sofa_cost_sen');
    expect(costColumnOf('BEDFRAME')).toBe('bedframe_cost_sen');
    expect(costColumnOf('service')).toBe('service_cost_sen');
    expect(costColumnOf(null)).toBe('others_cost_sen');
  });
});
