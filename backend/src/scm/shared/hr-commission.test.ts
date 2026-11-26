import { describe, expect, it } from 'vitest';
import {
  COMMISSION_EXCLUDED_STATUSES,
  computeChainCommission,
  computeChainOverride,
  computeShowroomCommission,
  lineKpiSen,
  soEarnsCommission,
  firingFlags,
  unitKpiSen,
  unitKpiExcludedSen,
  type CommissionConfig,
  type ChainSalespersonInput,
  type ItemKpiFlag,
  type KpiUnit,
  type OverrideLevel,
} from './hr-commission';

const cfg: CommissionConfig = {
  baseBps: 100,
  personalKpiThresholdSen: 10_000_000,
  personalKpiBonusBps: 50,
  showroomKpiThresholdSen: 40_000_000,
  showroomKpiBonusBps: 50,
  overrideBaseBps: 50,
  overrideKpiBonusBps: 50,
};

function only<T>(rows: T[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('expected exactly one row');
  return r;
}

describe('computeShowroomCommission', () => {
  it('base rate only when neither KPI threshold is met', () => {
    const row = only(computeShowroomCommission(cfg, 5_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsSen: 5_000_000, itemKpiSen: 0 },
    ]));
    expect(row.personalRateBps).toBe(100);
    expect(row.personalCommissionSen).toBe(50_000);
    expect(row.overrideCommissionSen).toBe(0);
    expect(row.totalSen).toBe(50_000);
  });

  it('adds personal KPI bonus when personal >= 100k', () => {
    const row = only(computeShowroomCommission(cfg, 12_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsSen: 12_000_000, itemKpiSen: 0 },
    ]));
    expect(row.personalRateBps).toBe(150);
    expect(row.personalCommissionSen).toBe(180_000);
  });

  it('adds showroom KPI bonus to every salesperson when showroom >= 400k', () => {
    const row = only(computeShowroomCommission(cfg, 40_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsSen: 5_000_000, itemKpiSen: 0 },
    ]));
    expect(row.personalRateBps).toBe(150);
    expect(row.personalCommissionSen).toBe(75_000);
  });

  it('stacks both KPI bonuses → 2.0% max for tier 1', () => {
    const row = only(computeShowroomCommission(cfg, 50_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsSen: 15_000_000, itemKpiSen: 0 },
    ]));
    expect(row.personalRateBps).toBe(200);
    expect(row.personalCommissionSen).toBe(300_000);
  });

  it('manager earns override on the WHOLE showroom (incl. own), 0.5% below 400k', () => {
    const row = only(computeShowroomCommission(cfg, 30_000_000, [
      { staffId: 'm', tier: 'manager', personalGoodsSen: 8_000_000, itemKpiSen: 0 },
    ]));
    expect(row.personalCommissionSen).toBe(80_000);
    expect(row.overrideRateBps).toBe(50);
    expect(row.overrideCommissionSen).toBe(150_000);
    expect(row.totalSen).toBe(230_000);
  });

  it('manager override rises to 1.0% when showroom >= 400k', () => {
    const row = only(computeShowroomCommission(cfg, 40_000_000, [
      { staffId: 'm', tier: 'manager', personalGoodsSen: 12_000_000, itemKpiSen: 0 },
    ]));
    expect(row.personalCommissionSen).toBe(240_000);
    expect(row.overrideRateBps).toBe(100);
    expect(row.overrideCommissionSen).toBe(400_000);
    expect(row.totalSen).toBe(640_000);
  });

  it('adds item KPI bonus to the total', () => {
    const row = only(computeShowroomCommission(cfg, 5_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsSen: 5_000_000, itemKpiSen: 15_000 },
    ]));
    expect(row.totalSen).toBe(50_000 + 15_000);
  });

  it('a tier-1 salesperson never earns an override', () => {
    const row = only(computeShowroomCommission(cfg, 50_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsSen: 15_000_000, itemKpiSen: 0 },
    ]));
    expect(row.overrideRateBps).toBe(0);
    expect(row.overrideCommissionSen).toBe(0);
  });

  it('computes every member of a multi-person showroom against the shared showroom total', () => {
    const rows = computeShowroomCommission(cfg, 40_000_000, [
      { staffId: 'm', tier: 'manager', personalGoodsSen: 25_000_000, itemKpiSen: 0 },
      { staffId: 's', tier: 'sales', personalGoodsSen: 15_000_000, itemKpiSen: 0 },
    ]);
    expect(rows).toHaveLength(2);
    const sales = rows.find((r) => r.staffId === 's');
    expect(sales?.personalCommissionSen).toBe(300_000);
    expect(sales?.overrideCommissionSen).toBe(0);
  });
});

describe('lineKpiSen', () => {
  const flags: ItemKpiFlag[] = [
    { flagType: 'product', ref: 'MAT-001', bonusSen: 5_000 },
    { flagType: 'fabric', ref: 'fab-uuid-1', bonusSen: 3_000 },
    { flagType: 'special', ref: 'no_side_panel', bonusSen: 2_000 },
  ];

  it('matches a flagged product by item code × qty', () => {
    expect(lineKpiSen({ itemCode: 'MAT-001', qty: 3, fabricId: null, specialCodes: [] }, flags))
      .toBe(15_000);
  });

  it('matches a flagged fabric by fabricId × qty', () => {
    expect(lineKpiSen({ itemCode: 'SOF-9', qty: 2, fabricId: 'fab-uuid-1', specialCodes: [] }, flags))
      .toBe(6_000);
  });

  it('matches a flagged special add-on code × qty', () => {
    expect(lineKpiSen({ itemCode: 'SOF-9', qty: 1, fabricId: null, specialCodes: ['no_side_panel'] }, flags))
      .toBe(2_000);
  });

  it('sums multiple matches on one line', () => {
    expect(lineKpiSen({ itemCode: 'MAT-001', qty: 1, fabricId: 'fab-uuid-1', specialCodes: [] }, flags))
      .toBe(8_000);
  });

  it('returns 0 when nothing matches', () => {
    expect(lineKpiSen({ itemCode: 'X', qty: 9, fabricId: null, specialCodes: [] }, flags)).toBe(0);
  });
});

describe('item-KPI as a goods exclusion (unitKpiSen / unitKpiExcludedSen)', () => {
  const fabricFlag: ItemKpiFlag[] = [{ flagType: 'fabric', ref: 'fab-D', bonusSen: 5_000 }];

  const sofa: KpiUnit = {
    itemCodes: ['ANNSA-3S'],
    qty: 1,
    category: 'SOFA',
    fabricId: 'fab-D',
    specialCodes: [],
    lineTotalSen: 312_500,
    fabricAddonUnitSen: 12_500,
    specialSurchargeUnitSen: 0,
  };

  it('fabric flag: bonus is the fixed amount, exclusion is the fabric Δ only', () => {
    expect(unitKpiSen(sofa, fabricFlag)).toBe(5_000);
    expect(unitKpiExcludedSen(sofa, fabricFlag)).toBe(12_500);
    expect(sofa.lineTotalSen - unitKpiExcludedSen(sofa, fabricFlag)).toBe(300_000);
  });

  it('a split sofa (N module lines, one build) counts the bonus + exclusion ONCE', () => {
    const splitSofa: KpiUnit = {
      itemCodes: ['ANNSA-1A(LHF)', 'ANNSA-CNR', 'ANNSA-1B(RHF)'],
      qty: 1,
      category: 'SOFA',
      fabricId: 'fab-D',
      specialCodes: [],
      lineTotalSen: 800_000,
      fabricAddonUnitSen: 12_500,
      specialSurchargeUnitSen: 0,
    };
    expect(unitKpiSen(splitSofa, fabricFlag)).toBe(5_000);
    expect(unitKpiExcludedSen(splitSofa, fabricFlag)).toBe(12_500);
  });

  it('qty multiplies both the bonus and the fabric exclusion', () => {
    const two = { ...sofa, qty: 2, lineTotalSen: 625_000 };
    expect(unitKpiSen(two, fabricFlag)).toBe(10_000);
    expect(unitKpiExcludedSen(two, fabricFlag)).toBe(25_000);
  });

  it('product flag excludes the WHOLE unit total (the product is the KPI item)', () => {
    const flags: ItemKpiFlag[] = [{ flagType: 'product', ref: 'MAT-001', bonusSen: 8_000 }];
    const mattress: KpiUnit = {
      itemCodes: ['MAT-001'], qty: 1, category: null, fabricId: null, specialCodes: [],
      lineTotalSen: 150_000, fabricAddonUnitSen: 0, specialSurchargeUnitSen: 0,
    };
    expect(unitKpiSen(mattress, flags)).toBe(8_000);
    expect(unitKpiExcludedSen(mattress, flags)).toBe(150_000);
  });

  it('special flag excludes the special-order surcharge (qty × per-item)', () => {
    const flags: ItemKpiFlag[] = [{ flagType: 'special', ref: 'no_side_panel', bonusSen: 2_000 }];
    const unit: KpiUnit = {
      itemCodes: ['SOF-9'], qty: 2, category: null, fabricId: null, specialCodes: ['no_side_panel'],
      lineTotalSen: 400_000, fabricAddonUnitSen: 0, specialSurchargeUnitSen: 30_000,
    };
    expect(unitKpiSen(unit, flags)).toBe(4_000);
    expect(unitKpiExcludedSen(unit, flags)).toBe(60_000);
  });

  it('exclusion is capped at the unit total (never drives goods negative)', () => {
    const tiny: KpiUnit = {
      itemCodes: ['BF-1'], qty: 1, category: null, fabricId: 'fab-D', specialCodes: [],
      lineTotalSen: 9_000, fabricAddonUnitSen: 12_500, specialSurchargeUnitSen: 0,
    };
    expect(unitKpiExcludedSen(tiny, fabricFlag)).toBe(9_000);
  });

  it('no exclusion and no bonus when no flag fires', () => {
    const plain: KpiUnit = {
      itemCodes: ['ANNSA-3S'], qty: 1, category: null, fabricId: 'fab-OTHER', specialCodes: [],
      lineTotalSen: 300_000, fabricAddonUnitSen: 12_500, specialSurchargeUnitSen: 0,
    };
    expect(unitKpiSen(plain, fabricFlag)).toBe(0);
    expect(unitKpiExcludedSen(plain, fabricFlag)).toBe(0);
  });
});

// ── category rules + the product-beats-category precedence ───────────────────
// Owner 2026-07-18: a product rule may name ONE product OR a whole category, and
// commission is read "by item" — one item pays once. These tests pin the ONE
// place those two statements could contradict each other: an item that is both
// named individually AND covered by its category.
describe('category item-KPI rules', () => {
  const catFlag: ItemKpiFlag[] = [{ flagType: 'category', ref: 'SOFA', bonusSen: 3_000 }];

  const sofaUnit: KpiUnit = {
    itemCodes: ['ANNSA-3S'], qty: 1, category: 'SOFA', fabricId: null, specialCodes: [],
    lineTotalSen: 300_000, fabricAddonUnitSen: 0, specialSurchargeUnitSen: 0,
  };

  it('fires on every item in the category, and excludes the whole unit', () => {
    expect(unitKpiSen(sofaUnit, catFlag)).toBe(3_000);
    expect(unitKpiExcludedSen(sofaUnit, catFlag)).toBe(300_000);
  });

  it('does not fire on an item in a different category', () => {
    const mattress = { ...sofaUnit, itemCodes: ['MAT-001'], category: 'MATTRESS' };
    expect(unitKpiSen(mattress, catFlag)).toBe(0);
    expect(unitKpiExcludedSen(mattress, catFlag)).toBe(0);
  });

  it('does not fire when the category could not be resolved (null is unpaid, not guessed)', () => {
    const unknown = { ...sofaUnit, category: null };
    expect(unitKpiSen(unknown, catFlag)).toBe(0);
    expect(unitKpiExcludedSen(unknown, catFlag)).toBe(0);
  });

  it('qty multiplies the category bonus', () => {
    expect(unitKpiSen({ ...sofaUnit, qty: 4 }, catFlag)).toBe(12_000);
  });

  it('a product rule BEATS a category rule on the same item — paid ONCE, at the product rate', () => {
    const both: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusSen: 3_000 },
      { flagType: 'product', ref: 'ANNSA-3S', bonusSen: 8_000 },
    ];
    expect(unitKpiSen(sofaUnit, both)).toBe(8_000);
    expect(unitKpiExcludedSen(sofaUnit, both)).toBe(300_000);
    expect(firingFlags(sofaUnit, both).map((f) => f.flagType)).toEqual(['product']);
  });

  it('the category rule still pays for a sibling the product rule does not name', () => {
    const both: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusSen: 3_000 },
      { flagType: 'product', ref: 'ANNSA-3S', bonusSen: 8_000 },
    ];
    const otherSofa = { ...sofaUnit, itemCodes: ['BALI-2S'] };
    expect(unitKpiSen(otherSofa, both)).toBe(3_000);
  });

  it('a product rule on a DIFFERENT item does not suppress this item\'s category rule', () => {
    const both: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusSen: 3_000 },
      { flagType: 'product', ref: 'SOMETHING-ELSE', bonusSen: 8_000 },
    ];
    expect(unitKpiSen(sofaUnit, both)).toBe(3_000);
  });

  it('a category rule still stacks with a fabric rule (different dimensions)', () => {
    const mixed: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusSen: 3_000 },
      { flagType: 'fabric', ref: 'fab-D', bonusSen: 5_000 },
    ];
    const u = { ...sofaUnit, fabricId: 'fab-D', fabricAddonUnitSen: 12_500 };
    expect(unitKpiSen(u, mixed)).toBe(8_000);
    expect(unitKpiExcludedSen(u, mixed)).toBe(300_000);
  });

  it('a split build resolves its category once and pays once', () => {
    const splitSofa: KpiUnit = {
      itemCodes: ['ANNSA-1A(LHF)', 'ANNSA-CNR', 'ANNSA-1B(RHF)'],
      qty: 1, category: 'SOFA', fabricId: null, specialCodes: [],
      lineTotalSen: 800_000, fabricAddonUnitSen: 0, specialSurchargeUnitSen: 0,
    };
    expect(unitKpiSen(splitSofa, catFlag)).toBe(3_000);
    expect(unitKpiExcludedSen(splitSofa, catFlag)).toBe(800_000);
  });

  // Multi-select in HR Settings creates N DISCRETE one-item rules (owner
  // 2026-07-18: "fabric 只能选一个 item"), never one rule holding a list. Each
  // saved rule targets exactly one thing, and a unit has exactly one fabric
  // series — so selecting three fabrics can never pay one item three times.
  it('N fabric rules from one multi-select: an item matches at most one of them', () => {
    const threeFabrics: ItemKpiFlag[] = [
      { flagType: 'fabric', ref: 'BF', bonusSen: 5_000 },
      { flagType: 'fabric', ref: 'CG', bonusSen: 6_000 },
      { flagType: 'fabric', ref: 'DK', bonusSen: 7_000 },
    ];
    const u = { ...sofaUnit, fabricId: 'CG', fabricAddonUnitSen: 12_500 };
    expect(firingFlags(u, threeFabrics)).toHaveLength(1);
    expect(unitKpiSen(u, threeFabrics)).toBe(6_000);
  });
});

// ── owner ruling 2026-07-17: "draft肯定不算" ─────────────────────────────────
describe('soEarnsCommission (DRAFT exclusion)', () => {
  const ALL_STATUSES = [
    'DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
    'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED', 'ON_HOLD',
  ];

  it('a DRAFT earns NO commission (the ruling)', () => {
    expect(soEarnsCommission('DRAFT', false)).toBe(false);
  });

  it('still excludes CANCELLED and ON_HOLD (2990 parity — unchanged)', () => {
    expect(soEarnsCommission('CANCELLED', false)).toBe(false);
    expect(soEarnsCommission('ON_HOLD', false)).toBe(false);
  });

  it.each(['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'DELIVERED', 'INVOICED'])(
    'a HELD order on %s earns NO commission, whatever its status says',
    (status) => { expect(soEarnsCommission(status, true)).toBe(false); },
  );

  it('an unreadable marker does NOT block a commission — over-blocking pay is its own wrong', () => {
    expect(soEarnsCommission('CONFIRMED', null)).toBe(true);
  });

  it('EXACTLY 7 of the 10 statuses earn — nothing else was quietly cut', () => {
    expect(ALL_STATUSES.filter((st) => soEarnsCommission(st, false))).toEqual([
      'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
      'DELIVERED', 'INVOICED', 'CLOSED',
    ]);
  });

  it('every excluded status is a REAL status (a typo would pay everyone)', () => {
    for (const s of COMMISSION_EXCLUDED_STATUSES) expect(ALL_STATUSES).toContain(s);
  });

  it('is case-insensitive, and an unknown status EARNS (matches the SQL filter)', () => {
    expect(soEarnsCommission('draft', false)).toBe(false);
    expect(soEarnsCommission('SOMETHING_NEW', false)).toBe(true);
    expect(soEarnsCommission(null, false)).toBe(true);
  });
});

// ── owner ruling 2026-07-17: "無限 讓我們自己add 按SO算" ──────────────────────
describe('computeChainOverride (recursive reporting-line override)', () => {
  const levels: OverrideLevel[] = [
    { level: 1, rateBps: 50 },
    { level: 2, rateBps: 25 },
  ];

  it('pays each configured level its own rate on that level own goods', () => {
    const r = computeChainOverride(levels, new Map([[1, 10_000_000], [2, 20_000_000]]));
    expect(r.overrideCommissionSen).toBe(50_000 + 50_000);
    expect(r.overrideDetail).toEqual([
      { level: 1, rateBps: 50, goodsSen: 10_000_000, commissionSen: 50_000 },
      { level: 2, rateBps: 25, goodsSen: 20_000_000, commissionSen: 50_000 },
    ]);
  });

  it('a level with goods but NO configured rate earns nothing ("讓我們自己add")', () => {
    const r = computeChainOverride(levels, new Map([[1, 10_000_000], [3, 50_000_000]]));
    expect(r.overrideCommissionSen).toBe(50_000);
    expect(r.overrideDetail.map((d) => d.level)).toEqual([1]);
  });

  it('a configured level with no downline goods earns nothing and is not listed', () => {
    const r = computeChainOverride(levels, new Map([[1, 10_000_000]]));
    expect(r.overrideCommissionSen).toBe(50_000);
    expect(r.overrideDetail.map((d) => d.level)).toEqual([1]);
  });

  it('no downline at all → RM 0 override (not an error)', () => {
    expect(computeChainOverride(levels, new Map()).overrideCommissionSen).toBe(0);
  });

  it('"無限": a deep level earns exactly like a shallow one — no cap in the math', () => {
    const r = computeChainOverride([{ level: 25, rateBps: 10 }], new Map([[25, 10_000_000]]));
    expect(r.overrideCommissionSen).toBe(10_000);
  });

  it('rounds ONCE per level, on that level summed goods (money — mirrors 2990)', () => {
    expect(computeChainOverride([{ level: 1, rateBps: 3 }], new Map([[1, 3_333]])).overrideCommissionSen).toBe(1);
  });

  it('detail order is stable regardless of configured order (byte-stable snapshots)', () => {
    const shuffled: OverrideLevel[] = [{ level: 2, rateBps: 25 }, { level: 1, rateBps: 50 }];
    const r = computeChainOverride(shuffled, new Map([[1, 10_000_000], [2, 20_000_000]]));
    expect(r.overrideDetail.map((d) => d.level)).toEqual([1, 2]);
  });
});

describe('computeChainCommission (the double-pay guard)', () => {
  const levels: OverrideLevel[] = [
    { level: 1, rateBps: 50 },
    { level: 2, rateBps: 25 },
  ];
  const chain = (
    staffId: string,
    tier: 'sales' | 'manager',
    personalGoodsSen: number,
    goodsByLevel: Map<number, number>,
  ): ChainSalespersonInput => ({ staffId, tier, personalGoodsSen, itemKpiSen: 0, goodsByLevel });

  it('THE GUARD: two stacked managers each earn on the seller goods ONCE, at their own level', () => {
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('A', 'sales', 10_000_000, new Map()),
      chain('M1', 'manager', 0, new Map([[1, 10_000_000]])),
      chain('M2', 'manager', 0, new Map([[2, 10_000_000]])),
    ]);
    const m1 = rows.find((r) => r.staffId === 'M1');
    const m2 = rows.find((r) => r.staffId === 'M2');
    expect(m1?.overrideCommissionSen).toBe(50_000);
    expect(m2?.overrideCommissionSen).toBe(25_000);
    expect(m1?.overrideCommissionSen).not.toBe(m2?.overrideCommissionSen);
  });

  it('THE GUARD: the seller earns personal commission and NO override on their own sale', () => {
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('A', 'sales', 10_000_000, new Map()),
    ]);
    expect(rows[0]?.personalRateBps).toBe(150);
    expect(rows[0]?.personalCommissionSen).toBe(150_000);
    expect(rows[0]?.overrideCommissionSen).toBe(0);
  });

  it('a manager who also SELLS: personal on their own, override on the downline, never both on one sale', () => {
    const rows = computeChainCommission(cfg, 30_000_000, levels, [
      chain('M', 'manager', 10_000_000, new Map([[1, 20_000_000]])),
    ]);
    expect(rows[0]?.personalRateBps).toBe(150);
    expect(rows[0]?.personalCommissionSen).toBe(150_000);
    expect(rows[0]?.overrideCommissionSen).toBe(100_000);
    expect(rows[0]?.totalSen).toBe(250_000);
  });

  it('tier is NOT consulted: a sales-tier person with a downline earns the override', () => {
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('S', 'sales', 0, new Map([[1, 10_000_000]])),
      chain('M', 'manager', 0, new Map()),
    ]);
    expect(rows.find((r) => r.staffId === 'S')?.overrideCommissionSen).toBe(50_000);
    expect(rows.find((r) => r.staffId === 'M')?.overrideCommissionSen).toBe(0);
  });

  it('reports overrideRateBps as NULL — there is no single rate in chain mode', () => {
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('M', 'manager', 0, new Map([[1, 10_000_000], [2, 20_000_000]])),
    ]);
    expect(rows[0]?.overrideRateBps).toBeNull();
    expect(rows[0]?.overrideDetail).toHaveLength(2);
  });

  it('personal commission is IDENTICAL to showroom mode — only the override changes', () => {
    const person = { staffId: 'a', tier: 'sales' as const, personalGoodsSen: 15_000_000, itemKpiSen: 7_000 };
    const showroom = computeShowroomCommission(cfg, 50_000_000, [person]);
    const chained = computeChainCommission(cfg, 50_000_000, levels, [{ ...person, goodsByLevel: new Map() }]);
    expect(chained[0]?.personalRateBps).toBe(showroom[0]?.personalRateBps);
    expect(chained[0]?.personalCommissionSen).toBe(showroom[0]?.personalCommissionSen);
    expect(chained[0]?.itemKpiSen).toBe(showroom[0]?.itemKpiSen);
  });

  it('the item-KPI fixed bonus still lands in the total in chain mode', () => {
    const rows = computeChainCommission(cfg, 5_000_000, levels, [
      { ...chain('a', 'sales', 5_000_000, new Map([[1, 10_000_000]])), itemKpiSen: 15_000 },
    ]);
    expect(rows[0]?.totalSen).toBe(50_000 + 50_000 + 15_000);
  });
});
