
import {
  computeMfgLinePrice,
  computeMfgLineCost,
  buildSpecialsPoolFromAddons,
  type MaintenanceConfig,
  type MfgPricingProduct,
  type MfgPricingFabric,
  type MfgPricingBreakdown,
  type MfgFabricTier,
  type MfgSeatHeightPrice,
  type SpecialAddonCompartmentPriceDef,
  type SpecialAddonDef,
} from '../shared/mfg-pricing';
import { compareSpecialLabels } from '../shared/variant-summary';
import { chunkIn } from './paginate-all';
import { pgrestInList } from './pgrest-in-list';
import { autoDeriveEnabled } from './auto-derive-cost';
import { resolveMfgProductCostAsOf } from './supplier-price-history';
import { todayMyt } from './my-time';
import { scopeToCompanyIdOrOpen } from './companyScope';
import {
  computeSofaSellingResult,
  comboChargedPrices,
  sofaModulePricesFromSkus,
  sofaModuleSellingPricesFromSkus,
  sofaModuleCostPricesFromSkus,
  normalizeCompartmentCode,
  type Cell,
  type SofaComboRow,
  type SofaModulePriceSen,
} from '../shared/sofa-build';
import {
  fabricTierAddon,
  type FabricTier,
  type FabricTierAddonConfig,
  type FabricTierModelOverride,
} from '../shared/fabric-tier-addon';
import { resolveFabricTierOverride } from '../shared/fabric-tier-override-resolve';
import { type PwpRule } from '../shared/pwp';
import type { SofaPricedAccessory } from '../shared/sofa-combo-pricing';
import { parseDefaultFreeGifts, type DefaultFreeGift, type FreeItemCampaign, parseFreeItemEligible } from '../shared';

export type MfgItemVariants = {
  fabricCode?:    string | null;
  fabricId?:      string | null;
  divanHeight?:   string | null;
  legHeight?:     string | null;
  totalHeight?:   string | null;
  gap?:           string | null;
  seatHeight?:    string | null;
  depth?:         string | number | null;
  sofaLegHeight?: string | null;
  specials?:      string[] | string | null;
  special?:       string[] | string | null;
  specialChoices?: Record<string, string[]> | null;
  /** PWP (换购, migration 0128) — the salesperson toggled "use PWP price" on this
   *  reward line. The route's order-level resolvePwp validates it; only a granted
   *  line actually gets the PWP base. */
  pwp?:           boolean | null;
  remark?:        string | null;
  extraAddonNote?: string | null;
  extraAddonAmountRM?: number | null;
};

export type MfgItemForRecompute = {
  itemCode:       string;
  itemGroup:      string;
  qty:            number;
  unitPriceSen: number;
  variants?:      MfgItemVariants | null;
  buildCompartments?: string[];
  sofaAccessories?: SofaPricedAccessory[];
};

export type RecomputedLine = {
  sofaComboMatchedAccessoryIds?: string[];
  sofaComboIds?: string[];
  itemCode:     string;
  unit_price_sen:       number;
  divan_price_sen:      number;
  leg_price_sen:        number;
  special_order_sen:    number;
  custom_specials:      Array<{ description: string; surchargeSen: number }> | null;
  total_sen:          number;
  breakdown:            MfgPricingBreakdown;
  unit_cost_sen:        number;
  line_cost_sen:        number;
  costBreakdown:        MfgPricingBreakdown;
  sofa_module_costs_sen: Record<string, number> | null;
  drift:                boolean;
};

export type FabricRowLite = {
  fabric_code:         string;
  sofa_price_tier:     MfgFabricTier | null;
  bedframe_price_tier: MfgFabricTier | null;
  price_tier:          MfgFabricTier | null;
};

export type ProductRowLite = {
  code:               string;
  category:           string;
  base_price_sen:     number | null;
  price1_sen:         number | null;
  cost_price_sen:     number | null;
  seat_height_prices: MfgSeatHeightPrice[] | null;
  base_model:         string | null;
  sell_price_sen:     number | null;
  /** PWP (换购) selling base price (migration 0128). When the order-level PWP
   *  resolution grants this line (passed in as `pwpBaseSen`), its selling base
   *  is this instead of sell_price_sen — fabric Δ still stacks on top. Optional:
   *  the loader always selects it; legacy/test snapshots may omit it. */
  pwp_price_sen?:     number | null;
  model_id?:          string | null;
  size_code?:         string | null;
  branding?:          string | null;
  default_free_gifts?: unknown;
};

/** One sofa module SKU's cost-relevant columns (audit 2026-06-11 C2). The
 *  build-cost path resolves each module's cost from these the same way
 *  `computeMfgLineCost` does (seat-height priceSen at the build's seat size +
 *  fabric tier, else P1 flat, else base/cost price). */
export type SofaModuleCostRowLite = {
  code:               string;
  base_price_sen:     number | null;
  price1_sen:         number | null;
  cost_price_sen:     number | null;
  seat_height_prices: MfgSeatHeightPrice[] | null;
};

const toMfgCategory = (group: string, productCategory: string): MfgPricingProduct['category'] => {
  const c = (productCategory || group || '').toUpperCase();
  if (c.includes('BEDFRAME')) return 'BEDFRAME';
  if (c.includes('SOFA'))     return 'SOFA';
  if (c.includes('MATTRESS')) return 'MATTRESS';
  if (c.includes('ACCESSOR')) return 'ACCESSORY';
  if (c.includes('SERVICE'))  return 'SERVICE';
  return 'ACCESSORY';
};

const normalizeSpecials = (s: string[] | string | null | undefined): string[] => {
  if (!s) return [];
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return [String(s).trim()].filter(Boolean);
};

const driftThresholdExceeded = (clientSen: number, serverSen: number): boolean => {
  if (clientSen === 0 && serverSen > 0) return false;
  if (serverSen <= 0) return clientSen !== 0;
  const drift = Math.abs(clientSen - serverSen) / serverSen;
  return drift > 0.005;
};

/**
 * How much of the caller's selling price to believe.
 *
 *   false            the authoritative default — a catalog line is re-priced to
 *                    mfg_products.sell_price_sen (+ fabric delta + extras).
 *   true             owner ruling 2026-05-31: a trusted non-POS author's
 *                    hand-entered price wins, but only when they entered one.
 *                    0 still means "not provided" and takes the catalogue fill.
 *   'including-zero' additionally believes a stored 0.
 *   'operator-zero'  believes a 0 the OPERATOR typed on THIS request.
 *
 * 'including-zero' exists for MIGRATED documents (linked_ac_docno IS NOT NULL)
 * and nothing else. Their prices came from AutoCount, where a sofa set is
 * routinely carried as the whole-set price on ONE lead module line with 0 on its
 * siblings. Under `true` those 0 siblings would each be handed a catalogue price
 * on the next approved amendment and the customer would be billed for the set
 * several times over; under 'including-zero' the AutoCount shape survives.
 *
 * Do NOT reach for 'including-zero' on a line the operator is authoring now —
 * there a 0 really does mean the client could not resolve a price, and the
 * catalogue fill is the correct answer. That instruction stands unchanged: the
 * exception below is a DIFFERENT mode, so the migrated rationale is not diluted
 * and `isMigratedTrust` keeps meaning exactly "migrated".
 *
 * 'operator-zero' is the sanctioned exception to the paragraph above, added
 * 2026-08-18 on the owner's requirement that a salesperson be able to set an SO
 * line to RM 0 in Houzs ERP. It exists because the ambiguity was never about
 * trust — it was that `0` carries two meanings on one wire: "the client could
 * not resolve a price" and "this line is free". The ERP line editor knows which
 * it sent, so it now says so (`zeroPriceIntended`), and ONLY that explicit
 * statement selects this mode. A 0 arriving without it is still "not provided"
 * and still takes the catalogue fill, which is every other caller in the system.
 *
 * It is NOT 'including-zero' with another name. It deliberately does not make
 * `isMigratedTrust` true, so the surcharge-suppression arm that protects the
 * 10,856 zero-priced migrated lines stays exclusive to migrated documents; an
 * operator-authored zero still prices its director-authored surcharges normally.
 */
export type TrustSelling = boolean | 'including-zero' | 'operator-zero';

/** The trust an ERP line write earns. ONE home, because it is now asked in two
 *  places (line PATCH and line ADD) and they must not drift: editing a line to
 *  RM 0 while adding one at RM 0 took the catalogue price is exactly the defect
 *  this closes.
 *
 *  `'operator-zero'` ONLY when the editor states the 0 was typed rather than
 *  unresolved — strict `=== true`, and only at 0, so every other caller's 0
 *  still means "not provided" and takes the catalogue fill. A POS session never
 *  reaches it: `posTablet` short-circuits both arms, because the POS cannot make
 *  that statement and its 0 is the documented "not provided" case. */
export const erpLineTrust = (
  posTablet: boolean,
  unitPriceSen: number,
  zeroPriceIntended: unknown,
  /* MIGRATED ORDER? Required, not optional, because it DECIDES (CLAUDE.md): a
     caller that says nothing would silently keep the old answer, and that is the
     hole this parameter closes.

     Owner, 2026-09-02: 「我们的 selling price 是根据我们 manually 填入的，不应该
     被这种影响」 — the specials surcharge, and the fabric surcharge with it, must
     not move a price a person typed. On an AutoCount-imported line the price is
     the BOOK's, which is the same statement, and `so-revision.ts` already says
     it on the amendment path by deriving 'including-zero' from
     `linked_ac_docno IS NOT NULL`. The plain line PATCH passed a bare `true` and
     therefore did NOT set `isMigratedTrust` — so on a migrated line priced 0
     (10,856 of 13,909 of them) an edit could hand it base + surcharges. Two edit
     paths, two answers about the same order.

     ADD is deliberately excluded by the CALLER, not here: a line typed today has
     no AutoCount history, and so-revision.ts refuses 'including-zero' on its own
     ADD arm for the same reason. */
  soIsMigrated: boolean,
): TrustSelling => {
  if (posTablet) return false;
  if (soIsMigrated) return 'including-zero';
  return unitPriceSen === 0 && zeroPriceIntended === true ? 'operator-zero' : true;
};

/** BUG-63 — the unit price a line PATCH persists. A 0 nobody claimed means "no
 *  price could be found" (a swap to a sofa module or an unpriced SKU), so the
 *  line keeps the price it already carries instead of dropping to RM 0. Only an
 *  operator's claimed 0 or a migrated line's own 0 may replace a stored price. */
export const unitAfterLineEdit = (resolvedSen: number, storedSen: number | null, trust: TrustSelling): number =>
  resolvedSen === 0 && trust !== 'operator-zero' && trust !== 'including-zero' && (storedSen ?? 0) > 0
    ? (storedSen as number)
    : resolvedSen;

/** Pure mapper from a (product, fabric, variants) snapshot to the
 *  breakdown + DB column values. Used by tests + the route helpers below
 *  so the math path is verifiable without Supabase. */
export function recomputeFromSnapshot(
  item:    MfgItemForRecompute,
  product: ProductRowLite | null,
  fabric:  FabricRowLite | null,
  config:  MaintenanceConfig | null,
  sofaCombos: SofaComboRow[] | null = null,
  sofaModulePrices: SofaModulePriceSen | null = null,
  sellingFabricTiers: { sofaTier: FabricTier | null; bedframeTier: FabricTier | null } | null = null,
  fabricAddonConfig: FabricTierAddonConfig | null = null,
  /** PWP (换购) base price (sen) for this line when the order-level voucher
   *  claim (route) granted it. null → no grant (normal selling base);
   *  0 → granted FREE (a 'promo' code on a reward with no PWP price set —
   *  migration 0145); > 0 → granted at that PWP base. Non-sofa only; fabric Δ
   *  still stacks on top. Migrations 0128/0130/0145. */
  pwpBaseSen: number | null = null,
  /** PWP (换购) SOFA grant (Phase 2). The order-level consume validated this
   *  sofa-reward line's code and passes the code's reward combo ids; the sofa
   *  branch then charges ONLY those combos' pwp_prices_by_height (others stay at
   *  the normal selling price). null/[] → no change. SOFA only. */
  pwpSofaComboIds: string[] | null = null,
  specialAddons: SpecialAddonDef[] | null = null,
  sofaModuleCostRows: SofaModuleCostRowLite[] | null = null,
  modelFabricOverrides: Map<string, FabricTierModelOverride> | null = null,
  compartmentFabricOverrides: Map<string, FabricTierModelOverride> | null = null,
  /** Owner ruling 2026-05-31 (extended): a TRUSTED non-POS author (web/mobile
   *  office or sales staff) prices freely, so a hand-entered selling price is
   *  PERSISTED as-is instead of normalised to the authoritative catalog figure.
   *  Default false = the authoritative behaviour for every other caller. NEVER
   *  true for a POS-tablet session (those are drift-rejected upstream). Cost is a
   *  server-only snapshot and is untouched by this flag.
   *
   *  See {@link TrustSelling} for what 'including-zero' adds and why only a
   *  MIGRATED document may ask for it. */
  trustOperatorSelling: TrustSelling = false,
): RecomputedLine {
  const category = toMfgCategory(item.itemGroup, product?.category ?? '');
  const variants = item.variants ?? {};
  const specials = normalizeSpecials(variants.specials ?? variants.special);

  const sofaCells = category === 'SOFA'
    ? (item.variants as { cells?: unknown } | null | undefined)?.cells
    : null;
  const buildCompartments = (Array.isArray(sofaCells)
    ? (sofaCells as Array<{ moduleId?: unknown } | null>).map((cl) => String(cl?.moduleId ?? ''))
    : category === 'SOFA' ? (item.buildCompartments ?? []) : [])
    .map((code) => normalizeCompartmentCode(code))
    .filter(Boolean);

  const specialChoices =
    variants.specialChoices && typeof variants.specialChoices === 'object'
      ? (variants.specialChoices as Record<string, string[]>)
      : null;
  const specialsAddonPool = specialAddons
    ? buildSpecialsPoolFromAddons(specialAddons, specials, specialChoices, buildCompartments)
    : null;
  const effectiveConfig: MaintenanceConfig | null =
    specialsAddonPool && config
      ? { ...config, specials: specialsAddonPool, sofaSpecials: specialsAddonPool }
      : config;

  let fabricTier: MfgFabricTier | null = null;
  if (fabric) {
    if (category === 'SOFA') {
      fabricTier = fabric.sofa_price_tier ?? fabric.price_tier ?? null;
    } else if (category === 'BEDFRAME') {
      fabricTier = fabric.bedframe_price_tier ?? fabric.price_tier ?? null;
    }
  }
  const fabricInput: MfgPricingFabric | null = fabric
    ? { tier: fabricTier, surchargeSen: 0 }
    : null;

  const pricingProduct: MfgPricingProduct = {
    category,
    basePriceSen:     product?.base_price_sen ?? null,
    price1Sen:        product?.price1_sen ?? null,
    seatHeightPrices: product?.seat_height_prices ?? null,
    costPriceSen:     product?.cost_price_sen ?? null,
  };

  const depthRaw = variants.depth;
  const depthStr = depthRaw != null && String(depthRaw).trim() !== '' ? String(depthRaw).trim() : null;
  const seatSizeKey = depthStr ?? variants.seatHeight ?? null;

  const pricingInput = {
    product:       pricingProduct,
    fabric:        fabricInput,
    qty:           Math.max(0, Math.floor(item.qty || 0)),
    divanHeight:   variants.divanHeight ?? null,
    legHeight:     variants.legHeight ?? null,
    totalHeight:   variants.totalHeight ?? null,
    specials,
    seatSize:      seatSizeKey,
    sofaLegHeight: variants.sofaLegHeight ?? null,
  };

  const breakdown = computeMfgLinePrice(pricingInput, effectiveConfig);
  const manualUnitSelling = Math.max(0, Math.round(Number(item.unitPriceSen ?? 0)));
  const safeQty = Math.max(0, Math.floor(item.qty || 0));

  const costBreakdown = computeMfgLineCost(pricingInput, effectiveConfig);

  const specialsPool =
    category === 'SOFA'
      ? effectiveConfig?.sofaSpecials ?? []
      : (category === 'BEDFRAME' || category === 'MATTRESS')
        ? effectiveConfig?.specials ?? []
        : [];
  const pickedSpecials = specials.map((s) => {
    const hit = specialsPool.find((o) => o.value === s);
    return { description: s, surchargeSen: hit?.sellingPriceSen ?? 0 };
  });
  /* Owner 2026-09-22 — specials must print in ONE canonical order on every line,
     so the compartment lines of a sofa SET (and the DO / SI / PDF copies that
     read this column) never list the same add-ons in a different order per line.
     The picked order is whatever order the operator ticked them, which differs
     line to line; sort the COMPOSITION with the SAME shared comparator the
     rendered SPECIAL segment uses (compareSpecialLabels — codepoint, not
     ICU-dependent localeCompare), so the persisted column and every printed
     surface agree on order. Display order only: the surcharge is a Σ and the
     pricing `specials` array is untouched, so no price moves. The free-text
     extra add-on note is appended AFTER this sort below, so it trails the picks. */
  pickedSpecials.sort((a, b) => compareSpecialLabels(a.description, b.description));

  const rawExtra = Number(variants.extraAddonAmountRM ?? 0);
  const extraSen = (Number.isFinite(rawExtra) ? Math.max(0, Math.round(rawExtra)) : 0) * 100;

  const noteText = typeof variants.extraAddonNote === 'string' ? variants.extraAddonNote.trim() : '';
  if (noteText || extraSen > 0) {
    pickedSpecials.push({ description: noteText || 'Extra add-on', surchargeSen: extraSen });
  }
  const customSpecials = pickedSpecials.length ? pickedSpecials : null;

  const sellBaseSen = Math.max(0, Math.round(Number(product?.sell_price_sen ?? 0)));
  /* PWP (换购, migration 0128) — when the route's order-level voucher claim
     granted this line, charge the granted base instead of sell_price_sen. The
     route only passes pwpBaseSen for a validated + claimed code, so a forged
     claim never reaches here as a real grant → the line reprices at full
     sell_price_sen → drift. pwpBaseSen semantics: null = no grant; 0 = promo
     code redeems FREE (migration 0145 — the reward has no PWP price set);
     > 0 = the per-SKU pwp_price_sen. Sofa is excluded (it prices via the
     module path below). Selling-only; cost path untouched. */
  const pwpBase = (pwpBaseSen != null && pwpBaseSen >= 0 && category !== 'SOFA')
    ? Math.round(pwpBaseSen)
    : null;
  const effectiveBaseSen = pwpBase ?? sellBaseSen;

  /* Owner 2026-08-11 ("让收费追上成本") — CHARGE the selling surcharges the COST
     path already books. `computeMfgLinePrice` pins its selling base at 0
     (Commander 2026-05-29: the product price tables are COST), so this
     subtraction IS the Σ of the director-authored selling surcharges —
     specials / divan / leg / total-height — and nothing else. It is the exact
     mirror of the sofa build's `costSurchargesSen` below, which is why the two
     sides can no longer disagree about the same add-on. Written as a
     subtraction rather than as `breakdown.unitPriceSen` so that if the selling
     base ever stops being 0 this cannot silently start double-charging it. */
  const sellingSurchargesSen = breakdown.unitPriceSen - breakdown.basePriceSen;

  /* A MIGRATED document must never be re-priced by this engine (owner ruling
     "A", enforced for the amendment path by #1954). 'including-zero' is the
     marker the amendment path derives from `linked_ac_docno IS NOT NULL`, and
     it is load-bearing HERE: 10,856 of 13,909 migrated lines are priced 0, so
     the `sellingSurchargesSen > 0` arm added below is exactly the arm that
     would hand those lines a computed price. The final trust overwrite already
     restores the stored price, but the arm is made structurally inert under the
     migrated marker as well, so the new behaviour cannot reach them even if a
     future caller reorders that overwrite. */
  const isMigratedTrust = trustOperatorSelling === 'including-zero';
  const chargeableSurchargesSen = isMigratedTrust ? 0 : sellingSurchargesSen;

  const authoritativeSellingSen = effectiveBaseSen + chargeableSurchargesSen;
  const hasAuthoritativeSelling =
    category !== 'SOFA' && (effectiveBaseSen > 0 || chargeableSurchargesSen > 0);

  const canPriceSofa = Array.isArray(sofaCells) && sofaCells.length > 0 && sofaModulePrices != null;

  let unitCostSen = costBreakdown.unitPriceSen;
  let effectiveCostBreakdown = costBreakdown;
  let sofaModuleCostsSen: Record<string, number> | null = null;
  if (
    category === 'SOFA' &&
    Array.isArray(sofaCells) && sofaCells.length > 0 &&
    sofaModuleCostRows && sofaModuleCostRows.length > 0
  ) {
    const buildSeatSize = seatSizeKey ?? '24';
    const costMap = sofaModuleCostPricesFromSkus(
      sofaModuleCostRows.map((r) => ({
        code:             r.code,
        basePriceSen:     r.base_price_sen,
        price1Sen:        r.price1_sen,
        costPriceSen:     r.cost_price_sen,
        seatHeightPrices: r.seat_height_prices,
      })),
      product?.base_model ?? null,
      buildSeatSize,
      fabricTier,
    );
    let modulesCostSen = 0;
    for (const cell of sofaCells as Cell[]) {
      const modId = String((cell as { moduleId?: unknown })?.moduleId ?? '').trim();
      if (!modId) continue;
      modulesCostSen += costMap[normalizeCompartmentCode(modId)] ?? 0;
    }
    if (modulesCostSen > 0) {
      sofaModuleCostsSen = costMap;
      const costSurchargesSen = costBreakdown.unitPriceSen - costBreakdown.basePriceSen;
      unitCostSen = modulesCostSen + costSurchargesSen;
      effectiveCostBreakdown = {
        ...costBreakdown,
        basePriceSen: modulesCostSen,
        unitPriceSen: unitCostSen,
        lineTotalSen: unitCostSen * safeQty,
      };
    }
  }

  const sellingTier = category === 'SOFA'
    ? (sellingFabricTiers?.sofaTier ?? null)
    : category === 'BEDFRAME'
      ? (sellingFabricTiers?.bedframeTier ?? null)
      : null;
  const baseModelOverride = (modelFabricOverrides && product?.model_id)
    ? (modelFabricOverrides.get(product.model_id) ?? null)
    : null;
  const modelOverride = resolveFabricTierOverride(
    buildCompartments,
    baseModelOverride,
    compartmentFabricOverrides ?? new Map(),
  );
  const fabricAddonSen = (fabricAddonConfig && (category === 'SOFA' || category === 'BEDFRAME'))
    ? fabricTierAddon(category, sellingTier, fabricAddonConfig, modelOverride) * 100
    : 0;


  let sofaComboMatchedAccessoryIds: string[] = [];
  let sofaComboIds: string[] = [];
  let drift: boolean;
  let unitToPersistSen: number;
  if (canPriceSofa) {
    const sofaDepth = String((item.variants as { depth?: unknown; seatHeight?: unknown } | null | undefined)?.depth ?? (item.variants as { seatHeight?: unknown } | null | undefined)?.seatHeight ?? '24');
    const lineCombos = (sofaCombos ?? []).filter(
      (c) => !product?.base_model || c.baseModel === product.base_model,
    );
    /* PWP (换购) SOFA reward (Phase 2) — when the order-level consume granted this
       sofa line, charge ONLY the code's reward combos at pwp_prices_by_height
       (merged over their normal selling-charged price, so a height without a PWP
       price falls back to selling). Same matching engine + cheaper-guard, so a
       PWP price that beats à-la-carte applies; default {} → no override. Combos
       NOT in the grant list keep their normal selling price. */
    const pwpComboSet = pwpSofaComboIds && pwpSofaComboIds.length > 0 ? new Set(pwpSofaComboIds) : null;
    const effectiveCombos = pwpComboSet
      ? lineCombos.map((c) => (pwpComboSet.has(c.id)
          ? { ...c, pricesByHeight: comboChargedPrices(c.pwpPricesByHeight, c.pricesByHeight) }
          : c))
      : lineCombos;
    const sofaPrice = computeSofaSellingResult(sofaCells as Cell[], sofaDepth, sofaModulePrices, effectiveCombos, item.sofaAccessories ?? []);
    const sofaSellingSen = sofaPrice.total;
    sofaComboIds = sofaPrice.groups.flatMap((group) => group.comboId ? [group.comboId] : []);
    sofaComboMatchedAccessoryIds = sofaPrice.groups.flatMap((group) => group.comboMatchedAccessoryIds ?? []);
    if (sofaSellingSen > 0 || sofaComboMatchedAccessoryIds.length > 0) {
      /* Server has authoritative per-Model module SELLING prices for this build,
         + the SELLING fabric-tier Δ (migration 0124); the POS adds the same Δ so
         the gate matches. Δ = 0 with default data (no tier / no config set).

         + `chargeableSurchargesSen` (owner 2026-08-11): the sofa build was the
         one authoritative branch that dropped the line's selling surcharges,
         while the cost branch above re-adds its own `costSurchargesSen` on top
         of Σ module costs. A priced sofa special add-on was therefore costed
         and never charged — it could only ever reduce margin. Σ modules is the
         BASE here, exactly as Σ module costs is the base there, so the
         surcharges belong on top of it on both sides. */
      const authoritativeSofaSen = sofaSellingSen + chargeableSurchargesSen + fabricAddonSen + extraSen;
      drift = driftThresholdExceeded(manualUnitSelling, authoritativeSofaSen);
      unitToPersistSen = authoritativeSofaSen;
    } else {
      drift = false;
      unitToPersistSen = manualUnitSelling;
    }
  } else if (hasAuthoritativeSelling) {
    const authoritativeWithFabric = authoritativeSellingSen + fabricAddonSen + extraSen;
    drift = driftThresholdExceeded(manualUnitSelling, authoritativeWithFabric);
    unitToPersistSen = authoritativeWithFabric;
  } else {
    drift = false;
    unitToPersistSen = manualUnitSelling;
  }

  if (trustOperatorSelling
      && (manualUnitSelling > 0
          || trustOperatorSelling === 'including-zero'
          || trustOperatorSelling === 'operator-zero')) {
    unitToPersistSen = manualUnitSelling;
  }

  return {
    itemCode:          item.itemCode,
    sofaComboMatchedAccessoryIds,
    sofaComboIds,
    unit_price_sen:    unitToPersistSen,
    divan_price_sen:   breakdown.divanSurchargeSen,
    leg_price_sen:     breakdown.legSurchargeSen,
    special_order_sen: breakdown.specialsSurchargeSen,
    custom_specials:   customSpecials,
    total_sen:       unitToPersistSen * safeQty,
    breakdown,
    unit_cost_sen:     unitCostSen,
    line_cost_sen:     unitCostSen * safeQty,
    costBreakdown:     effectiveCostBreakdown,
    sofa_module_costs_sen: sofaModuleCostsSen,
    drift,
  };
}


/** Load a single product row from mfg_products by code, within one company. */
export async function loadProductByCode(sb: any, code: string, companyId: number | null | undefined): Promise<ProductRowLite | null> {
  if (!code) return null;
  let q = sb
    .from('mfg_products')
    .select('code, category, base_price_sen, price1_sen, cost_price_sen, seat_height_prices, sell_price_sen, pwp_price_sen, model_id, size_code, base_model, branding, default_free_gifts')
    .eq('code', code);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q.maybeSingle();
  if (error) console.error(`[mfg-pricing] loadProductByCode('${code}', company=${companyId ?? 'unscoped'}) failed:`, error.message ?? error);
  if (!data) return null;
  return data as ProductRowLite;
}

/** Batched mirror of {@link loadProductByCode} — ONE `in()` query for a whole
 *  order's line codes, keyed by code, within one company. Subrequest diet (Loo
 *  2026-06-06): the SO create path used to issue one product lookup per line and
 *  a 6-item order blew the CF Workers per-request subrequest cap; every per-line
 *  read on that path must stay O(1) in queries. */
export async function loadProductsByCodes(sb: any, codes: Array<string | null | undefined>, companyId: number | null | undefined): Promise<Map<string, ProductRowLite>> {
  const uniq = Array.from(new Set(codes.map((c) => (c ?? '').trim()).filter(Boolean)));
  if (uniq.length === 0) return new Map();
  let q = sb
    .from('mfg_products')
    .select('code, category, base_price_sen, price1_sen, cost_price_sen, seat_height_prices, sell_price_sen, pwp_price_sen, model_id, size_code, base_model, branding, default_free_gifts');
  /* postgrest-js `.in()` quotes reserved chars but never ESCAPES, so a code
     carrying a `"` (inch mark) or `\` closes the in-list early and every code
     after it in the batch silently reads as absent (docs/bugs/0780, and the
     amendment-submit refusal it also caused). Escape via pgrestInList — which is
     byte-identical to `.in()` for a clean list — ONLY when a code actually
     carries one of those two characters, so the ordinary read keeps the plain
     `.in()` path unchanged. */
  q = uniq.some((code) => /["\\]/.test(code))
    ? q.filter('code', 'in', pgrestInList(uniq))
    : q.in('code', uniq);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) {
    console.error(`[mfg-pricing] loadProductsByCodes read failed (company=${companyId ?? 'unscoped'}):`, (error as { message?: unknown }).message ?? error);
  }
  const rows = ((data as ProductRowLite[]) ?? []);
  if (rows.length > uniq.length) {
    const dupes = [...new Set(rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i))];
    console.error(`[mfg-pricing] duplicate mfg_products codes in company=${companyId ?? 'unscoped'}: ${dupes.join(', ')} — pricing picks one arbitrarily`);
  }
  return new Map(rows.map((r) => [r.code, r]));
}

/** Load active Special Add-ons (migration 0134) as pricing defs. The SO recompute
 *  builds each line's specials pool from these (base sellingPriceSen + Σ chosen
 *  option-group extraSen) instead of the legacy maintenance_config.specials pool.
 *  Returns [] on empty/error (recompute then prices any picked codes at 0 — no
 *  crash, no reject). */
export async function loadSpecialAddons(
  sb: any,
  companyId: number | null | undefined,
): Promise<SpecialAddonDef[]> {
  // Codes repeat across companies and the pool is keyed by code (HC-0134).
  const { data } = await scopeToCompanyIdOrOpen(
    sb.from('special_addons').select('code, selling_price_sen, cost_price_sen, option_groups, compartment_prices'),
    companyId,
  )
    .eq('active', true);
  return ((data as any[]) ?? []).map((r) => ({
    code:              r.code,
    sellingPriceSen:   r.selling_price_sen ?? 0,
    costPriceSen:      r.cost_price_sen ?? 0,
    optionGroups:      Array.isArray(r.option_groups) ? r.option_groups : [],
    compartmentPrices: compartmentPricesFromRow(r.compartment_prices),
  }));
}

/** `special_addons.compartment_prices` (jsonb) → pricing rows, canonical codes.
 *  The route validates on write; this keeps a malformed entry from pricing. */
export function compartmentPricesFromRow(raw: unknown): SpecialAddonCompartmentPriceDef[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ compartment?: unknown; sellingPriceSen?: unknown } | null>).flatMap((e) => {
    const compartment = normalizeCompartmentCode(String(e?.compartment ?? ''));
    const sellingPriceSen = Number(e?.sellingPriceSen);
    return compartment && Number.isInteger(sellingPriceSen) ? [{ compartment, sellingPriceSen }] : [];
  });
}

/** Load a Model's sofa module SELLING prices (per-Model module→sen map) from
 *  mfg_products, for the given seat `depth`. Each module of a Model is its own
 *  SKU (e.g. `BOOQIT-2A(LHF)`). The per-(depth, P1) `seat_height_prices[].
 *  sellingPriceSen` (what the POS Edit-Price grid writes) wins; otherwise the
 *  flat `sell_price_sen`. Tier is fixed at P1 (Chairman 2026-06-01: run at P1 —
 *  no fabric-tier variation yet). Returns null when base_model is absent so the
 *  caller treats the sofa as "can't price → trust operator" (never a false
 *  reject). Built via the shared `sofaModuleSellingPricesFromSkus` at the SAME
 *  (depth, P1) the POS Configurator uses, so the server map is byte-for-byte
 *  what the POS builds and the drift gate can't diverge. */
export async function loadModelSofaModulePrices(
  sb: any,
  baseModel: string | null | undefined,
  depth: string | null | undefined,
  companyId: number | null | undefined,
): Promise<SofaModulePriceSen | null> {
  if (!baseModel) return null;
  let q = sb
    .from('mfg_products')
    .select('code, sell_price_sen, seat_height_prices')
    .eq('base_model', baseModel)
    .eq('category', 'SOFA');
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  if (!data) return null;
  return sofaModuleSellingPricesFromSkus(
    (data as Array<{ code: string; sell_price_sen: number | null; seat_height_prices: MfgSeatHeightPrice[] | null }>).map((r) => ({
      code: r.code,
      sellPriceSen: r.sell_price_sen,
      seatHeightPrices: r.seat_height_prices,
    })),
    baseModel,
    depth,
    'PRICE_1',
  );
}

/** Load a Model's sofa module COST prices (per-Model module→sen map) from
 *  mfg_products. Mirror of {@link loadModelSofaModulePrices} but reads the COST
 *  field (`base_price_sen`) instead of `sell_price_sen`. Used to auto-detect a
 *  Combo's COST = Σ its constituent module SKUs' costs (Phase 5, Chairman
 *  2026-05-31) — a Combo is just existing module SKUs assembled, so its cost is
 *  the sum of those SKUs' COST, auto-keyed and Backend-overridable. Returns null
 *  when base_model is absent. Unpriced (null base_price_sen) modules drop out. */
export async function loadModelSofaModuleCosts(
  sb: any,
  baseModel: string | null | undefined,
  companyId: number | null | undefined,
): Promise<SofaModulePriceSen | null> {
  if (!baseModel) return null;
  let q = sb
    .from('mfg_products')
    .select('code, base_price_sen')
    .eq('base_model', baseModel)
    .eq('category', 'SOFA');
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  if (!data) return null;
  return sofaModulePricesFromSkus(
    (data as Array<{ code: string; base_price_sen: number | null }>).map((r) => ({
      code: r.code,
      sellPriceSen: r.base_price_sen,
    })),
    baseModel,
  );
}

/** Load a Model's sofa module SKU COST rows (audit 2026-06-11 C2). Sibling of
 *  {@link loadModelSofaModuleCosts} but returns the RAW rows (flat cost columns
 *  + seat_height_prices) so `recomputeFromSnapshot` can resolve each module's
 *  cost at the LINE's own (seat size, fabric tier) — the tier varies per line,
 *  so the resolution can't be baked into the load. Returns null when
 *  base_model is absent (caller keeps the legacy single-SKU cost). */
export async function loadModelSofaModuleCostRows(
  sb: any,
  baseModel: string | null | undefined,
  companyId: number | null | undefined,
): Promise<SofaModuleCostRowLite[] | null> {
  if (!baseModel) return null;
  let q = sb
    .from('mfg_products')
    .select('code, base_price_sen, price1_sen, cost_price_sen, seat_height_prices')
    .eq('base_model', baseModel)
    .eq('category', 'SOFA');
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  if (!data) return null;
  return data as SofaModuleCostRowLite[];
}

/** Load a single fabric tracking row by code (tier-resolution data only). */
export async function loadFabricByCode(sb: any, code: string | null | undefined): Promise<FabricRowLite | null> {
  if (!code) return null;
  const { data } = await sb
    .from('fabric_trackings')
    .select('fabric_code, sofa_price_tier, bedframe_price_tier, price_tier')
    .eq('fabric_code', code)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return data as FabricRowLite;
}

/** Batched mirror of {@link loadFabricByCode} — ONE `in()` query, keyed by
 *  fabric_code. Part of the SO-create subrequest diet (Loo 2026-06-06). */
export async function loadFabricsByCodes(sb: any, codes: Array<string | null | undefined>): Promise<Map<string, FabricRowLite>> {
  const uniq = Array.from(new Set(codes.map((c) => (c ?? '').trim()).filter(Boolean)));
  if (uniq.length === 0) return new Map();
  const { data } = await sb
    .from('fabric_trackings')
    .select('fabric_code, sofa_price_tier, bedframe_price_tier, price_tier')
    .in('fabric_code', uniq);
  return new Map((((data as FabricRowLite[]) ?? [])).map((r) => [r.fabric_code, r]));
}

/** Load the master maintenance config in effect today (MYT): newest
 *  effective_from <= today, latest save wins a same-day tie. Same pick as
 *  GET /maintenance-config/resolved, so a future-dated change can't price early. */
export async function loadMaintenanceConfig(
  sb: any,
  companyId: number | null | undefined,
): Promise<MaintenanceConfig | null> {
  // Unscoped, the newest master row of ANY company priced the SO (HC-0134).
  const { data } = await scopeToCompanyIdOrOpen(
    sb.from('maintenance_config_history').select('config'),
    companyId,
  )
    .eq('scope', 'master')
    .lte('effective_from', todayMyt())
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const cfg = (data as { config?: unknown } | null)?.config;
  return (cfg as MaintenanceConfig | null) ?? null;
}

/** Load the chosen fabric's SELLING tiers from fabric_library (by fabric_library
 *  id = variants.fabricId). Drives the fabric-tier add-on (migration 0124).
 *  Distinct from loadFabricByCode (fabric_trackings, COST). */
export async function loadFabricSellingTiers(
  sb: any,
  fabricId: string | null | undefined,
): Promise<{ sofaTier: FabricTier | null; bedframeTier: FabricTier | null } | null> {
  if (!fabricId) return null;
  const { data } = await sb
    .from('fabric_library')
    .select('sofa_tier, bedframe_tier')
    .eq('id', fabricId)
    .maybeSingle();
  if (!data) return null;
  return {
    sofaTier:     ((data as { sofa_tier?: string | null }).sofa_tier ?? null) as FabricTier | null,
    bedframeTier: ((data as { bedframe_tier?: string | null }).bedframe_tier ?? null) as FabricTier | null,
  };
}

/** Batched mirror of {@link loadFabricSellingTiers} — ONE `in()` query, keyed
 *  by fabric_library id. Part of the SO-create subrequest diet (Loo 2026-06-06). */
export async function loadFabricSellingTiersByIds(
  sb: any,
  ids: Array<string | null | undefined>,
): Promise<Map<string, { sofaTier: FabricTier | null; bedframeTier: FabricTier | null }>> {
  const uniq = Array.from(new Set(ids.map((i) => (i ?? '').trim()).filter(Boolean)));
  if (uniq.length === 0) return new Map();
  const { data } = await chunkIn<{ id: string; sofa_tier?: string | null; bedframe_tier?: string | null }>(
    uniq,
    (batch, from, to) => sb
      .from('fabric_library')
      .select('id, sofa_tier, bedframe_tier')
      .in('id', batch)
      .order('id')
      .range(from, to),
  );
  return new Map(data.map((r) => [
    r.id,
    {
      sofaTier:     (r.sofa_tier ?? null) as FabricTier | null,
      bedframeTier: (r.bedframe_tier ?? null) as FabricTier | null,
    },
  ]));
}

/** Load the singleton fabric-tier add-on Δ config (whole MYR). Missing → all 0. */
export async function loadFabricTierAddonConfig(sb: any, companyId: number | null | undefined): Promise<FabricTierAddonConfig> {
  let q = sb
    .from('fabric_tier_addon_config')
    .select('sofa_tier2_delta, sofa_tier3_delta, bedframe_tier2_delta, bedframe_tier3_delta');
  if (companyId != null) q = q.eq('company_id', companyId);
  else q = q.eq('id', 1);
  const { data } = await q.maybeSingle();
  const d = data as Record<string, number> | null;
  return {
    sofaTier2Delta:     d?.sofa_tier2_delta ?? 0,
    sofaTier3Delta:     d?.sofa_tier3_delta ?? 0,
    bedframeTier2Delta: d?.bedframe_tier2_delta ?? 0,
    bedframeTier3Delta: d?.bedframe_tier3_delta ?? 0,
  };
}

/** Load all per-Model fabric-tier Δ overrides (migration 0172) keyed by
 *  model_id. Small table (one row per special Model) → one query. Missing /
 *  error → empty map (every Model falls back to the global config). */
export async function loadModelFabricTierOverrides(
  sb: any,
): Promise<Map<string, FabricTierModelOverride>> {
  const { data } = await sb
    .from('model_fabric_tier_overrides')
    .select('model_id, tier2_delta, tier3_delta');
  const rows = (data as Array<{ model_id: string; tier2_delta: number | null; tier3_delta: number | null }>) ?? [];
  return new Map(rows.map((r) => [r.model_id, { tier2Delta: r.tier2_delta, tier3Delta: r.tier3_delta }]));
}

/** Load all per-compartment fabric-tier Δ overrides (migration 0025) keyed by
 *  compartment_id. Small table (one row per special compartment) → one query.
 *  resolveFabricTierOverride takes the MAX of these + the Model override per
 *  tier for a SOFA custom build. Missing / error → empty map (every build falls
 *  back to the Model-only path; back-compatible if 0025 hasn't landed yet — the
 *  table may not exist before the migration is applied). */
export async function loadCompartmentFabricTierOverrides(
  sb: any,
): Promise<Map<string, FabricTierModelOverride>> {
  const { data, error } = await sb
    .from('compartment_fabric_tier_overrides')
    .select('compartment_id, tier2_delta, tier3_delta');
  if (error) console.error('loadCompartmentFabricTierOverrides failed (falling back to model-only delta):', error.message ?? error);
  const rows = (data as Array<{ compartment_id: string; tier2_delta: number | null; tier3_delta: number | null }>) ?? [];
  return new Map(rows.map((r) => [r.compartment_id, { tier2Delta: r.tier2_delta, tier3Delta: r.tier3_delta }]));
}

/** Load all per-Model default free gifts (migration 0174) keyed by model_id.
 *  Small table (one row per gifted Model) → one query. Missing/error → empty
 *  map (Models with no row grant no gift). */
export async function loadModelDefaultGifts(
  sb: any,
): Promise<Map<string, DefaultFreeGift[]>> {
  const { data } = await sb
    .from('model_default_free_gifts')
    .select('model_id, gifts');
  const rows = (data as Array<{ model_id: string; gifts: unknown }>) ?? [];
  return new Map(rows.map((r) => [r.model_id, parseDefaultFreeGifts(r.gifts)]));
}

/** Load ACTIVE free-item campaigns (migration 0176). Small table → one query.
 *  Missing / error → []. The route feeds these (+ active sofa combos) to the
 *  shared campaignsCoveringLine to validate a made-free line. */
export async function loadActiveFreeItemCampaigns(sb: any): Promise<FreeItemCampaign[]> {
  const { data } = await sb
    .from('free_item_campaigns')
    .select('id, name, active, max_free_qty, eligible')
    .eq('active', true);
  const rows = (data as Array<Record<string, unknown>>) ?? [];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    active: Boolean(r.active),
    maxFreeQty: Number(r.max_free_qty ?? 1),
    eligible: parseFreeItemEligible(r.eligible),
  }));
}

/** Load the active PWP (换购) rules (migration 0128). Missing / none → []. The
 *  route feeds these + the order's lines to the shared `resolvePwp` to decide
 *  which reward lines get the PWP price. */
export async function loadPwpRules(sb: any): Promise<PwpRule[]> {
  const { data } = await sb
    .from('pwp_rules')
    .select('trigger_category, trigger_eligible_model_ids, reward_category, eligible_reward_model_ids, qty_per_trigger')
    .eq('active', true);
  if (!data) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    triggerCategory:         String(r.trigger_category ?? ''),
    triggerEligibleModelIds: Array.isArray(r.trigger_eligible_model_ids) ? (r.trigger_eligible_model_ids as unknown[]).map(String) : [],
    rewardCategory:          String(r.reward_category ?? ''),
    eligibleRewardModelIds:  Array.isArray(r.eligible_reward_model_ids) ? (r.eligible_reward_model_ids as unknown[]).map(String) : [],
    qtyPerTrigger:           Number(r.qty_per_trigger) || 1,
  }));
}

/** End-to-end: given an item draft, load product + fabric + config and
 *  return the recompute. The caller assembles the DB row from the result.
 *  Returns drift=true when the client's unitPriceSen differs > 0.5%
 *  from the server compute — caller decides whether to reject (HTTP 400).
 *
 *  `opts.trustOperatorSelling` is an OPTIONS OBJECT, not a 5th positional, on
 *  purpose. Until 2026-08-11 this wrapper could not express the flag at all: it
 *  called recomputeFromSnapshot with 14 positional arguments and simply let the
 *  15th default to false, so the SO amendment path — its only caller — re-priced
 *  every approved amendment to catalogue, including a MIGRATED order carrying the
 *  price AutoCount negotiated with the customer. A 15-argument positional call is
 *  what made that invisible; a named option cannot be dropped by miscounting. */
export async function recomputeOneLine(
  sb: any,
  item: MfgItemForRecompute,
  cachedConfig: MaintenanceConfig | null | undefined,
  companyId: number | null | undefined,
  opts?: { trustOperatorSelling?: TrustSelling; asOf?: string | null },
): Promise<RecomputedLine> {
  const config = cachedConfig ?? await loadMaintenanceConfig(sb, companyId);
  const [productLoaded, fabric, sellingTiers, fabricAddonConfig, modelOverrides, compartmentOverrides] = await Promise.all([
    loadProductByCode(sb, item.itemCode, companyId),
    loadFabricByCode(sb, item.variants?.fabricCode ?? null),
    loadFabricSellingTiers(sb, item.variants?.fabricId ?? null),
    loadFabricTierAddonConfig(sb, companyId),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  let product = productLoaded;
  if (productLoaded && companyId != null && opts?.asOf) {
    try {
      if (await autoDeriveEnabled(sb, companyId)) {
        const asOfCost = await resolveMfgProductCostAsOf(sb, companyId, item.itemCode, opts.asOf);
        if (asOfCost) {
          product = {
            ...productLoaded,
            base_price_sen: asOfCost.base_price_sen ?? productLoaded.base_price_sen,
            price1_sen: asOfCost.price1_sen ?? productLoaded.price1_sen,
            seat_height_prices: (asOfCost.seat_height_prices as ProductRowLite['seat_height_prices']) ?? productLoaded.seat_height_prices,
          };
        }
      }
    } catch (e) {
      console.error(`[auto-derive] as-of cost resolve failed for ${item.itemCode}:`, e instanceof Error ? e.message : e);
    }
  }
  const [sofaModulePrices, sofaModuleCostRows] = product?.category === 'SOFA'
    ? await Promise.all([
        loadModelSofaModulePrices(
          sb,
          product.base_model,
          String((item.variants as { depth?: unknown; seatHeight?: unknown } | null | undefined)?.depth ?? (item.variants as { seatHeight?: unknown } | null | undefined)?.seatHeight ?? '24'),
          companyId,
        ),
        loadModelSofaModuleCostRows(sb, product.base_model, companyId),
      ])
    : [null, null];
  return recomputeFromSnapshot(item, product, fabric, config, null, sofaModulePrices, sellingTiers, fabricAddonConfig, null, null, null, sofaModuleCostRows, modelOverrides, compartmentOverrides, opts?.trustOperatorSelling ?? false);
}
