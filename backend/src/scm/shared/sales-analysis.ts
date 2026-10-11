// sales-analysis — pure aggregation core for the Sales Analysis page (Part B).
// Read-only: inputs are plain rows the API loads; outputs are display-ready
// aggregates. Money is integer centi throughout (UI converts to RM). Per the
// spec's cross-cutting rules: a "physical purchase" collapses cross-category
// follow-up SO chains into one; cancelled orders are filtered upstream.
//
// Vendored verbatim from 2990 packages/shared/src/sales-analysis.ts — imports
// re-pointed at the sibling vendored SCM shared modules (all present here).

import { ageFromBirthday, RACE_OPTIONS, GENDER_OPTIONS } from './customer-demographics';
import { pickComboMatch, buildComboLabel, type SofaComboRow, type SofaPriceTier } from './sofa-combo-pricing';
import { fabricTierAddon, type FabricTier, type FabricTierAddonConfig, type FabricTierModelOverride } from './fabric-tier-addon';
import { resolveFabricTierOverride } from './fabric-tier-override-resolve';

export interface SaOrderRow {
  docNo: string;
  /** cross_category_source_doc_no — the earlier SO this one follows up; null = standalone. */
  sourceDocNo: string | null;
  /** so_date as 'YYYY-MM-DD'. */
  soDate: string;
  /** total_revenue_centi — full order grand total incl. delivery/service. */
  totalRevenueCenti: number;
  /** total_margin_centi. */
  totalMarginCenti: number;
  /** service_centi — delivery+lift+dispose bucket; subtracted for product-only. */
  serviceCenti: number;
}

export interface OverviewResult {
  /** Sample size = non-cancelled orders in scope. */
  n: number;
  orderCount: { bySo: number; byPurchase: number };
  aovCenti: {
    perSo: { full: number; product: number };
    perPurchase: { full: number; product: number };
  };
  deliveryCenti: { avgAll: number; avgCharged: number; chargedCount: number };
  /** margin / revenue × 100; null when revenue is 0. */
  grossMarginPct: number | null;
}

export interface MonthlyRow {
  month: string; // 'YYYY-MM'
  orders: number;
  revenueCenti: number;
  marginCenti: number;
}

/** Union-find collapse of cross_category follow-up chains into physical
 *  purchases. Handles chains (C→B→A) and cycles (A↔B). A standalone SO is its
 *  own singleton. Groups (and docs within them) are sorted for deterministic
 *  output. A source not present in `orders` is ignored (the period window may
 *  have excluded the partner SO). */
export function collapseToPurchases(
  orders: ReadonlyArray<{ docNo: string; sourceDocNo: string | null }>,
): string[][] {
  const parent = new Map<string, string>();
  const ensure = (x: string): void => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a: string, b: string): void => {
    ensure(a); ensure(b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const known = new Set(orders.map((row) => row.docNo));
  for (const row of orders) {
    ensure(row.docNo);
    if (row.sourceDocNo && known.has(row.sourceDocNo)) union(row.docNo, row.sourceDocNo);
  }
  const groups = new Map<string, string[]>();
  for (const row of orders) {
    const r = find(row.docNo);
    const arr = groups.get(r);
    if (arr) arr.push(row.docNo); else groups.set(r, [row.docNo]);
  }
  return [...groups.values()].map((g) => [...g].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

const divRound = (num: number, den: number): number => (den > 0 ? Math.round(num / den) : 0);

export function summarizeOverview(
  orders: ReadonlyArray<SaOrderRow>,
  deliveryByDoc: ReadonlyMap<string, number>,
): OverviewResult {
  const n = orders.length;
  const purchaseCount = collapseToPurchases(orders).length;

  let sumRevenue = 0; let sumMargin = 0; let sumService = 0; let sumDelivery = 0; let chargedCount = 0;
  for (const ord of orders) {
    sumRevenue += ord.totalRevenueCenti;
    sumMargin += ord.totalMarginCenti;
    sumService += ord.serviceCenti;
    const d = deliveryByDoc.get(ord.docNo) ?? 0;
    sumDelivery += d;
    if (d > 0) chargedCount += 1;
  }
  const sumProduct = sumRevenue - sumService;

  return {
    n,
    orderCount: { bySo: n, byPurchase: purchaseCount },
    aovCenti: {
      perSo: { full: divRound(sumRevenue, n), product: divRound(sumProduct, n) },
      perPurchase: { full: divRound(sumRevenue, purchaseCount), product: divRound(sumProduct, purchaseCount) },
    },
    deliveryCenti: {
      avgAll: divRound(sumDelivery, n),
      avgCharged: divRound(sumDelivery, chargedCount),
      chargedCount,
    },
    grossMarginPct: sumRevenue > 0 ? (sumMargin / sumRevenue) * 100 : null,
  };
}

export function monthlyTrend(orders: ReadonlyArray<SaOrderRow>): MonthlyRow[] {
  const byMonth = new Map<string, MonthlyRow>();
  for (const ord of orders) {
    const month = ord.soDate.slice(0, 7);
    const row = byMonth.get(month) ?? { month, orders: 0, revenueCenti: 0, marginCenti: 0 };
    row.orders += 1;
    row.revenueCenti += ord.totalRevenueCenti;
    row.marginCenti += ord.totalMarginCenti;
    byMonth.set(month, row);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface SaCustomerRow {
  id: string;
  name: string;
  race: string | null;
  birthday: string | null;
  gender: string | null;
  state: string | null;
  city: string | null;
  orderCount: number;     // collapsed physical purchases in scope
  ltvCenti: number;       // sum of total_revenue_centi over scoped orders
  marginCenti: number;    // sum of total_margin_centi over scoped orders
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  isReturning: boolean;   // >1 physical purchase in scope
}

export interface DistributionBucket { key: string; count: number }

export interface CustomerDemographicsSummary {
  total: number;          // customers after the age filter
  withBirthday: number;   // of those, how many have a usable birthday
  perCustomer: Array<SaCustomerRow & { age: number | null }>;
  gender: DistributionBucket[];   // includes 'Unknown'
  race: DistributionBucket[];     // includes 'Unknown'
  byState: DistributionBucket[];  // includes 'Unknown'
  city: DistributionBucket[];     // includes 'Unknown'
  ageHistogram: Array<{ age: number; count: number }>; // per exact year, ascending
  avgAge: number | null;
  medianAge: number | null;
  newVsReturning: { newCount: number; returningCount: number };
}

export interface AgeFilter { ageMin?: number | null; ageMax?: number | null; asOf?: string }

const toBuckets = (m: Map<string, number>): DistributionBucket[] =>
  [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

/** Pure demographics aggregation for the Customer Data tab. Age is computed
 *  EXACTLY from birthday (no buckets). The age filter is inclusive on both
 *  bounds; when any bound is set, rows without a usable age are excluded.
 *  Null/blank race/gender/state count as 'Unknown'. */
export function summarizeCustomerDemographics(
  rows: ReadonlyArray<SaCustomerRow>,
  filter: AgeFilter = {},
): CustomerDemographicsSummary {
  const { ageMin, ageMax, asOf } = filter;
  const lo = ageMin ?? Number.NEGATIVE_INFINITY;
  const hi = ageMax ?? Number.POSITIVE_INFINITY;
  const bounded = ageMin != null || ageMax != null;

  const perCustomer = rows
    .map((r) => ({ ...r, age: ageFromBirthday(r.birthday, asOf) }))
    .filter((r) => (bounded ? r.age !== null && r.age >= lo && r.age <= hi : true));

  const bump = (m: Map<string, number>, k: string | null): void => {
    const key = k && k.trim() ? k : 'Unknown';
    m.set(key, (m.get(key) ?? 0) + 1);
  };
  const gender = new Map<string, number>();
  const race = new Map<string, number>();
  const state = new Map<string, number>();
  const city = new Map<string, number>();
  const ageCounts = new Map<number, number>();
  const ages: number[] = [];
  let withBirthday = 0; let newCount = 0; let returningCount = 0;

  for (const r of perCustomer) {
    bump(gender, r.gender);
    bump(race, r.race);
    bump(state, r.state);
    bump(city, r.city);
    if (r.age !== null) { withBirthday += 1; ages.push(r.age); ageCounts.set(r.age, (ageCounts.get(r.age) ?? 0) + 1); }
    if (r.isReturning) returningCount += 1; else newCount += 1;
  }

  const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
  const sortedAges = [...ages].sort((a, b) => a - b);
  const medianAge = sortedAges.length
    ? (sortedAges.length % 2
        ? sortedAges[(sortedAges.length - 1) / 2]!
        : (sortedAges[sortedAges.length / 2 - 1]! + sortedAges[sortedAges.length / 2]!) / 2)
    : null;

  return {
    total: perCustomer.length,
    withBirthday,
    perCustomer,
    gender: toBuckets(gender),
    race: toBuckets(race),
    byState: toBuckets(state),
    city: toBuckets(city),
    ageHistogram: [...ageCounts.entries()]
      .map(([age, count]) => ({ age, count }))
      .sort((a, b) => a.age - b.age),
    avgAge,
    medianAge,
    newVsReturning: { newCount, returningCount },
  };
}

export interface TargetProfile {
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  raceTargets: Record<string, number> | null;
  genderTargets: Record<string, number> | null;
  areaStates: string[];
  areaCities: string[];
}

export interface TargetMatchResult {
  overall: number | null;
  age: { configured: boolean; score: number; matched: number; total: number; min: number | null; max: number | null };
  race: { configured: boolean; score: number; rows: Array<{ key: string; target: number; actual: number }> };
  gender: { configured: boolean; score: number; rows: Array<{ key: string; target: number; actual: number }> };
  area: { configured: boolean; score: number; matched: number; total: number };
  biggestGap: { dim: 'age' | 'race' | 'gender' | 'area'; label: string } | null;
}

const normShares = (m: Record<string, number> | null): Record<string, number> => {
  if (!m) return {};
  const sum = Object.values(m).reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0);
  if (sum <= 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = (Number(v) > 0 ? Number(v) : 0) / sum * 100;
  return out;
};

const actualShares = (
  customers: ReadonlyArray<SaCustomerRow>, field: 'race' | 'gender', options: readonly string[],
): Record<string, number> => {
  let n = 0; const counts: Record<string, number> = {};
  for (const c of customers) {
    const v = c[field];
    if (v && (options as readonly string[]).includes(v)) { counts[v] = (counts[v] ?? 0) + 1; n += 1; }
  }
  const out: Record<string, number> = {};
  for (const k of options) out[k] = n > 0 ? ((counts[k] ?? 0) / n) * 100 : 0;
  return out;
};

const distScore = (
  customers: ReadonlyArray<SaCustomerRow>, field: 'race' | 'gender',
  options: readonly string[], targets: Record<string, number> | null,
): { configured: boolean; score: number; rows: Array<{ key: string; target: number; actual: number }> } => {
  const tgt = normShares(targets);
  const configured = Object.values(tgt).some((v) => v > 0);
  const act = actualShares(customers, field, options);
  let overlap = 0;
  const rows = options.map((k) => {
    const target = tgt[k] ?? 0; const actual = act[k] ?? 0;
    overlap += Math.min(target, actual);
    return { key: k, target, actual };
  });
  return { configured, score: configured ? overlap : 0, rows };
};

const eqCI = (a: string | null, set: string[]): boolean =>
  a != null && set.some((s) => s.trim().toLowerCase() === a.trim().toLowerCase());

/** Match the actual customer set against a target profile. Age uses period-all
 *  customers (caller passes the unfiltered set). Each dim contributes to the
 *  overall only when configured. */
export function computeTargetMatch(
  customers: ReadonlyArray<SaCustomerRow>,
  targets: TargetProfile,
  asOf?: string,
): TargetMatchResult {
  const total = customers.length;

  // Age dimension: % of customers whose exact age falls in the target range
  // [min, max] (both inclusive, either bound optional). Hit-rate like Area —
  // customers with no usable birthday count against (denominator = everyone).
  const ageConfigured = targets.ageRangeMin != null || targets.ageRangeMax != null;
  const ageLo = targets.ageRangeMin ?? Number.NEGATIVE_INFINITY;
  const ageHi = targets.ageRangeMax ?? Number.POSITIVE_INFINITY;
  const ageMatched = ageConfigured
    ? customers.filter((c) => {
        const a = ageFromBirthday(c.birthday, asOf);
        return a !== null && a >= ageLo && a <= ageHi;
      }).length
    : 0;
  const ageScore = ageConfigured && total > 0 ? (ageMatched / total) * 100 : 0;

  const race = distScore(customers, 'race', RACE_OPTIONS, targets.raceTargets);
  const gender = distScore(customers, 'gender', GENDER_OPTIONS, targets.genderTargets);

  const areaConfigured = targets.areaStates.length > 0 || targets.areaCities.length > 0;
  const matched = areaConfigured
    ? customers.filter((c) => eqCI(c.state, targets.areaStates) || eqCI(c.city, targets.areaCities)).length
    : 0;
  const areaScore = areaConfigured && total > 0 ? (matched / total) * 100 : 0;

  const dims: Array<{ dim: 'age' | 'race' | 'gender' | 'area'; configured: boolean; score: number; label: string }> = [
    { dim: 'age', configured: ageConfigured, score: ageScore, label: `Age ${targets.ageRangeMin ?? '0'}–${targets.ageRangeMax ?? '∞'}: ${Math.round(ageScore)}% in range` },
    { dim: 'race', configured: race.configured, score: race.score, label: 'Race mix' },
    { dim: 'gender', configured: gender.configured, score: gender.score, label: 'Gender mix' },
    { dim: 'area', configured: areaConfigured, score: areaScore, label: `Area ${Math.round(areaScore)}%` },
  ];
  const configuredDims = dims.filter((d) => d.configured);
  const overall = configuredDims.length ? configuredDims.reduce((a, d) => a + d.score, 0) / configuredDims.length : null;
  const gap = configuredDims.length ? configuredDims.reduce((lo, d) => (d.score < lo.score ? d : lo)) : null;

  return {
    overall,
    age: { configured: ageConfigured, score: ageScore, matched: ageMatched, total, min: targets.ageRangeMin, max: targets.ageRangeMax },
    race, gender,
    area: { configured: areaConfigured, score: areaScore, matched, total },
    biggestGap: gap ? { dim: gap.dim, label: gap.label } : null,
  };
}

export interface SpendBucket {
  key: string;
  customers: number;
  revenueCenti: number;
  purchases: number;
  aovCenti: number;        // revenueCenti / purchases
  marginCenti: number;
  marginPct: number | null; // marginCenti / revenueCenti × 100
}

/** Spend power per categorical segment. 'Unknown' for blank keys. Sorted by
 *  revenue desc. Operates on whatever customer set it is given. */
export function spendBySegment(
  customers: ReadonlyArray<SaCustomerRow>, dim: 'race' | 'gender' | 'city',
): SpendBucket[] {
  const m = new Map<string, { customers: number; revenueCenti: number; purchases: number; marginCenti: number }>();
  for (const c of customers) {
    const raw = c[dim];
    const key = raw && raw.trim() ? raw : 'Unknown';
    const b = m.get(key) ?? { customers: 0, revenueCenti: 0, purchases: 0, marginCenti: 0 };
    b.customers += 1;
    b.revenueCenti += c.ltvCenti;
    b.purchases += c.orderCount;
    b.marginCenti += c.marginCenti;
    m.set(key, b);
  }
  return [...m.entries()]
    .map(([key, b]) => ({
      key,
      customers: b.customers,
      revenueCenti: b.revenueCenti,
      purchases: b.purchases,
      aovCenti: b.purchases > 0 ? Math.round(b.revenueCenti / b.purchases) : 0,
      marginCenti: b.marginCenti,
      marginPct: b.revenueCenti > 0 ? (b.marginCenti / b.revenueCenti) * 100 : null,
    }))
    .sort((a, b) => b.revenueCenti - a.revenueCenti || a.key.localeCompare(b.key));
}

// ── Task 1: age bands + buyer demographics ──────────────────────────────────

export const AGE_BANDS = [
  { code: 'le25',   label: '≤25',   min: 0,   max: 25 },
  { code: '26_35',  label: '26–35', min: 26,  max: 35 },
  { code: '36_45',  label: '36–45', min: 36,  max: 45 },
  { code: '46_55',  label: '46–55', min: 46,  max: 55 },
  { code: '56plus', label: '56+',   min: 56,  max: 200 },
] as const;

export function ageBandLabel(age: number | null): string {
  if (age === null || !Number.isFinite(age)) return '';
  return AGE_BANDS.find((b) => age >= b.min && age <= b.max)?.label ?? '';
}

/** Public type alias (same shape as DistributionBucket). */
export interface Distribution { key: string; count: number }

export interface BuyerDemographics {
  n: number;
  race: Distribution[];
  ageBand: Distribution[];
  gender: Distribution[];
}

/** Buyer demographics for a set of product units. Race/gender → 'Unknown' for
 *  blanks; age bucketed via ageBandLabel (blank birthday → 'Unknown'). */
export function summarizeBuyerDemographics(
  units: ReadonlyArray<ProductUnit>, asOf?: string,
): BuyerDemographics {
  const race = new Map<string, number>();
  const ageBand = new Map<string, number>();
  const gender = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
  for (const u of units) {
    bump(race,   u.race   && u.race.trim()   ? u.race   : 'Unknown');
    bump(gender, u.gender && u.gender.trim() ? u.gender : 'Unknown');
    const lbl = ageBandLabel(ageFromBirthday(u.birthday, asOf));
    bump(ageBand, lbl || 'Unknown');
  }
  return {
    n: units.length,
    race: toBuckets(race),
    ageBand: toBuckets(ageBand),
    gender: toBuckets(gender),
  };
}

// ── Task 2: SaItemRow, ProductUnit, ProductCtx, foldProductUnits ──────────────

export interface SaItemRow {
  docNo: string; soDate: string;
  itemCode: string; itemGroup: string;
  qty: number; totalCenti: number; costCenti: number;
  buildKey: string | null; fabricId: string | null;
  legHeight: string | null; seatHeight: string | null;
  isPwp: boolean;   // variants.pwp === true (PWP reward line)
  // buyer (attached from the SO's customer)
  race: string | null; birthday: string | null; gender: string | null;
}

export interface ProductUnit {
  docNo: string; category: string; modelId: string | null; modelName: string;
  variantLabel: string;
  qty: number; revenueCenti: number; marginCenti: number;
  sofaClass: 'combo' | 'custom' | 'pwp' | null;
  comboLabel: string | null;
  fabricUpgrade: boolean | null;
  /** All line item_codes folded into this unit (a sofa build's module codes; non-sofa = [itemCode]). */
  itemCodes: string[];
  /** Fabric library id for the build (first non-null across lines); null when none. */
  fabricId: string | null;
  /** Seat height/depth for the build (first non-null across lines); null when none. */
  seatHeight: string | null;
  /** True if any line in the build is a PWP reward line. */
  isPwp: boolean;
  race: string | null; birthday: string | null; gender: string | null;
}

export interface ProductCtx {
  productByCode: ReadonlyMap<string, { category: string; modelId: string | null; sizeLabel: string | null; baseModel: string | null }>;
  modelById: ReadonlyMap<string, string>;
  buyerByDoc: ReadonlyMap<string, { race: string | null; birthday: string | null; gender: string | null }>;
}

/** Fold raw product lines into units. Sofa module lines sharing (docNo, buildKey)
 *  collapse to one unit (revenue/margin summed; qty from the lead, not multiplied
 *  by module count). Non-sofa lines map 1:1. variantLabel = size for
 *  mattress/bedframe; left as 'Custom' for sofa (overridden by the endpoint). */
export function foldProductUnits(rows: ReadonlyArray<SaItemRow>, ctx: ProductCtx): ProductUnit[] {
  const out: ProductUnit[] = [];
  const sofaGroups = new Map<string, SaItemRow[]>();
  for (const r of rows) {
    const p = ctx.productByCode.get(r.itemCode);
    const category = (p?.category ?? r.itemGroup ?? '').toUpperCase();
    const isSofa = category === 'SOFA';
    if (isSofa && r.buildKey) {
      const k = `${r.docNo}|${r.buildKey}`;
      const arr = sofaGroups.get(k);
      if (arr) arr.push(r); else sofaGroups.set(k, [r]);
      continue;
    }
    const buyer = ctx.buyerByDoc.get(r.docNo) ?? { race: null, birthday: null, gender: null };
    out.push({
      docNo: r.docNo, category, modelId: p?.modelId ?? null,
      modelName: (p?.modelId && ctx.modelById.get(p.modelId)) || p?.baseModel || r.itemCode,
      variantLabel: isSofa ? 'Custom' : (p?.sizeLabel ?? '—'),
      qty: r.qty, revenueCenti: r.totalCenti, marginCenti: r.totalCenti - r.costCenti,
      sofaClass: isSofa ? 'custom' : null, comboLabel: null, fabricUpgrade: null,
      itemCodes: [r.itemCode], fabricId: r.fabricId, seatHeight: r.seatHeight, isPwp: r.isPwp,
      race: buyer.race, birthday: buyer.birthday, gender: buyer.gender,
    });
  }
  for (const [, lines] of sofaGroups) {
    const lead = lines[0]!;
    const p = ctx.productByCode.get(lead.itemCode);
    const buyer = ctx.buyerByDoc.get(lead.docNo) ?? { race: null, birthday: null, gender: null };
    const revenueCenti = lines.reduce((s, l) => s + l.totalCenti, 0);
    const marginCenti  = lines.reduce((s, l) => s + (l.totalCenti - l.costCenti), 0);
    out.push({
      docNo: lead.docNo, category: 'SOFA', modelId: p?.modelId ?? null,
      modelName: (p?.modelId && ctx.modelById.get(p.modelId)) || p?.baseModel || lead.itemCode,
      variantLabel: 'Custom', qty: lead.qty, revenueCenti, marginCenti,
      sofaClass: 'custom', comboLabel: null, fabricUpgrade: null,
      itemCodes: lines.map((l) => l.itemCode),
      fabricId: lines.find((l) => l.fabricId)?.fabricId ?? null,
      seatHeight: lines.find((l) => l.seatHeight)?.seatHeight ?? null,
      isPwp: lines.some((l) => l.isPwp),
      race: buyer.race, birthday: buyer.birthday, gender: buyer.gender,
    });
  }
  return out;
}

// ── Task 3: classifySofaBuild + isFabricUpgrade ──────────────────────────────

export interface SofaClassifyInput {
  baseModel: string;
  /** Compartment codes from splitSofaCode(item_code).sizeCode, e.g. ['2A(LHF)','L(RHF)'] */
  moduleCodes: string[];
  /** Resolved selling tier (caller defaults PRICE_1). */
  tier: SofaPriceTier;
  /** Seat height/depth (caller defaults '24'). */
  height: string;
  /** SO date as 'YYYY-MM-DD' — used for combo effective-dating. */
  soDate: string;
  isPwp: boolean;
}

/**
 * Re-derive the SO recompute's combo decision for one folded sofa build.
 * Returns the string-union shape: sofaClass + comboLabel (null unless combo).
 *
 * WHY baseModel:'' + case-insensitive pre-filter:
 *   pickComboMatch treats empty baseModel as wildcard (skips its CASE-SENSITIVE
 *   inner check). Pre-filtering case-insensitively avoids missing matches when
 *   the unit's baseModel (from item_code) differs in case from the stored combo.
 */
export function classifySofaBuild(
  input: SofaClassifyInput,
  combos: readonly SofaComboRow[],
): { sofaClass: 'combo' | 'custom' | 'pwp'; comboLabel: string | null } {
  if (input.isPwp) return { sofaClass: 'pwp', comboLabel: null };
  const filtered = combos.filter((c) => c.baseModel.toUpperCase() === input.baseModel.toUpperCase());
  const match = pickComboMatch(
    { baseModel: '', modules: input.moduleCodes, customerId: null, tier: input.tier, height: input.height, asOf: input.soDate },
    filtered,
  );
  if (match) return { sofaClass: 'combo', comboLabel: match.row.label || buildComboLabel(match.row.modules) };
  return { sofaClass: 'custom', comboLabel: null };
}

export interface FabricUpgradeInput {
  category: 'SOFA' | 'BEDFRAME';
  /** The fabric's category-appropriate selling tier; null when unknown (→ not an upgrade). */
  tier: FabricTier | null;
  /** Sofa: module compartment codes; bedframe: []. */
  buildCompartments: string[];
  modelId: string | null;
}

/**
 * True when the build's fabric carries a positive tier Δ (after per-Model +
 * per-compartment overrides) — the same MAX-fold the SO billed at recompute.
 * A null tier (unknown fabric) → fabricTierAddon returns 0 → false.
 */
export function isFabricUpgrade(
  input: FabricUpgradeInput,
  config: FabricTierAddonConfig,
  modelOverrides: ReadonlyMap<string, FabricTierModelOverride>,
  compartmentOverrides: ReadonlyMap<string, FabricTierModelOverride>,
): boolean {
  const baseOverride = input.modelId ? (modelOverrides.get(input.modelId) ?? null) : null;
  // resolveFabricTierOverride only calls .get() — safe to cast ReadonlyMap → Map.
  const override = resolveFabricTierOverride(
    input.buildCompartments,
    baseOverride,
    compartmentOverrides as Map<string, FabricTierModelOverride>,
  );
  return fabricTierAddon(input.category, input.tier, config, override) > 0;
}

// ── Task 4: VariantRank, ModelRank, ProductsSection, buildProductsSection ────

export interface VariantRank {
  label: string;
  units: number;
  revenueCenti: number;
  demographics: BuyerDemographics;
}

export interface ModelRank {
  modelId: string | null;
  modelName: string;
  category: string;
  units: number;
  revenueCenti: number;
  marginCenti: number;
  variants: VariantRank[];
  demographics: BuyerDemographics;
  comboUnits: number;
  customUnits: number;
  pwpUnits: number;
  fabricUpgradeUnits: number;
  fabricEligibleUnits: number;
}

export interface ProductsSection {
  byCategory: Record<string, ModelRank[]>;
}

/** Aggregate folded product units into a ranked, per-category products section.
 *
 *  Grouping key for a model = modelId when non-null, else '|name:' + modelName
 *  (keeps null-id models apart from real ids, groups name-synonyms together).
 *
 *  Ranking: models sorted by Σqty desc, tie revenueCenti desc.
 *  Variants: sorted by Σqty desc, tie label asc.
 *
 *  CRITICAL: all tallies (units / comboUnits / fabricEligibleUnits / …) are
 *  Σqty — NOT .length — because one ProductUnit object can carry qty > 1.
 *  Conversely, demographics counts unit OBJECTS (one buyer per line, regardless
 *  of qty) — pass the unit array as-is to summarizeBuyerDemographics. */
export function buildProductsSection(
  units: ReadonlyArray<ProductUnit>,
  asOf?: string,
): ProductsSection {
  if (units.length === 0) return { byCategory: {} };

  // Phase 1 — group by category → model key → ProductUnit[]
  const byCat = new Map<string, Map<string, ProductUnit[]>>();
  for (const u of units) {
    let catMap = byCat.get(u.category);
    if (!catMap) { catMap = new Map(); byCat.set(u.category, catMap); }
    const modelKey = u.modelId != null ? u.modelId : `|name:${u.modelName}`;
    const arr = catMap.get(modelKey);
    if (arr) arr.push(u); else catMap.set(modelKey, [u]);
  }

  // Phase 2 — build ModelRank[] for each category
  const byCategory: Record<string, ModelRank[]> = {};
  for (const [category, modelMap] of byCat) {
    const models: ModelRank[] = [];

    for (const [, modelUnits] of modelMap) {
      const lead = modelUnits[0]!;

      // Aggregate totals (all Σqty)
      let totalUnits = 0;
      let totalRevenue = 0;
      let totalMargin = 0;
      let comboUnits = 0;
      let customUnits = 0;
      let pwpUnits = 0;
      let fabricUpgradeUnits = 0;
      let fabricEligibleUnits = 0;

      for (const u of modelUnits) {
        totalUnits += u.qty;
        totalRevenue += u.revenueCenti;
        totalMargin += u.marginCenti;
        if (u.sofaClass === 'combo')   comboUnits  += u.qty;
        if (u.sofaClass === 'custom')  customUnits += u.qty;
        if (u.sofaClass === 'pwp')     pwpUnits    += u.qty;
        if (u.fabricUpgrade !== null)  fabricEligibleUnits += u.qty;
        if (u.fabricUpgrade === true)  fabricUpgradeUnits  += u.qty;
      }

      // Variants — group by variantLabel, Σqty / Σrevenue, demographics by object count
      const variantMap = new Map<string, ProductUnit[]>();
      for (const u of modelUnits) {
        const arr = variantMap.get(u.variantLabel);
        if (arr) arr.push(u); else variantMap.set(u.variantLabel, [u]);
      }
      const variants: VariantRank[] = [...variantMap.entries()]
        .map(([label, varUnits]) => ({
          label,
          units: varUnits.reduce((s, u) => s + u.qty, 0),
          revenueCenti: varUnits.reduce((s, u) => s + u.revenueCenti, 0),
          demographics: summarizeBuyerDemographics(varUnits, asOf),
        }))
        .sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));

      models.push({
        modelId: lead.modelId,
        modelName: lead.modelName,
        category,
        units: totalUnits,
        revenueCenti: totalRevenue,
        marginCenti: totalMargin,
        variants,
        demographics: summarizeBuyerDemographics(modelUnits, asOf),
        comboUnits,
        customUnits,
        pwpUnits,
        fabricUpgradeUnits,
        fabricEligibleUnits,
      });
    }

    // Sort models: units desc, tie revenueCenti desc
    models.sort((a, b) => b.units - a.units || b.revenueCenti - a.revenueCenti);
    byCategory[category] = models;
  }

  return { byCategory };
}
