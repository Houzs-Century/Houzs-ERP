// Pure commission math for the HR module. No I/O, no DB, no React — safe to
// run on the CF Workers API (authoritative) and reuse client-side for preview.
// Money in centi (sen, integer); rates in bps (integer, 100 bps = 1%).

export type HrTier = 'sales' | 'manager';

/**
 * Identifies the ARITHMETIC that produced a payout, stamped onto every closed
 * period (scm.hr_payout_periods.engine_version).
 *
 * BUMP THIS WHENEVER THE MATH IN THIS FILE CHANGES — including a "harmless"
 * rounding tidy-up, which is not harmless: it is a payout change. A closed
 * period is SERVED from its frozen rows and is never re-run, so a bump cannot
 * move an already-approved figure. What the stamp buys is the ability to answer
 * "was this period computed by the engine that has the fabric-Δ fix in it, or
 * the one before it" without guessing from dates.
 *
 * v1 = the 2990-parity engine (flat showroom override) + the 2026-07-17 owner
 * rulings: DRAFT excluded from goods, and the chain override mode.
 * v2 = adds the `category` item-KPI flag type and its precedence rule (a product
 * rule beats a category rule on the same unit — see categorySuppressed). A v1
 * period contains no category rules at all, so replaying one under v2 yields the
 * identical figure; the bump records WHICH engine produced it, not a repricing.
 */
export const COMMISSION_ENGINE_VERSION = 'v2';

/**
 * SO statuses that earn NO commission (owner 2026-07-17: "draft肯定不算").
 *
 * Lives HERE, with the math, rather than in routes/hr.ts: which sales count is a
 * commission RULE, not an I/O detail, and a rule in a route file is a rule no
 * test can reach. This ONE list drives both the PostgREST filter and
 * soEarnsCommission below, so the query and the rule cannot drift apart.
 *
 * 2990 excluded only CANCELLED + ON_HOLD out of the 10 statuses
 * (mfg-sales-orders.ts SO_STATUSES), which left DRAFT — rank 0, the state every
 * SO is born in — paying full commission.
 */
export const COMMISSION_EXCLUDED_STATUSES = ['CANCELLED', 'ON_HOLD', 'DRAFT'] as const;

/** Does an SO in this status earn commission? Unknown statuses EARN — matching
 *  the PostgREST `not in` filter exactly (it excludes a listed status, it does
 *  not require a known one) and matching soStatusTransitionError's "status-blind
 *  → allow" rule. A new status must be considered here deliberately. */
export const soEarnsCommission = (status: string | null | undefined): boolean =>
  !(COMMISSION_EXCLUDED_STATUSES as readonly string[]).includes(String(status ?? '').toUpperCase());

export interface CommissionConfig {
  baseBps: number;
  personalKpiThresholdCenti: number;
  personalKpiBonusBps: number;
  showroomKpiThresholdCenti: number;
  showroomKpiBonusBps: number;
  overrideBaseBps: number;
  overrideKpiBonusBps: number;
}

export interface SalespersonInput {
  staffId: string;
  tier: HrTier;
  personalGoodsCenti: number;
  itemKpiCenti: number;
}

/** One level's contribution to a chain-mode override (chain mode only). */
export interface OverrideLevelDetail {
  /** Distance UP the reporting chain: 1 = this earner's direct reports. */
  level: number;
  rateBps: number;
  /** Σ KPI-excluded goods of the earner's downline sellers at exactly this level. */
  goodsCenti: number;
  commissionCenti: number;
}

export interface CommissionRow {
  staffId: string;
  tier: HrTier;
  personalGoodsCenti: number;
  personalRateBps: number;
  personalCommissionCenti: number;
  /* One flat rate on one base in showroom mode. NULL in chain mode, where the
     override is Σ over levels of DIFFERENT rates on DIFFERENT bases — there is
     no single rate, and reporting a blended one would be a rounding-lossy figure
     nobody can reconcile against a payslip. Read overrideDetail instead. */
  overrideRateBps: number | null;
  overrideCommissionCenti: number;
  /** Per-level breakdown; chain mode only (undefined in showroom mode). */
  overrideDetail?: OverrideLevelDetail[];
  itemKpiCenti: number;
  totalCenti: number;
}

const applyBps = (centi: number, bps: number): number => Math.round((centi * bps) / 10_000);

/* The PERSONAL half of a row — identical in both override modes, so both entry
   points below call this rather than each carrying a copy of the rate ladder.
   A second copy is how the two modes would silently drift apart on the next
   rate change. */
const personalPart = (
  config: CommissionConfig,
  showroomKpiHit: boolean,
  p: SalespersonInput,
): { personalRateBps: number; personalCommissionCenti: number } => {
  const personalKpiHit = p.personalGoodsCenti >= config.personalKpiThresholdCenti;
  const personalRateBps =
    config.baseBps +
    (personalKpiHit ? config.personalKpiBonusBps : 0) +
    (showroomKpiHit ? config.showroomKpiBonusBps : 0);
  return { personalRateBps, personalCommissionCenti: applyBps(p.personalGoodsCenti, personalRateBps) };
};

/**
 * SHOWROOM mode (2990's model, unchanged). Compute commission for every
 * salesperson in one showroom. `showroomGoodsCenti` is the WHOLE showroom's
 * goods value (used for both the 400k threshold and the manager override base —
 * managers override the entire showroom, including their own sales).
 *
 * Known limitation, inherited verbatim from 2990 and deliberately NOT fixed
 * here: TWO managers in one showroom EACH earn the full override on the whole
 * showroom, so that showroom's override is paid twice. Chain mode below does not
 * reproduce it. Changing it here would move live 2990-parity payouts.
 */
export const computeShowroomCommission = (
  config: CommissionConfig,
  showroomGoodsCenti: number,
  salespeople: SalespersonInput[],
): CommissionRow[] => {
  const showroomKpiHit = showroomGoodsCenti >= config.showroomKpiThresholdCenti;
  return salespeople.map((p) => {
    const { personalRateBps, personalCommissionCenti } = personalPart(config, showroomKpiHit, p);

    const isManager = p.tier === 'manager';
    const overrideRateBps = isManager
      ? config.overrideBaseBps + (showroomKpiHit ? config.overrideKpiBonusBps : 0)
      : 0;
    const overrideCommissionCenti = isManager ? applyBps(showroomGoodsCenti, overrideRateBps) : 0;

    return {
      staffId: p.staffId,
      tier: p.tier,
      personalGoodsCenti: p.personalGoodsCenti,
      personalRateBps,
      personalCommissionCenti,
      overrideRateBps,
      overrideCommissionCenti,
      itemKpiCenti: p.itemKpiCenti,
      totalCenti: personalCommissionCenti + overrideCommissionCenti + p.itemKpiCenti,
    };
  });
};

// ── chain override (owner 2026-07-17: "無限 讓我們自己add 按SO算") ─────────────
// A reporting-line override that REPLACES the flat-showroom one. Never both:
// running the two together would pay a manager the showroom override AND the
// chain override on overlapping goods, which is the double-pay this model exists
// to end. routes/hr.ts dispatches on config.overrideMode; the modes are mutually
// exclusive by construction.
//
// "無限" (unlimited depth): depth is bounded by the LEVELS THE OWNER CONFIGURES,
// not by a constant in this file. Nothing here caps it.
// "讓我們自己add": one editable rate per level. Level 1 = a person's DIRECT
// reports, level 2 = their reports' reports, and so on.
// "按SO算": the goods are SO-derived (mfg_sales_orders bounded on so_date) —
// exactly the same source showroom mode reads. This file never sees a delivery
// or an invoice.
//
// THE DOUBLE-PAY GUARD, stated precisely: an earner's own sales are at distance
// 0 and NEVER appear in goodsByLevel (routes/hr.ts skips d=0), so nobody earns an
// override on a sale they already earn personal commission on. Every downline
// seller sits at exactly ONE distance from a given earner, so each SO's goods
// enter that earner's base exactly once. A manager ABOVE another manager earns at
// their own (deeper) level on the same goods — that is the pyramid the owner
// asked for, not double-pay: two DIFFERENT people, two DIFFERENT rates, each
// once. Contrast showroom mode, where two managers in one room each take the
// whole room.

/** One configured level of the chain override. `level` is 1-based (1 = direct reports). */
export interface OverrideLevel {
  level: number;
  rateBps: number;
}

/**
 * The chain override earned by ONE person: Σ over configured levels of
 * (that level's downline goods × that level's rate).
 *
 * ROUNDING (this is money — read before changing): the rate is applied ONCE per
 * level, to that level's SUMMED goods, mirroring showroom mode's single
 * applyBps(showroomGoodsCenti, rate) on a summed base. Rounding per-seller and
 * then summing would produce a different ringgit figure.
 *
 * A level present in `goodsByLevel` but ABSENT from `levels` earns nothing. That
 * is the "讓我們自己add" rule, not a missing-data guess: the owner's configured
 * rows ARE the definition of who earns, so an unconfigured level is a deliberate
 * "this level is not on the scheme", identical in meaning to a 0 rate. The
 * distinct case — chain mode with NO levels configured at all, which would zero
 * every override in the company — is refused upstream in routes/hr.ts rather
 * than silently paid as 0.
 */
export const computeChainOverride = (
  levels: OverrideLevel[],
  goodsByLevel: ReadonlyMap<number, number>,
): { overrideCommissionCenti: number; overrideDetail: OverrideLevelDetail[] } => {
  const overrideDetail: OverrideLevelDetail[] = [];
  let overrideCommissionCenti = 0;
  // Configured order is irrelevant to the total; sort so the detail (and the
  // frozen snapshot built from it) is byte-stable run to run.
  for (const l of [...levels].sort((a, b) => a.level - b.level)) {
    const goodsCenti = goodsByLevel.get(l.level);
    if (goodsCenti === undefined || goodsCenti <= 0) continue;
    const commissionCenti = applyBps(goodsCenti, l.rateBps);
    overrideDetail.push({ level: l.level, rateBps: l.rateBps, goodsCenti, commissionCenti });
    overrideCommissionCenti += commissionCenti;
  }
  return { overrideCommissionCenti, overrideDetail };
};

/** A salesperson plus the downline goods that roll up to them, by level. */
export interface ChainSalespersonInput extends SalespersonInput {
  /** level (>=1) → Σ KPI-excluded goods of THIS person's downline at that level. */
  goodsByLevel: ReadonlyMap<number, number>;
}

/**
 * CHAIN mode. Personal commission is computed EXACTLY as showroom mode (same
 * personalPart, same 100k/400k gates on the same showroom base) — only the
 * override changes. `tier` is NOT consulted: earning an override is decided by
 * having a downline, not by a flag. A 'sales'-tier person with reports earns;
 * a 'manager' with none does not.
 */
export const computeChainCommission = (
  config: CommissionConfig,
  showroomGoodsCenti: number,
  levels: OverrideLevel[],
  salespeople: ChainSalespersonInput[],
): CommissionRow[] => {
  const showroomKpiHit = showroomGoodsCenti >= config.showroomKpiThresholdCenti;
  return salespeople.map((p) => {
    const { personalRateBps, personalCommissionCenti } = personalPart(config, showroomKpiHit, p);
    const { overrideCommissionCenti, overrideDetail } = computeChainOverride(levels, p.goodsByLevel);
    return {
      staffId: p.staffId,
      tier: p.tier,
      personalGoodsCenti: p.personalGoodsCenti,
      personalRateBps,
      personalCommissionCenti,
      overrideRateBps: null, // no single rate in chain mode — see overrideDetail
      overrideCommissionCenti,
      overrideDetail,
      itemKpiCenti: p.itemKpiCenti,
      totalCenti: personalCommissionCenti + overrideCommissionCenti + p.itemKpiCenti,
    };
  });
};

/**
 * What an item-KPI rule targets.
 *
 * Every type EXCEPT `category` names exactly ONE purchasable thing (owner
 * 2026-07-18: commission "是看 by item" — a rule is read per item). `category` is
 * the deliberate exception: it targets EVERY item in a product category with one
 * rule, which is why it needs the precedence rule in unitKpiCenti below.
 *   · product  → mfg_products.code           (the SKU itself)
 *   · category → mfg_products.category       (the mfg_product_category enum,
 *                                             UPPERCASE: SOFA / BEDFRAME / ...)
 *   · fabric   → fabric_library.id           (the fabric SERIES, e.g. 'BF' —
 *                                             already series-level, never colour)
 *   · special  → the special-order code on the line
 */
export type HrFlagType = 'product' | 'category' | 'fabric' | 'special';

export interface ItemKpiFlag {
  flagType: HrFlagType;
  ref: string;
  bonusCenti: number;
}

export interface KpiLine {
  itemCode: string;
  qty: number;
  fabricId: string | null;
  specialCodes: string[];
}

/** Bonus earned by one order line against the active flags (qty × amount, summed). */
export const lineKpiCenti = (line: KpiLine, flags: ItemKpiFlag[]): number => {
  let total = 0;
  for (const f of flags) {
    const matched =
      (f.flagType === 'product' && line.itemCode === f.ref) ||
      (f.flagType === 'fabric' && line.fabricId === f.ref) ||
      (f.flagType === 'special' && line.specialCodes.includes(f.ref));
    if (matched) total += line.qty * f.bonusCenti;
  }
  return total;
};

// ── item-KPI as a goods EXCLUSION (Loo 2026-06-20) ───────────────────────────
// An item-KPI-flagged purchase earns a FIXED bonus (e.g. RM 50) INSTEAD of the
// percentage commission on the flagged portion — never both ("no double
// commission"). So the flagged amount is removed from the goods that drive BOTH
// the % commission AND the 100k / 400k thresholds.
//
// The flagged thing is one purchased item — a "unit". A POS sofa build is stored
// as several per-module SO lines (so-sofa-split) that all carry the SAME fabric,
// and its fabric-tier Δ is one flat figure spread across those lines. So module
// lines of one build collapse back into ONE unit: the bonus and the exclusion
// each count ONCE per built item, not once per module. Every non-sofa line is a
// unit of one.
//
// What gets excluded, per flag type (Loo's worked example: a sofa whose base is
// RM 3,000 with a RM 125 fabric-tier add-on, fabric flagged at RM 50 → goods
// stays RM 3,000, salesperson earns the fixed RM 50, the RM 125 is dropped):
//   · fabric  → the fabric-tier add-on Δ (qty × per-item Δ) — the base price stays goods
//   · special → the special-order surcharge (qty × per-item)
//   · product → the whole unit total (the product itself IS the KPI item)
// Capped at the unit total so a unit's goods can never go negative.

export interface KpiUnit {
  /** Every SKU code in the unit — a split sofa carries one per module. */
  itemCodes: string[];
  /** Items purchased (a build's qty; uniform across its module lines). */
  qty: number;
  /** The unit's product category, UPPERCASE mfg_product_category ('SOFA',
   *  'BEDFRAME', ...). NULL when it could not be resolved — a category flag then
   *  simply does not fire, rather than guessing a category and paying a bonus
   *  nobody configured for this item. */
  category: string | null;
  fabricId: string | null;
  specialCodes: string[];
  /** Σ of the unit's line totals (goods, qty-inclusive, post-discount), centi. */
  lineTotalCenti: number;
  /** Per-ITEM fabric-tier add-on Δ charged on this unit (centi); 0 when none. */
  fabricAddonUnitCenti: number;
  /** Per-ITEM special-order surcharge on this unit (centi); 0 when none. */
  specialSurchargeUnitCenti: number;
}

const flagMatchesUnit = (
  f: ItemKpiFlag,
  u: Pick<KpiUnit, 'itemCodes' | 'category' | 'fabricId' | 'specialCodes'>,
): boolean =>
  (f.flagType === 'product' && u.itemCodes.includes(f.ref)) ||
  // NULL category never matches — see KpiUnit.category.
  (f.flagType === 'category' && u.category !== null && u.category === f.ref) ||
  (f.flagType === 'fabric' && u.fabricId === f.ref) ||
  (f.flagType === 'special' && u.specialCodes.includes(f.ref));

/**
 * PRECEDENCE: a product rule BEATS a category rule on the same unit.
 *
 * This is a money decision, so it is stated once, here, and both the bonus and
 * the goods-exclusion below obey it. Without it a sofa that is BOTH flagged by
 * SKU and covered by a "every SOFA" rule would collect BOTH bonuses off one
 * purchase — the exact double-pay the item-KPI model exists to prevent (Loo
 * 2026-06-20: "no double commission"), and it would do it silently.
 *
 * Product wins because it is the more SPECIFIC statement of intent: naming one
 * SKU is a deliberate override of the blanket category rate, in the same way a
 * per-model fabric override beats the config default. The category rule is the
 * fallback for everything in the category the owner did NOT name individually.
 *
 * Only product-vs-category needs a rule. Every other pair targets a different
 * DIMENSION of the same purchase (the SKU, its fabric series, its special-order
 * surcharge) and those deliberately stack, exactly as they did before this file
 * knew what a category was — see unitKpiExcludedCenti, where each type removes
 * its own slice of goods and nothing overlaps.
 */
const categorySuppressed = (u: Pick<KpiUnit, 'itemCodes'>, flags: ItemKpiFlag[]): boolean =>
  flags.some((f) => f.flagType === 'product' && u.itemCodes.includes(f.ref));

/** The flags that actually FIRE on this unit, after precedence. The one list
 *  every payout figure below is derived from, so the bonus, the goods exclusion
 *  and the on-screen breakdown can never disagree about which rules applied. */
export const firingFlags = (
  u: Pick<KpiUnit, 'itemCodes' | 'category' | 'fabricId' | 'specialCodes'>,
  flags: ItemKpiFlag[],
): ItemKpiFlag[] => {
  const suppressed = categorySuppressed(u, flags);
  return flags.filter((f) => flagMatchesUnit(f, u) && !(suppressed && f.flagType === 'category'));
};

/** Does any active flag fire on this unit? (drives the kpiDetail breakdown.) */
export const unitMatchesAnyKpi = (u: KpiUnit, flags: ItemKpiFlag[]): boolean =>
  firingFlags(u, flags).length > 0;

/** Whether one flag fires on this unit — exported so the API's per-flag detail
 *  rollup matches this single source of truth instead of re-deriving the test.
 *  Takes the WHOLE flag list because firing is not a property of one flag alone:
 *  a category flag is suppressed by the presence of a product flag on the same
 *  unit. Callers that pass only the one flag would miss that and report a
 *  breakdown line for a rule that paid nothing. */
export const kpiFlagFiresOnUnit = (
  f: ItemKpiFlag,
  u: Pick<KpiUnit, 'itemCodes' | 'category' | 'fabricId' | 'specialCodes'>,
  flags: ItemKpiFlag[],
): boolean => firingFlags(u, flags).some((x) => x.flagType === f.flagType && x.ref === f.ref);

/** Fixed item-KPI bonus earned by one unit (qty × amount, summed over the flags
 *  that FIRE — so a category rule suppressed by a product rule pays nothing). */
export const unitKpiCenti = (u: KpiUnit, flags: ItemKpiFlag[]): number => {
  let total = 0;
  for (const f of firingFlags(u, flags)) total += u.qty * f.bonusCenti;
  return total;
};

/** Goods centi to EXCLUDE from this unit because it earns the fixed item-KPI
 *  bonus instead of percentage commission. A product flag drops the whole unit;
 *  fabric / special flags drop only their add-on. Capped at the unit total. */
export const unitKpiExcludedCenti = (u: KpiUnit, flags: ItemKpiFlag[]): number => {
  let excluded = 0;
  let wholeUnit = false;
  for (const f of firingFlags(u, flags)) {
    // `category` excludes the WHOLE unit exactly as `product` does: both target
    // the purchased item itself, so the item earns its fixed bonus INSTEAD of
    // percentage commission. (fabric / special only ever target an add-on ON the
    // item, so they remove only that add-on.) Precedence already guaranteed at
    // most one of product/category is in this list, so this cannot double-count.
    if (f.flagType === 'product' || f.flagType === 'category') wholeUnit = true;
    else if (f.flagType === 'fabric') excluded += u.qty * u.fabricAddonUnitCenti;
    else if (f.flagType === 'special') excluded += u.qty * u.specialSurchargeUnitCenti;
  }
  if (wholeUnit) return Math.max(0, u.lineTotalCenti);
  return Math.min(Math.max(0, excluded), Math.max(0, u.lineTotalCenti));
};
