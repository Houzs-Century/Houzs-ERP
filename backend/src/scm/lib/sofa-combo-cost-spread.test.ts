import { describe, expect, it } from 'vitest';
import { planComboCostSpread, type ComboCostLine } from './sofa-combo-cost-spread';
import { loadMasterSofaComboCosts, loadMasterSofaCombos } from './pos-sofa-combos';
import {
  isOnePieceSetCombo, pickComboMatch, pickCostComboMatch, splitSofaCode, spreadComboTotal,
  type SofaComboRow,
} from '../shared/sofa-combo-pricing';

/* Fixtures copy the SHAPE of the company-2 master combo rows and order lines
   read from production on 2026-11-17 (2990-SO-2610-057, -017, -046): the same
   models, modules, tiers, heights and dates. The amounts are illustrative: this
   repository is public, and a cost is not public. Sen. */
const row = (id: string, baseModel: string, modules: string[][], height: string, sen: number, effectiveFrom: string, createdAt: string, tier: SofaComboRow['tier'] = 'PRICE_2'): SofaComboRow => ({
  id, baseModel, modules, tier, customerId: null, pricesByHeight: { [height]: sen }, effectiveFrom, createdAt, deletedAt: null,
});
const line = (id: string, itemCode: string, height: string, fabricCode: string, costSen: number): ComboCostLine => ({
  id, item_code: itemCode, item_group: 'sofa', variants: { seatHeight: height, fabricCode }, qty: 1, line_cost_sen: costSen,
});
const PRICE_2 = () => 'PRICE_2' as const;
const total = (lines: readonly ComboCostLine[], plan: Map<string, number>) =>
  lines.reduce((s, l) => s + (plan.get(l.id) ?? l.line_cost_sen), 0);

/* The rule before this fix, kept here only to prove the fixtures reproduce
   what production booked: newest combo wins, lines in database order. */
function oldSpread(lines: ComboCostLine[], combos: SofaComboRow[], asOf: string): void {
  const match = pickComboMatch(
    { baseModel: '', modules: lines.map((l) => splitSofaCode(l.item_code).sizeCode), customerId: null, tier: 'PRICE_2', height: String(lines[0]!.variants!.seatHeight), asOf },
    combos,
  );
  if (!match) return;
  const matched = match.matchedIndices.map((i) => lines[i]!);
  const spread = spreadComboTotal(matched.map((m) => m.line_cost_sen), match.comboPriceSen);
  matched.forEach((m, i) => { m.line_cost_sen = spread[i]!; });
}

const LOTTI = [
  row('l-cnr', 'Lotti', [['1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)', 'CNR']], '30', 210000, '2026-09-26', '2026-09-26T07:45:05Z'),
  row('l-1a2a', 'Lotti', [['1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)']], '30', 140000, '2026-09-26', '2026-09-26T07:33:58Z'),
  row('l-2al', 'Lotti', [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], '30', 175000, '2026-09-26', '2026-09-26T07:36:05Z'),
  row('l-1na', 'Lotti', [['1NA', '2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], '30', 230000, '2026-09-26', '2026-09-26T07:37:44Z'),
  row('l-corner', 'Lotti', [['1A(LHF)', '2A(RHF)', 'CNR'], ['1A(RHF)', '2A(LHF)', 'CNR']], '30', 210000, '2026-09-26', '2026-09-26T07:40:00Z'),
  row('l-1a+2a', 'Lotti', [['1A(LHF)', '1A(RHF)'], ['2A(LHF)', '2A(RHF)']], '30', 142000, '2026-10-12', '2026-10-12T08:00:00Z'),
  row('l-p1', 'Lotti', [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], '30', 250000, '2026-05-31', '2026-05-31T00:00:00Z', 'PRICE_1'),
];

const PLLAO = [
  row('p-old', 'Pllao', [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], 'Flat', 180000, '2026-07-27', '2026-07-29T07:20:31Z'),
  row('p-older', 'Pllao', [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], 'Flat', 190000, '2026-07-27', '2026-07-27T09:12:11Z'),
  row('p-set', 'Pllao', [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], 'Flat', 180000, '2026-11-05', '2026-11-05T03:46:33Z'),
];

const BOAAT = [
  row('b-3seat', 'Boaat', [['1A(P)(LHF)', '1A(P)(RHF)', '1NA']], '32', 220000, '2026-08-19', '2026-08-19T02:08:42Z'),
  row('b-3seat-p', 'Boaat', [['1A(P)(LHF)', '1A(P)(RHF)', '1NA(P)']], '32', 260000, '2026-08-19', '2026-08-19T02:06:05Z'),
  row('b-2seat', 'Boaat', [['1A(P)(LHF)', '1A(P)(RHF)']], '32', 180000, '2026-08-19', '2026-08-19T02:06:50Z'),
  row('b-set2', 'Boaat', [['1A(P)(LHF)'], ['1A(P)(RHF)']], '32', 180000, '2026-10-27', '2026-10-27T02:02:46Z'),
  row('b-set3', 'Boaat', [['1A(P)(LHF)'], ['1A(P)(RHF)'], ['1NA']], '32', 220000, '2026-10-27', '2026-10-27T02:03:52Z'),
  row('b-mixed', 'Boaat', [['1A(LHF)', '1A(RHF)'], ['1A(P)(LHF)', '1A(P)(RHF)']], '32', 150000, '2026-10-19', '2026-10-19T07:39:18Z'),
  row('b-1sp', 'Boaat', [['1S(P)']], '32', 110000, '2026-10-27', '2026-10-27T02:04:52Z'),
];

describe('a combo that is one slot listing several codes', () => {
  it('is the wrong shape: it can only ever cover one piece', () => {
    expect(isOnePieceSetCombo([['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']])).toBe(true);
    expect(isOnePieceSetCombo([['1A(P)(LHF)', '1A(P)(RHF)']])).toBe(true);
  });

  it('is fine as a set with one slot per piece, or as one whole unit', () => {
    expect(isOnePieceSetCombo([['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']])).toBe(false);
    expect(isOnePieceSetCombo([['1S(P)']])).toBe(false);
    expect(isOnePieceSetCombo(['1A(LHF)', '1A(RHF)'])).toBe(false); // legacy flat list: one slot each
  });

  it('never prices cost, while selling keeps its own matcher unchanged', () => {
    const args = { baseModel: '', modules: ['2A(LHF)', 'L(RHF)'], customerId: null, tier: 'PRICE_2' as const, height: '30', asOf: '2026-11-17' };
    expect(pickComboMatch(args, LOTTI)?.row.id).toBe('l-cnr');
    expect(pickCostComboMatch(args, LOTTI)).toBeNull();
  });
});

describe('the 2990-SO-2610-057 shape: LOTTI 2A + L at 30"', () => {
  const lines = () => [
    line('a-2a', 'LOTTI-2A(LHF)', '30', 'HG1313-02', 100000),
    line('b-l', 'LOTTI-L(RHF)', '30', 'HG1313-02', 100000),
  ];

  it('booked before: the corner-set price on the 2A, the L on top', () => {
    const ls = lines();
    oldSpread(ls, LOTTI, '2026-10-30');
    expect(ls.map((l) => l.line_cost_sen)).toEqual([210000, 100000]);
    expect(ls.reduce((s, l) => s + l.line_cost_sen, 0)).toBe(310000);
  });

  it('now: no combo is a 2A + L set, so each piece keeps its own cost', () => {
    const ls = lines();
    const plan = planComboCostSpread(ls, LOTTI, PRICE_2, '2026-11-17');
    expect(plan.size).toBe(0);
    expect(total(ls, plan)).toBe(200000);
  });
});

describe('the 2990-SO-2610-017 shape: PLLAO L + 2A, flat seat', () => {
  const lines = () => [
    line('a-l', 'PLLAO-L(LHF)', 'Flat', 'D-004', 90000),
    line('b-2a', 'PLLAO-2A(RHF)', 'Flat', 'D-004', 90000),
  ];

  it('booked before: the set at its SELLING figure on the L, the 2A on top', async () => {
    const charged = await loadMasterSofaCombos(fakeSb([{ ...PLLAO_ROW, prices_by_height: { Flat: 180000 }, selling_prices_by_height: { Flat: 190000 } }]), CTX);
    const ls = lines();
    oldSpread(ls, charged, '2026-10-08');
    expect(ls.reduce((s, l) => s + l.line_cost_sen, 0)).toBe(280000);
  });

  it('now: the set combo covers both pieces, at its cost', () => {
    const ls = lines();
    const plan = planComboCostSpread(ls, PLLAO, PRICE_2, '2026-11-17');
    expect([...plan.keys()].sort()).toEqual(['a-l', 'b-2a']);
    expect(total(ls, plan)).toBe(180000);
  });
});

describe('the 2990-SO-2610-046 shape: BOAAT two power seats at 32"', () => {
  const lhf = () => line('id-1', 'BOAAT-1A(P)(LHF)', '32', 'EZ-002', 100000);
  const rhf = () => line('id-2', 'BOAAT-1A(P)(RHF)', '32', 'EZ-002', 100000);

  it('booked before: two saves read the lines in turn and each seat took the set price', () => {
    const a = lhf(); const b = rhf();
    oldSpread([a, b], BOAAT, '2026-10-24');
    oldSpread([b, a], BOAAT, '2026-10-24');
    expect(a.line_cost_sen + b.line_cost_sen).toBe(440000);
  });

  it('re-pricing in either line order on either day never counts the set twice', () => {
    for (const asOf of ['2026-10-24', '2026-11-17']) {
      const first = planComboCostSpread([lhf(), rhf()], BOAAT, PRICE_2, asOf);
      const flipped = planComboCostSpread([rhf(), lhf()], BOAAT, PRICE_2, asOf);
      expect(flipped).toEqual(first);
    }
    // Before the two-seat set existed: the price list's own two pieces.
    expect(total([lhf(), rhf()], planComboCostSpread([lhf(), rhf()], BOAAT, PRICE_2, '2026-10-24'))).toBe(200000);
  });

  it('now: the two-seat set, and the already doubled order heals on its next re-price', () => {
    const doubled = [line('id-1', 'BOAAT-1A(P)(LHF)', '32', 'EZ-002', 220000), line('id-2', 'BOAAT-1A(P)(RHF)', '32', 'EZ-002', 220000)];
    const plan = planComboCostSpread(doubled, BOAAT, PRICE_2, '2026-11-17');
    expect([...plan.values()]).toEqual([90000, 90000]);
    expect(total(doubled, plan)).toBe(180000);
  });
});

/* A minimal PostgREST stand-in: the loaders only select and filter. */
const PLLAO_ROW = {
  id: 'p', base_model: 'Pllao', modules: [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], tier: 'PRICE_2', customer_id: null,
  pwp_prices_by_height: null, label: null, effective_from: '2026-07-27', created_at: '2026-07-29T07:20:31Z',
  deleted_at: null, default_free_gifts: null,
};
const CTX = { get: (k: string) => (k === 'companyId' ? 2 : undefined) };
function fakeSb(rows: Record<string, unknown>[], error: { message: string } | null = null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'in']) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: error ? null : rows, error }).then(res);
  return { from: () => q };
}

describe('the cost spread reads combos at their cost', () => {
  it('takes prices_by_height and ignores the selling grid', async () => {
    const r = await loadMasterSofaComboCosts(fakeSb([{ ...PLLAO_ROW, prices_by_height: { Flat: 180000 }, selling_prices_by_height: { Flat: 190000 } }]), CTX);
    expect(r.error).toBeNull();
    expect(r.rows[0]!.pricesByHeight).toEqual({ Flat: 180000 });
  });

  it('returns a failed read instead of reading it as "no combos"', async () => {
    const r = await loadMasterSofaComboCosts(fakeSb([], { message: 'timeout' }), CTX);
    expect(r).toEqual({ rows: [], error: 'timeout' });
  });
});
