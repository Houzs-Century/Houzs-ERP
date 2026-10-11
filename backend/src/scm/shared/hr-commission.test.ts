import { describe, expect, it } from 'vitest';
import {
  COMMISSION_EXCLUDED_STATUSES,
  computeChainCommission,
  computeChainOverride,
  computeShowroomCommission,
  lineKpiCenti,
  soEarnsCommission,
  firingFlags,
  unitKpiCenti,
  unitKpiExcludedCenti,
  type CommissionConfig,
  type ChainSalespersonInput,
  type ItemKpiFlag,
  type KpiUnit,
  type OverrideLevel,
} from './hr-commission';

const cfg: CommissionConfig = {
  baseBps: 100,
  personalKpiThresholdCenti: 10_000_000, // RM 100k
  personalKpiBonusBps: 50,
  showroomKpiThresholdCenti: 40_000_000, // RM 400k
  showroomKpiBonusBps: 50,
  overrideBaseBps: 50,
  overrideKpiBonusBps: 50,
};

// type-safe "take the first (and only) row" — keeps noUncheckedIndexedAccess happy
function only<T>(rows: T[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('expected exactly one row');
  return r;
}

describe('computeShowroomCommission', () => {
  it('base rate only when neither KPI threshold is met', () => {
    // personal RM 50k, showroom RM 50k → 1.0% of 50k = RM 500
    const row = only(computeShowroomCommission(cfg, 5_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsCenti: 5_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.personalRateBps).toBe(100);
    expect(row.personalCommissionCenti).toBe(50_000);
    expect(row.overrideCommissionCenti).toBe(0);
    expect(row.totalCenti).toBe(50_000);
  });

  it('adds personal KPI bonus when personal >= 100k', () => {
    // personal RM 120k, showroom RM 120k (<400k) → 1.5% of 120k = RM 1,800
    const row = only(computeShowroomCommission(cfg, 12_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsCenti: 12_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.personalRateBps).toBe(150);
    expect(row.personalCommissionCenti).toBe(180_000);
  });

  it('adds showroom KPI bonus to every salesperson when showroom >= 400k', () => {
    // personal RM 50k (<100k), showroom RM 400k → 1.5% of 50k = RM 750
    const row = only(computeShowroomCommission(cfg, 40_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsCenti: 5_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.personalRateBps).toBe(150);
    expect(row.personalCommissionCenti).toBe(75_000);
  });

  it('stacks both KPI bonuses → 2.0% max for tier 1', () => {
    // personal RM 150k, showroom RM 500k → 2.0% of 150k = RM 3,000
    const row = only(computeShowroomCommission(cfg, 50_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsCenti: 15_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.personalRateBps).toBe(200);
    expect(row.personalCommissionCenti).toBe(300_000);
  });

  it('manager earns override on the WHOLE showroom (incl. own), 0.5% below 400k', () => {
    // showroom RM 300k (<400k); manager personal RM 80k.
    // personal: 1.0% of 80k = RM 800 ; override: 0.5% of 300k = RM 1,500
    const row = only(computeShowroomCommission(cfg, 30_000_000, [
      { staffId: 'm', tier: 'manager', personalGoodsCenti: 8_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.personalCommissionCenti).toBe(80_000);
    expect(row.overrideRateBps).toBe(50);
    expect(row.overrideCommissionCenti).toBe(150_000);
    expect(row.totalCenti).toBe(230_000);
  });

  it('manager override rises to 1.0% when showroom >= 400k', () => {
    // showroom RM 400k; manager personal RM 120k.
    // personal: (1.0+0.5+0.5)=2.0% of 120k = RM 2,400 ; override: 1.0% of 400k = RM 4,000
    const row = only(computeShowroomCommission(cfg, 40_000_000, [
      { staffId: 'm', tier: 'manager', personalGoodsCenti: 12_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.personalCommissionCenti).toBe(240_000);
    expect(row.overrideRateBps).toBe(100);
    expect(row.overrideCommissionCenti).toBe(400_000);
    expect(row.totalCenti).toBe(640_000);
  });

  it('adds item KPI bonus to the total', () => {
    const row = only(computeShowroomCommission(cfg, 5_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsCenti: 5_000_000, itemKpiCenti: 15_000 },
    ]));
    expect(row.totalCenti).toBe(50_000 + 15_000);
  });

  it('a tier-1 salesperson never earns an override', () => {
    const row = only(computeShowroomCommission(cfg, 50_000_000, [
      { staffId: 'a', tier: 'sales', personalGoodsCenti: 15_000_000, itemKpiCenti: 0 },
    ]));
    expect(row.overrideRateBps).toBe(0);
    expect(row.overrideCommissionCenti).toBe(0);
  });

  it('computes every member of a multi-person showroom against the shared showroom total', () => {
    // showroom RM 400k total (KPI hit for everyone); one manager + one sales.
    const rows = computeShowroomCommission(cfg, 40_000_000, [
      { staffId: 'm', tier: 'manager', personalGoodsCenti: 25_000_000, itemKpiCenti: 0 },
      { staffId: 's', tier: 'sales', personalGoodsCenti: 15_000_000, itemKpiCenti: 0 },
    ]);
    expect(rows).toHaveLength(2);
    // sales: 2.0% of 150k = RM 3,000, no override
    const sales = rows.find((r) => r.staffId === 's');
    expect(sales?.personalCommissionCenti).toBe(300_000);
    expect(sales?.overrideCommissionCenti).toBe(0);
  });
});

describe('lineKpiCenti', () => {
  const flags: ItemKpiFlag[] = [
    { flagType: 'product', ref: 'MAT-001', bonusCenti: 5_000 },
    { flagType: 'fabric', ref: 'fab-uuid-1', bonusCenti: 3_000 },
    { flagType: 'special', ref: 'no_side_panel', bonusCenti: 2_000 },
  ];

  it('matches a flagged product by item code × qty', () => {
    expect(lineKpiCenti({ itemCode: 'MAT-001', qty: 3, fabricId: null, specialCodes: [] }, flags))
      .toBe(15_000);
  });

  it('matches a flagged fabric by fabricId × qty', () => {
    expect(lineKpiCenti({ itemCode: 'SOF-9', qty: 2, fabricId: 'fab-uuid-1', specialCodes: [] }, flags))
      .toBe(6_000);
  });

  it('matches a flagged special add-on code × qty', () => {
    expect(lineKpiCenti({ itemCode: 'SOF-9', qty: 1, fabricId: null, specialCodes: ['no_side_panel'] }, flags))
      .toBe(2_000);
  });

  it('sums multiple matches on one line', () => {
    expect(lineKpiCenti({ itemCode: 'MAT-001', qty: 1, fabricId: 'fab-uuid-1', specialCodes: [] }, flags))
      .toBe(8_000);
  });

  it('returns 0 when nothing matches', () => {
    expect(lineKpiCenti({ itemCode: 'X', qty: 9, fabricId: null, specialCodes: [] }, flags)).toBe(0);
  });
});

describe('item-KPI as a goods exclusion (unitKpiCenti / unitKpiExcludedCenti)', () => {
  // RM 50 fixed bonus on fabric 'fab-D'.
  const fabricFlag: ItemKpiFlag[] = [{ flagType: 'fabric', ref: 'fab-D', bonusCenti: 5_000 }];

  // Loo's worked example: a single-line sofa, base RM 3,000 + RM 125 fabric Δ.
  const sofa: KpiUnit = {
    itemCodes: ['ANNSA-3S'],
    qty: 1,
    category: 'SOFA',
    fabricId: 'fab-D',
    specialCodes: [],
    lineTotalCenti: 312_500, // RM 3,125 (base + fabric Δ)
    fabricAddonUnitCenti: 12_500, // RM 125
    specialSurchargeUnitCenti: 0,
  };

  it('fabric flag: bonus is the fixed amount, exclusion is the fabric Δ only', () => {
    expect(unitKpiCenti(sofa, fabricFlag)).toBe(5_000); // RM 50, once
    expect(unitKpiExcludedCenti(sofa, fabricFlag)).toBe(12_500); // drop only the RM 125 Δ
    // → goods that count = 312,500 − 12,500 = 300,000 (RM 3,000), exactly Loo's case.
    expect(sofa.lineTotalCenti - unitKpiExcludedCenti(sofa, fabricFlag)).toBe(300_000);
  });

  it('a split sofa (N module lines, one build) counts the bonus + exclusion ONCE', () => {
    // Three module lines collapsed into one unit: total goods is the build sum,
    // the fabric Δ is the per-build flat figure (NOT × module count).
    const splitSofa: KpiUnit = {
      itemCodes: ['ANNSA-1A(LHF)', 'ANNSA-CNR', 'ANNSA-1B(RHF)'],
      qty: 1,
      category: 'SOFA',
      fabricId: 'fab-D',
      specialCodes: [],
      lineTotalCenti: 800_000, // RM 8,000 build total
      fabricAddonUnitCenti: 12_500, // RM 125 once, not 3×
      specialSurchargeUnitCenti: 0,
    };
    expect(unitKpiCenti(splitSofa, fabricFlag)).toBe(5_000); // RM 50, not 3×50
    expect(unitKpiExcludedCenti(splitSofa, fabricFlag)).toBe(12_500); // RM 125, not 3×125
  });

  it('qty multiplies both the bonus and the fabric exclusion', () => {
    const two = { ...sofa, qty: 2, lineTotalCenti: 625_000 };
    expect(unitKpiCenti(two, fabricFlag)).toBe(10_000); // 2 × RM 50
    expect(unitKpiExcludedCenti(two, fabricFlag)).toBe(25_000); // 2 × RM 125
  });

  it('product flag excludes the WHOLE unit total (the product is the KPI item)', () => {
    const flags: ItemKpiFlag[] = [{ flagType: 'product', ref: 'MAT-001', bonusCenti: 8_000 }];
    const mattress: KpiUnit = {
      itemCodes: ['MAT-001'], qty: 1, category: null, fabricId: null, specialCodes: [],
      lineTotalCenti: 150_000, fabricAddonUnitCenti: 0, specialSurchargeUnitCenti: 0,
    };
    expect(unitKpiCenti(mattress, flags)).toBe(8_000);
    expect(unitKpiExcludedCenti(mattress, flags)).toBe(150_000); // whole line
  });

  it('special flag excludes the special-order surcharge (qty × per-item)', () => {
    const flags: ItemKpiFlag[] = [{ flagType: 'special', ref: 'no_side_panel', bonusCenti: 2_000 }];
    const unit: KpiUnit = {
      itemCodes: ['SOF-9'], qty: 2, category: null, fabricId: null, specialCodes: ['no_side_panel'],
      lineTotalCenti: 400_000, fabricAddonUnitCenti: 0, specialSurchargeUnitCenti: 30_000,
    };
    expect(unitKpiCenti(unit, flags)).toBe(4_000); // 2 × RM 20
    expect(unitKpiExcludedCenti(unit, flags)).toBe(60_000); // 2 × RM 300
  });

  it('exclusion is capped at the unit total (never drives goods negative)', () => {
    const tiny: KpiUnit = {
      itemCodes: ['BF-1'], qty: 1, category: null, fabricId: 'fab-D', specialCodes: [],
      lineTotalCenti: 9_000, fabricAddonUnitCenti: 12_500, specialSurchargeUnitCenti: 0,
    };
    expect(unitKpiExcludedCenti(tiny, fabricFlag)).toBe(9_000); // capped, not 12,500
  });

  it('no exclusion and no bonus when no flag fires', () => {
    const plain: KpiUnit = {
      itemCodes: ['ANNSA-3S'], qty: 1, category: null, fabricId: 'fab-OTHER', specialCodes: [],
      lineTotalCenti: 300_000, fabricAddonUnitCenti: 12_500, specialSurchargeUnitCenti: 0,
    };
    expect(unitKpiCenti(plain, fabricFlag)).toBe(0);
    expect(unitKpiExcludedCenti(plain, fabricFlag)).toBe(0); // non-flagged fabric Δ stays goods
  });
});

// ── category rules + the product-beats-category precedence ───────────────────
// Owner 2026-07-18: a product rule may name ONE product OR a whole category, and
// commission is read "by item" — one item pays once. These tests pin the ONE
// place those two statements could contradict each other: an item that is both
// named individually AND covered by its category.
describe('category item-KPI rules', () => {
  const catFlag: ItemKpiFlag[] = [{ flagType: 'category', ref: 'SOFA', bonusCenti: 3_000 }];

  const sofaUnit: KpiUnit = {
    itemCodes: ['ANNSA-3S'], qty: 1, category: 'SOFA', fabricId: null, specialCodes: [],
    lineTotalCenti: 300_000, fabricAddonUnitCenti: 0, specialSurchargeUnitCenti: 0,
  };

  it('fires on every item in the category, and excludes the whole unit', () => {
    expect(unitKpiCenti(sofaUnit, catFlag)).toBe(3_000);
    // A category rule targets the ITEM, so like a product rule it replaces the
    // percentage commission on the whole unit rather than trimming an add-on.
    expect(unitKpiExcludedCenti(sofaUnit, catFlag)).toBe(300_000);
  });

  it('does not fire on an item in a different category', () => {
    const mattress = { ...sofaUnit, itemCodes: ['MAT-001'], category: 'MATTRESS' };
    expect(unitKpiCenti(mattress, catFlag)).toBe(0);
    expect(unitKpiExcludedCenti(mattress, catFlag)).toBe(0);
  });

  it('does not fire when the category could not be resolved (null is unpaid, not guessed)', () => {
    const unknown = { ...sofaUnit, category: null };
    expect(unitKpiCenti(unknown, catFlag)).toBe(0);
    expect(unitKpiExcludedCenti(unknown, catFlag)).toBe(0);
  });

  it('qty multiplies the category bonus', () => {
    expect(unitKpiCenti({ ...sofaUnit, qty: 4 }, catFlag)).toBe(12_000);
  });

  // THE MONEY CASE: both rules cover this one sofa.
  it('a product rule BEATS a category rule on the same item — paid ONCE, at the product rate', () => {
    const both: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusCenti: 3_000 },
      { flagType: 'product', ref: 'ANNSA-3S', bonusCenti: 8_000 },
    ];
    // NOT 11,000 (both) and NOT 3,000 (category) — the specific rule wins.
    expect(unitKpiCenti(sofaUnit, both)).toBe(8_000);
    // And the unit is excluded from goods exactly ONCE, not twice.
    expect(unitKpiExcludedCenti(sofaUnit, both)).toBe(300_000);
    expect(firingFlags(sofaUnit, both).map((f) => f.flagType)).toEqual(['product']);
  });

  it('the category rule still pays for a sibling the product rule does not name', () => {
    const both: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusCenti: 3_000 },
      { flagType: 'product', ref: 'ANNSA-3S', bonusCenti: 8_000 },
    ];
    const otherSofa = { ...sofaUnit, itemCodes: ['BALI-2S'] };
    expect(unitKpiCenti(otherSofa, both)).toBe(3_000);
  });

  it('a product rule on a DIFFERENT item does not suppress this item\'s category rule', () => {
    const both: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusCenti: 3_000 },
      { flagType: 'product', ref: 'SOMETHING-ELSE', bonusCenti: 8_000 },
    ];
    expect(unitKpiCenti(sofaUnit, both)).toBe(3_000);
  });

  // Suppression is product-vs-category ONLY: fabric and special target a
  // different dimension of the purchase and keep stacking as they always did.
  it('a category rule still stacks with a fabric rule (different dimensions)', () => {
    const mixed: ItemKpiFlag[] = [
      { flagType: 'category', ref: 'SOFA', bonusCenti: 3_000 },
      { flagType: 'fabric', ref: 'fab-D', bonusCenti: 5_000 },
    ];
    const u = { ...sofaUnit, fabricId: 'fab-D', fabricAddonUnitCenti: 12_500 };
    expect(unitKpiCenti(u, mixed)).toBe(8_000);
    // Whole unit already excluded by the category rule; the fabric Δ is inside
    // it, so the exclusion is the unit total and is still capped there.
    expect(unitKpiExcludedCenti(u, mixed)).toBe(300_000);
  });

  it('a split build resolves its category once and pays once', () => {
    const splitSofa: KpiUnit = {
      itemCodes: ['ANNSA-1A(LHF)', 'ANNSA-CNR', 'ANNSA-1B(RHF)'],
      qty: 1, category: 'SOFA', fabricId: null, specialCodes: [],
      lineTotalCenti: 800_000, fabricAddonUnitCenti: 0, specialSurchargeUnitCenti: 0,
    };
    expect(unitKpiCenti(splitSofa, catFlag)).toBe(3_000); // not 3× the modules
    expect(unitKpiExcludedCenti(splitSofa, catFlag)).toBe(800_000);
  });

  // Multi-select in HR Settings creates N DISCRETE one-item rules (owner
  // 2026-07-18: "fabric 只能选一个 item"), never one rule holding a list. Each
  // saved rule targets exactly one thing, and a unit has exactly one fabric
  // series — so selecting three fabrics can never pay one item three times.
  it('N fabric rules from one multi-select: an item matches at most one of them', () => {
    const threeFabrics: ItemKpiFlag[] = [
      { flagType: 'fabric', ref: 'BF', bonusCenti: 5_000 },
      { flagType: 'fabric', ref: 'CG', bonusCenti: 6_000 },
      { flagType: 'fabric', ref: 'DK', bonusCenti: 7_000 },
    ];
    const u = { ...sofaUnit, fabricId: 'CG', fabricAddonUnitCenti: 12_500 };
    expect(firingFlags(u, threeFabrics)).toHaveLength(1);
    expect(unitKpiCenti(u, threeFabrics)).toBe(6_000); // only CG, once
  });
});

// ── owner ruling 2026-07-17: "draft肯定不算" ─────────────────────────────────
describe('soEarnsCommission (DRAFT exclusion)', () => {
  // The full status ladder, copied from mfg-sales-orders.ts SO_STATUSES.
  const ALL_STATUSES = [
    'DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
    'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED', 'ON_HOLD',
  ];

  it('a DRAFT earns NO commission (the ruling)', () => {
    expect(soEarnsCommission('DRAFT')).toBe(false);
  });

  it('still excludes CANCELLED and ON_HOLD (2990 parity — unchanged)', () => {
    expect(soEarnsCommission('CANCELLED')).toBe(false);
    expect(soEarnsCommission('ON_HOLD')).toBe(false);
  });

  it('EXACTLY 7 of the 10 statuses earn — nothing else was quietly cut', () => {
    // The real risk in touching this filter is not missing DRAFT, it is
    // excluding one status too many: dropping CLOSED or INVOICED would silently
    // stop paying on completed sales and just look like a slow month.
    expect(ALL_STATUSES.filter(soEarnsCommission)).toEqual([
      'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
      'DELIVERED', 'INVOICED', 'CLOSED',
    ]);
  });

  it('every excluded status is a REAL status (a typo would pay everyone)', () => {
    // 'ONHOLD' would exclude nothing and quietly pay every paused order.
    for (const s of COMMISSION_EXCLUDED_STATUSES) expect(ALL_STATUSES).toContain(s);
  });

  it('is case-insensitive, and an unknown status EARNS (matches the SQL filter)', () => {
    expect(soEarnsCommission('draft')).toBe(false);
    // `not in (...)` excludes a LISTED status — it does not require a known one.
    expect(soEarnsCommission('SOMETHING_NEW')).toBe(true);
    expect(soEarnsCommission(null)).toBe(true);
  });
});

// ── owner ruling 2026-07-17: "無限 讓我們自己add 按SO算" ──────────────────────
describe('computeChainOverride (recursive reporting-line override)', () => {
  const levels: OverrideLevel[] = [
    { level: 1, rateBps: 50 }, // 0.5% on direct reports
    { level: 2, rateBps: 25 }, // 0.25% on their reports
  ];

  it('pays each configured level its own rate on that level own goods', () => {
    // level 1: 0.5% of RM 100k = RM 500 ; level 2: 0.25% of RM 200k = RM 500
    const r = computeChainOverride(levels, new Map([[1, 10_000_000], [2, 20_000_000]]));
    expect(r.overrideCommissionCenti).toBe(50_000 + 50_000);
    expect(r.overrideDetail).toEqual([
      { level: 1, rateBps: 50, goodsCenti: 10_000_000, commissionCenti: 50_000 },
      { level: 2, rateBps: 25, goodsCenti: 20_000_000, commissionCenti: 50_000 },
    ]);
  });

  it('a level with goods but NO configured rate earns nothing ("讓我們自己add")', () => {
    // RM 500k sits at level 3, but the owner never added a level 3.
    const r = computeChainOverride(levels, new Map([[1, 10_000_000], [3, 50_000_000]]));
    expect(r.overrideCommissionCenti).toBe(50_000); // level 1 only
    expect(r.overrideDetail.map((d) => d.level)).toEqual([1]);
  });

  it('a configured level with no downline goods earns nothing and is not listed', () => {
    const r = computeChainOverride(levels, new Map([[1, 10_000_000]]));
    expect(r.overrideCommissionCenti).toBe(50_000);
    expect(r.overrideDetail.map((d) => d.level)).toEqual([1]);
  });

  it('no downline at all → RM 0 override (not an error)', () => {
    expect(computeChainOverride(levels, new Map()).overrideCommissionCenti).toBe(0);
  });

  it('"無限": a deep level earns exactly like a shallow one — no cap in the math', () => {
    const r = computeChainOverride([{ level: 25, rateBps: 10 }], new Map([[25, 10_000_000]]));
    expect(r.overrideCommissionCenti).toBe(10_000); // 0.1% of RM 100k = RM 100
  });

  it('rounds ONCE per level, on that level summed goods (money — mirrors 2990)', () => {
    // 3 bps of 3,333 centi = 0.9999 → 1. Rounding per-seller first (three
    // sellers of 1,111 each → round(0.3333) = 0 apiece) would pay 0 instead.
    // The rate hits the SUMMED base, exactly as showroom mode does.
    expect(computeChainOverride([{ level: 1, rateBps: 3 }], new Map([[1, 3_333]])).overrideCommissionCenti).toBe(1);
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
    personalGoodsCenti: number,
    goodsByLevel: Map<number, number>,
  ): ChainSalespersonInput => ({ staffId, tier, personalGoodsCenti, itemKpiCenti: 0, goodsByLevel });

  it('THE GUARD: two stacked managers each earn on the seller goods ONCE, at their own level', () => {
    // A (seller, RM 100k) → M1 → M2. M1 is 1 above A, M2 is 2 above.
    // This is the case 2990 gets WRONG: there, two managers of one showroom EACH
    // take the FULL showroom override, so the company pays one room twice at the
    // same rate. Here: different levels, different rates, once each.
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('A', 'sales', 10_000_000, new Map()),
      chain('M1', 'manager', 0, new Map([[1, 10_000_000]])),
      chain('M2', 'manager', 0, new Map([[2, 10_000_000]])),
    ]);
    const m1 = rows.find((r) => r.staffId === 'M1');
    const m2 = rows.find((r) => r.staffId === 'M2');
    expect(m1?.overrideCommissionCenti).toBe(50_000); // 0.5% of 100k = RM 500
    expect(m2?.overrideCommissionCenti).toBe(25_000); // 0.25% of 100k = RM 250
    // …and NOT 2990's answer, where both would take the identical full override.
    expect(m1?.overrideCommissionCenti).not.toBe(m2?.overrideCommissionCenti);
  });

  it('THE GUARD: the seller earns personal commission and NO override on their own sale', () => {
    // Distance 0 never enters goodsByLevel (rollUpChainGoods skips it), so an
    // own-sale override is unrepresentable rather than merely unlikely.
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('A', 'sales', 10_000_000, new Map()),
    ]);
    // RM 100k personal HITS the 100k gate → 1.5%, showroom RM 100k misses 400k.
    expect(rows[0]?.personalRateBps).toBe(150);
    expect(rows[0]?.personalCommissionCenti).toBe(150_000);
    expect(rows[0]?.overrideCommissionCenti).toBe(0);
  });

  it('a manager who also SELLS: personal on their own, override on the downline, never both on one sale', () => {
    // M sells RM 100k himself and has RM 200k under him at level 1.
    const rows = computeChainCommission(cfg, 30_000_000, levels, [
      chain('M', 'manager', 10_000_000, new Map([[1, 20_000_000]])),
    ]);
    expect(rows[0]?.personalRateBps).toBe(150); // 100k gate hit, 400k missed
    expect(rows[0]?.personalCommissionCenti).toBe(150_000);
    // 0.5% of the RM 200k DOWNLINE only — his own RM 100k is not in the base.
    expect(rows[0]?.overrideCommissionCenti).toBe(100_000);
    expect(rows[0]?.totalCenti).toBe(250_000);
  });

  it('tier is NOT consulted: a sales-tier person with a downline earns the override', () => {
    // Having reports is what earns, not a flag — the chain replaces tier for
    // override purposes. A 'manager' with nobody under them earns nothing.
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('S', 'sales', 0, new Map([[1, 10_000_000]])),
      chain('M', 'manager', 0, new Map()),
    ]);
    expect(rows.find((r) => r.staffId === 'S')?.overrideCommissionCenti).toBe(50_000);
    expect(rows.find((r) => r.staffId === 'M')?.overrideCommissionCenti).toBe(0);
  });

  it('reports overrideRateBps as NULL — there is no single rate in chain mode', () => {
    // 0 would claim a 0% override was earned, which is a different and false
    // statement. The truth lives in overrideDetail.
    const rows = computeChainCommission(cfg, 10_000_000, levels, [
      chain('M', 'manager', 0, new Map([[1, 10_000_000], [2, 20_000_000]])),
    ]);
    expect(rows[0]?.overrideRateBps).toBeNull();
    expect(rows[0]?.overrideDetail).toHaveLength(2);
  });

  it('personal commission is IDENTICAL to showroom mode — only the override changes', () => {
    // Both modes share personalPart, so the 100k/400k gates behave the same and
    // flipping the mode is a change to exactly ONE column.
    const person = { staffId: 'a', tier: 'sales' as const, personalGoodsCenti: 15_000_000, itemKpiCenti: 7_000 };
    const showroom = computeShowroomCommission(cfg, 50_000_000, [person]);
    const chained = computeChainCommission(cfg, 50_000_000, levels, [{ ...person, goodsByLevel: new Map() }]);
    expect(chained[0]?.personalRateBps).toBe(showroom[0]?.personalRateBps);
    expect(chained[0]?.personalCommissionCenti).toBe(showroom[0]?.personalCommissionCenti);
    expect(chained[0]?.itemKpiCenti).toBe(showroom[0]?.itemKpiCenti);
  });

  it('the item-KPI fixed bonus still lands in the total in chain mode', () => {
    const rows = computeChainCommission(cfg, 5_000_000, levels, [
      { ...chain('a', 'sales', 5_000_000, new Map([[1, 10_000_000]])), itemKpiCenti: 15_000 },
    ]);
    // 1.0% of 50k = RM 500, + 0.5% of 100k downline = RM 500, + RM 150 fixed
    expect(rows[0]?.totalCenti).toBe(50_000 + 50_000 + 15_000);
  });
});
