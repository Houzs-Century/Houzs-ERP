// ----------------------------------------------------------------------------
// Server-side mfg-SO pricing recompute helper.
//
// Loads the product + fabric + maintenance config from Supabase, then defers
// to the pure `computeMfgLinePrice` function in ../shared. Returns the
// breakdown + the column values to persist on `mfg_sales_order_items`.
//
// Two design choices match the existing route style:
//   1. The variants column is the source of truth for the line's selections
//      (fabricCode, divanHeight, legHeight, totalHeight, gap, seatHeight,
//      specials, sofaLegHeight). Client sends `variants: { ... }` and we
//      project that into the pure compute input.
//   2. We accept the maintenance config blob as an injected `MaintenanceConfig`
//      so the caller can decide which scope (master / customer:<uuid>) won;
//      route code resolves once per request and threads it through.
//
// Drift: caller compares `clientUnitPriceSen` against the returned
// `unitPriceSen` via `mfgPricingDriftExceeds`. On drift > 0.5% the route
// returns HTTP 400 with the diff (see CLAUDE.md non-negotiable).
// ----------------------------------------------------------------------------

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
  type SpecialAddonDef,
} from '../shared/mfg-pricing';
import { chunkIn } from './paginate-all';
import {
  computeSofaSellingSen,
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
import { parseDefaultFreeGifts, type DefaultFreeGift, type FreeItemCampaign, parseFreeItemEligible } from '../shared';

export type MfgItemVariants = {
  fabricCode?:    string | null;
  /** fabric_library id (the customer-pickable fabric). Drives the SELLING
   *  fabric-tier add-on (migration 0124). Distinct from fabricCode (cost). */
  fabricId?:      string | null;
  divanHeight?:   string | null;
  legHeight?:     string | null;
  totalHeight?:   string | null;
  gap?:           string | null;             // no price contribution
  seatHeight?:    string | null;
  /** POS sofa vocabulary for the seat size (so-variant-rule: `depth` ≡
   *  `seatHeight`). The configurator sends `depth`; the Backend editor sends
   *  `seatHeight`. BOTH must resolve seat-height cost rows (audit 2026-06-11
   *  C2 — cost previously read only seatHeight, so POS builds always fell to
   *  the flat base cost). */
  depth?:         string | number | null;
  sofaLegHeight?: string | null;
  /** Multi-pick specials. HOOKKA-compatible: also accept a single string. */
  specials?:      string[] | string | null;
  /** Aliases (some POS clients send `special` instead). */
  special?:       string[] | string | null;
  /** Special Add-ons (migration 0134) — chosen option-group labels per code,
   *  e.g. { 'Right Drawer': ['10"'] }. Selling extras are summed into the
   *  per-line pool (buildSpecialsPoolFromAddons); buildVariantSummary renders
   *  them. Absent on legacy / no-choice lines. */
  specialChoices?: Record<string, string[]> | null;
  /** PWP (换购, migration 0128) — the salesperson toggled "use PWP price" on this
   *  reward line. The route's order-level resolvePwp validates it; only a granted
   *  line actually gets the PWP base. */
  pwp?:           boolean | null;
  /** Per-line operator remark keyed on the POS product page (spec 2026-06-06).
   *  Not priced — persisted to mfg_sales_order_items.remark by the route. Since
   *  2026-06-13 this is the ITEM remark ONLY; it no longer drives custom_specials. */
  remark?:        string | null;
  /** Special add-on note keyed on the POS product page (Loo 2026-06-13) — the
   *  free-text label for the declared extra charge. Drives the custom_specials
   *  composition; never priced (the money rides extraAddonAmountRM). */
  extraAddonNote?: string | null;
  /** Declared extra charge keyed on the POS product page, WHOLE MYR (spec D1).
   *  The POS folds it into the line's selling price; the recompute adds the
   *  same amount to the authoritative figure so the drift gate stays exact.
   *  Clamped ≥ 0 — this field can never discount. */
  extraAddonAmountRM?: number | null;
};

export type MfgItemForRecompute = {
  itemCode:       string;
  itemGroup:      string;          // 'bedframe' | 'sofa' | 'mattress' | 'accessory' | 'others'
  qty:            number;
  unitPriceSen: number;          // what the client SAID — to be drift-checked
  variants?:      MfgItemVariants | null;
};

export type RecomputedLine = {
  itemCode:     string;
  /** Persistable values for mfg_sales_order_items columns. */
  unit_price_sen:       number;
  divan_price_sen:      number;
  leg_price_sen:        number;
  special_order_sen:    number;     // sum of priced specials
  /** Persistable as custom_specials jsonb. Mirrors the client breakdown +
   *  any free-text specials the client wanted to keep verbatim. */
  custom_specials:      Array<{ description: string; surchargeSen: number }> | null;
  total_sen:          number;     // qty * unit (minus discount, applied by caller)
  breakdown:            MfgPricingBreakdown;
  /** COST snapshot from `computeMfgLineCost` (Commander 2026-05-28: backend
   *  `priceSen` tables ARE the cost). `unit_cost_sen` = base + Σ priceSen
   *  surcharges; `line_cost_sen` = unit_cost_sen × qty. Caller persists these
   *  onto mfg_sales_order_items.unit_cost_sen / line_cost_sen. Computed
   *  from the same (product, fabric, config) snapshot so cost stays in
   *  lockstep with the selling breakdown. NOT drift-checked (cost is a
   *  server-only snapshot, separate from the selling-total drift validation). */
  unit_cost_sen:        number;
  line_cost_sen:        number;
  costBreakdown:        MfgPricingBreakdown;
  /** Drift signal — true means client's submission diverged > 0.5% from
   *  server compute. Caller decides HTTP 400 vs warn vs accept. */
  drift:                boolean;
};

export type FabricRowLite = {
  fabric_code:         string;
  sofa_price_tier:     MfgFabricTier | null;
  bedframe_price_tier: MfgFabricTier | null;
  /** Legacy fallback (older rows). */
  price_tier:          MfgFabricTier | null;
};

export type ProductRowLite = {
  code:               string;
  category:           string;         // 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE'
  base_price_sen:     number | null;
  price1_sen:         number | null;
  cost_price_sen:     number | null;
  seat_height_prices: MfgSeatHeightPrice[] | null;
  /** Sofa Model grouping — used to scope combos to this Model (Phase 4b), so
   *  the server matches the SAME combo set the POS did. */
  base_model:         string | null;
  /** SELLING price — the Master Account store (Phase-1 migration 0109,
   *  backfilled = base_price_sen). The authoritative customer-facing price the
   *  D4 drift gate validates a client submission against (non-sofa lines). */
  sell_price_sen:     number | null;
  /** PWP (换购) selling base price (migration 0128). When the order-level PWP
   *  resolution grants this line (passed in as `pwpBaseSen`), its selling base
   *  is this instead of sell_price_sen — fabric Δ still stacks on top. Optional:
   *  the loader always selects it; legacy/test snapshots may omit it. */
  pwp_price_sen?:     number | null;
  /** product_models.id — the route's resolvePwp matches this against a rule's
   *  eligible model lists. Optional for the same reason as pwp_price_sen. */
  model_id?:          string | null;
  /** mfg_products.size_code — POPULATED for mattress/bedframe, NULL for sofa
   *  modules. The special-delivery-fee `variant` scope (migration 0024) matches
   *  on it. Optional: legacy/test snapshots may omit it. */
  size_code?:         string | null;
  /** SO-SKU spec P5 — free-text brand label (mainly MATTRESS SKUs). Snapshotted
   *  onto each SO line at create so the Detail Listing's Branding column lights
   *  per line. Optional: legacy/test snapshots may omit it. */
  branding?:          string | null;
  /** Default Free Gift (migration 0170) — jsonb [{giftProductId, qty,
   *  campaignName?}]. The SO-create handler reads this to build the free-gift
   *  trigger map: a non-sofa product whose default_free_gifts is non-empty is a
   *  trigger for an accessory gift line. SELECTING-only here (the recompute math
   *  never reads it); parsed via parseDefaultFreeGifts. Optional: legacy/test
   *  snapshots may omit it. */
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
  // Prefer the canonical product category from mfg_products. Fall back to
  // the item_group string when the product isn't found.
  const c = (productCategory || group || '').toUpperCase();
  if (c.includes('BEDFRAME')) return 'BEDFRAME';
  if (c.includes('SOFA'))     return 'SOFA';
  if (c.includes('MATTRESS')) return 'MATTRESS';
  if (c.includes('ACCESSOR')) return 'ACCESSORY';
  if (c.includes('SERVICE'))  return 'SERVICE';
  return 'ACCESSORY';  // safest fallback: single-price, no variants.
};

const normalizeSpecials = (s: string[] | string | null | undefined): string[] => {
  if (!s) return [];
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return [String(s).trim()].filter(Boolean);
};

const driftThresholdExceeded = (clientSen: number, serverSen: number): boolean => {
  // Both columns are sen-equivalent integers (centi == sen × 1 in 2990s).
  // Commander 2026-05-29 — a client unitPriceSen of 0 means "not provided"
  // (e.g. the backend SO line editor couldn't resolve the price client-side).
  // Trust the server's own recompute instead of rejecting the whole SO. The
  // anti-tamper guard still catches a NON-zero client price below the server's.
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
  /* A migrated line's stored price stands, ZERO INCLUDED — that is the whole
     difference between this mode and a bare `true`, and it also switches off the
     chargeable-surcharge arm (see isMigratedTrust). */
  if (soIsMigrated) return 'including-zero';
  return unitPriceSen === 0 && zeroPriceIntended === true ? 'operator-zero' : true;
};

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
  /** Special Add-ons (migration 0134) defs (active rows, all categories — the
   *  builder only matches the line's picked codes). When provided, this line's
   *  specials pool is built from these (base + chosen-choice extras) and
   *  REPLACES config.specials/.sofaSpecials — so POS add-ons price from the
   *  special_addons table, not the legacy maintenance pool. null → legacy. */
  specialAddons: SpecialAddonDef[] | null = null,
  /** COST fix (audit 2026-06-11 C2) — the Model's sofa module SKU rows (cost
   *  columns + seat_height_prices), loaded by base_model. When present and the
   *  line is a configurator BUILD (variants.cells), the line's COST is
   *  recomputed as Σ per-module costs at the build's seat size + fabric tier,
   *  instead of the first module SKU's flat cost. null / unresolvable → keep
   *  the legacy single-SKU cost (never a regression). Selling path untouched. */
  sofaModuleCostRows: SofaModuleCostRowLite[] | null = null,
  /** Per-Model fabric-tier Δ overrides (migration 0172), keyed by model_id.
   *  When the line's product.model_id has an entry, its non-null tier value
   *  REPLACES the global Δ for that tier (null = inherit). null map / no entry
   *  → global (back-compatible). Resolved here so every caller only passes the
   *  map (loaded once). Selling-only; POS resolves the same map by model_id. */
  modelFabricOverrides: Map<string, FabricTierModelOverride> | null = null,
  /** Per-compartment fabric-tier Δ overrides (migration 0025), keyed by
   *  compartment_id. For a SOFA custom build, the effective Δ per tier is the
   *  MAX over the SET special values (the Model override + every override whose
   *  compartment code is in the build's cells); resolved via the shared
   *  resolveFabricTierOverride so POS and server agree. null map → model-only
   *  path (back-compatible). Quick-Pick bundles + non-sofa lines: model only. */
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

  // Special Add-ons (migration 0134): build THIS line's specials pool from the
  // special_addons defs (base sellingPriceSen + Σ chosen-choice extraSen) and use
  // a config whose .specials/.sofaSpecials IS that pool — the pure engine then
  // prices it unchanged. Falls back to the legacy maintenance config when no defs
  // are passed (backward-compatible). cost path reads the pool's priceSen too.
  const specialChoices =
    variants.specialChoices && typeof variants.specialChoices === 'object'
      ? (variants.specialChoices as Record<string, string[]>)
      : null;
  const specialsAddonPool = specialAddons
    ? buildSpecialsPoolFromAddons(specialAddons, specials, specialChoices)
    : null;
  const effectiveConfig: MaintenanceConfig | null =
    specialsAddonPool && config
      ? { ...config, specials: specialsAddonPool, sofaSpecials: specialsAddonPool }
      : config;

  // Resolve fabric tier per-context (sofa_price_tier vs bedframe_price_tier).
  let fabricTier: MfgFabricTier | null = null;
  if (fabric) {
    if (category === 'SOFA') {
      fabricTier = fabric.sofa_price_tier ?? fabric.price_tier ?? null;
    } else if (category === 'BEDFRAME') {
      fabricTier = fabric.bedframe_price_tier ?? fabric.price_tier ?? null;
    }
  }
  const fabricInput: MfgPricingFabric | null = fabric
    ? { tier: fabricTier, surchargeSen: 0 } // optional Fabric pool surcharge — wire when commander's Fabric pool ships.
    : null;

  const pricingProduct: MfgPricingProduct = {
    category,
    basePriceSen:     product?.base_price_sen ?? null,
    price1Sen:        product?.price1_sen ?? null,
    seatHeightPrices: product?.seat_height_prices ?? null,
    costPriceSen:     product?.cost_price_sen ?? null,
  };

  /* Audit 2026-06-11 C2 — honour the POS `depth` vocabulary as the seat-size
     source (so-variant-rule: depth ≡ seatHeight; sofaHeightKey reads
     depth ?? seatHeight). POS configurator lines carry only `depth`, so
     keying the cost on seatHeight alone always missed the seat-height cost
     rows and fell to the flat base cost. */
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

  /* Commander 2026-05-29 (system-wide) — the SELLING unit price is
     operator-authored, NOT computed. The product price tables are COST, so
     `computeMfgLinePrice` now returns a 0 selling base (surcharges only, 0
     today). We therefore PERSIST the client's manual selling price unchanged
     and DO NOT drift-check it (there is no computed selling figure to compare
     against — clobbering the manual price with the computed 0 would be wrong).
     `breakdown` is still computed so the surcharge component columns
     (divan/leg/special) reflect any director-set SELLING surcharges. */
  const breakdown = computeMfgLinePrice(pricingInput, effectiveConfig);
  const manualUnitSelling = Math.max(0, Math.round(Number(item.unitPriceSen ?? 0)));
  const safeQty = Math.max(0, Math.floor(item.qty || 0));

  /* Commander 2026-05-28 — COST snapshot. Same (product, fabric, variants,
     config) snapshot, but `computeMfgLineCost` reads the backend maintenance
     `priceSen` tables as the cost (base + Σ priceSen surcharges). This is the
     SEPARATE cost path — UNCHANGED — and is what drives unit_cost_sen /
     line_cost_sen / line_margin_sen. Never drift-checked (cost is a
     server-only snapshot). Margin = manual selling − computed cost. */
  const costBreakdown = computeMfgLineCost(pricingInput, effectiveConfig);

  // Project specials → custom_specials column. Each pick keeps its label
  // for the SO print; surchargeSen comes from the maintenance config.
  // Commander 2026-05-28: this is the SELLING breakdown persisted on the SO,
  // so it MUST read `sellingPriceSen` (the Sales-Director-authored selling
  // surcharge) — NOT `priceSen` (the cost benchmark). This keeps each pick's
  // persisted surchargeSen consistent with breakdown.specialsSurchargeSen /
  // special_order_sen (both computed from sellingPriceSen via the shared
  // computeMfgLinePrice). Unknown / unset picks ride along at 0, preserving
  // HOOKKA's tolerant behaviour.
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

  /* Declared extra charge (spec 2026-06-06 D1) — whole MYR → sen, clamped ≥ 0.
     Added to BOTH authoritative branches below, symmetric with the POS folding
     the same amount into its submitted total. Never applied to the PWP base
     (it stacks AFTER pwp/combo/fabric folds) and never to the cost path.
     NaN-safe: a non-numeric variants value (Number('abc') = NaN) collapses to
     0 instead of poisoning the authoritative figure → no false reject. */
  const rawExtra = Number(variants.extraAddonAmountRM ?? 0);
  const extraSen = (Number.isFinite(rawExtra) ? Math.max(0, Math.round(rawExtra)) : 0) * 100;

  /* Loo 2026-06-13 — the POS product-page "special add-on" (note + extra charge)
     is a free-text Special Add-on. Append its NOTE to the custom_specials
     composition so every specials surface (backend SO editor's Special Orders
     accordion, Detail Listing "Specials" column, the DO/SI copies) lists it next
     to the picked add-ons. Composition display ONLY — the money rides the
     authoritative figure via the extraSen fold below; this entry re-prices
     nothing. The item remark (variants.remark) is SEPARATE: it lands on
     mfg_sales_order_items.remark via the route and never enters custom_specials. */
  const noteText = typeof variants.extraAddonNote === 'string' ? variants.extraAddonNote.trim() : '';
  if (noteText || extraSen > 0) {
    pickedSpecials.push({ description: noteText || 'Extra add-on', surchargeSen: extraSen });
  }
  const customSpecials = pickedSpecials.length ? pickedSpecials : null;

  /* D4 (Chairman 2026-05-30, Q1) — AUTHORITATIVE selling recompute + drift
     reject. The Master Account store (mfg_products.sell_price_sen, Phase-1
     migration 0109) is the customer-facing selling base; add any director-set
     selling surcharges (`sellingSurchargesSen` below). On a catalog line we
     charge that authoritative price and flag drift > 0.5% so the route returns
     HTTP 400 (CLAUDE.md non-negotiable).

       • SOFA is EXCLUDED from this sell_price_sen catalog path — its selling is
         recomputed from per-Model module-SKU prices just below (SOFA-SELLING-
         PLAN), which since 2026-08-11 carries the SAME surcharges. A sofa we
         can't price there keeps the operator's manual price.
       • A line with neither sell_price_sen NOR a priced surcharge (custom /
         special order) has no authoritative figure → trust the operator.
       • A client price of 0 means "not provided" (e.g. the backend SO editor
         couldn't resolve it client-side) → fill the authoritative price, no
         drift (driftThresholdExceeded returns false for client 0 vs server>0). */
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
  /* A line whose product carries sell_price_sen = 0 used to be exempt from the
     whole authoritative path, so a priced add-on on it was costed and never
     charged. A priced surcharge is itself an authoritative figure. */
  const hasAuthoritativeSelling =
    category !== 'SOFA' && (effectiveBaseSen > 0 || chargeableSurchargesSen > 0);

  /* SOFA-SELLING-PLAN (Chairman 2026-05-31) — a configurator sofa arrives as
     ONE line carrying variants.cells + variants.depth. Recompute its
     authoritative SELLING total from the SAME per-Model module→price map the
     POS used (each module = that Model's SKU `sell_price_sen`, passed in as
     `sofaModulePrices` and loaded by base_model in the route) + combos, via the
     shared computeSofaSellingSen → computeSofaPrice, so the drift gate can't
     diverge from the POS submission. Sofa lines WITHOUT cells (a backend manual
     module row) or with no loaded module prices keep the operator's price — no
     false reject. */
  const sofaCells = category === 'SOFA'
    ? (item.variants as { cells?: unknown } | null | undefined)?.cells
    : null;
  const canPriceSofa = Array.isArray(sofaCells) && sofaCells.length > 0 && sofaModulePrices != null;

  /* ── BUILD COST = Σ module costs (audit 2026-06-11 C2) ─────────────────────
     A multi-module configurator build arrives as ONE line whose itemCode is
     the FIRST module's SKU, so `computeMfgLineCost` above priced the whole
     build at one module's cost — margin overstated by ~(N−1)/N. When the
     caller supplies the Model's module SKU cost rows, recompute the build's
     base cost as Σ per-module costs at the build's seat size (depth, like the
     selling side) + the line's fabric tier (P2 default / P1 — same resolver
     chain as computeMfgLineCost via sofaModuleCostPricesFromSkus). Line-level
     cost surcharges (sofa leg / specials) stay on top, counted ONCE per build.
     Falls back to the legacy single-SKU cost when module costs are
     unavailable or none of the build's modules is costed. */
  let unitCostSen = costBreakdown.unitPriceSen;
  let effectiveCostBreakdown = costBreakdown;
  if (
    category === 'SOFA' &&
    Array.isArray(sofaCells) && sofaCells.length > 0 &&
    sofaModuleCostRows && sofaModuleCostRows.length > 0
  ) {
    const buildSeatSize = seatSizeKey ?? '24'; // selling side defaults depth '24'
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

  // SELLING fabric-tier add-on (migration 0124). Per-item flat Δ (whole MYR →
  // ×100 centi) from the chosen fabric's per-context selling tier. Folded into
  // the AUTHORITATIVE sofa price below so the drift gate stays consistent with
  // the POS (which adds the same Δ via the shared fabricTierAddon). 0 when no
  // config / tier → default data = no price change. COST path untouched.
  const sellingTier = category === 'SOFA'
    ? (sellingFabricTiers?.sofaTier ?? null)
    : category === 'BEDFRAME'
      ? (sellingFabricTiers?.bedframeTier ?? null)
      : null;
  const baseModelOverride = (modelFabricOverrides && product?.model_id)
    ? (modelFabricOverrides.get(product.model_id) ?? null)
    : null;
  // migration 0025 — fold the Model override with any matching per-compartment
  // Δ (MAX per tier) over the custom build's cells. Quick-Pick / non-sofa lines
  // have no cells → empty list → resolve returns the Model override unchanged.
  const buildCompartments = (category === 'SOFA' && Array.isArray(sofaCells))
    ? (sofaCells as Array<{ moduleId?: unknown }>).map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
    : [];
  const modelOverride = resolveFabricTierOverride(
    buildCompartments,
    baseModelOverride,
    compartmentFabricOverrides ?? new Map(),
  );
  const fabricAddonSen = (fabricAddonConfig && (category === 'SOFA' || category === 'BEDFRAME'))
    ? fabricTierAddon(category, sellingTier, fabricAddonConfig, modelOverride) * 100
    : 0;

  /* `extraSen` (declared extra charge, spec D1) is parsed above with the
     custom_specials composition — it feeds BOTH authoritative branches below. */

  let drift: boolean;
  let unitToPersistSen: number;
  if (canPriceSofa) {
    /* Variants-vocabulary unification (port of 2990 73aeeb1e) — dual-read so a
       canonical persisted sofa line (seatHeight, no depth) keys its build
       geometry the same as a raw POS line (depth). Mirrors seatSizeKey above. */
    const sofaDepth = String((item.variants as { depth?: unknown; seatHeight?: unknown } | null | undefined)?.depth ?? (item.variants as { seatHeight?: unknown } | null | undefined)?.seatHeight ?? '24');
    // Scope combos to this Model's base_model — the POS pre-filters the same
    // way (useSofaCombos(base_model)); without it the server could match a
    // same-shape combo from another Model and false-reject. No base_model
    // (orphan) → consider all, mirroring the POS's null-filter fallback.
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
    const sofaSellingSen = computeSofaSellingSen(sofaCells as Cell[], sofaDepth, sofaModulePrices, effectiveCombos);
    if (sofaSellingSen > 0) {
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
      // The Model's priced modules don't cover this build (e.g. not yet priced
      // in Master Admin) → computeSofaSellingSen = 0. NEVER reject a sofa we
      // can't independently price — trust the operator/client price. The gate
      // stays inert per-Model until that Model's module SKUs get sell prices.
      drift = false;
      unitToPersistSen = manualUnitSelling;
    }
  } else if (hasAuthoritativeSelling) {
    // + SELLING fabric-tier Δ (migration 0124). Non-zero only for BEDFRAME (the
    // shared fabricTierAddon returns 0 for mattress/accessory/service). POS adds
    // the same Δ so the gate matches; 0 with default data (no tier / no config).
    const authoritativeWithFabric = authoritativeSellingSen + fabricAddonSen + extraSen;
    drift = driftThresholdExceeded(manualUnitSelling, authoritativeWithFabric);
    unitToPersistSen = authoritativeWithFabric;
  } else {
    drift = false;
    unitToPersistSen = manualUnitSelling;
  }

  /* Owner ruling — a TRUSTED non-POS author prices freely: when a price was
     actually entered, persist THAT over the authoritative catalog figure.
     manualUnitSelling === 0 means "not provided" (client couldn't resolve it) ->
     keep the authoritative fill. `drift` above is unchanged (only a POS caller is
     rejected on it; a trusted caller's drift is ignored by the route).

     'including-zero' additionally treats a stored 0 as a REAL price rather than
     "not provided". That distinction only makes sense for a MIGRATED document,
     and there it is load-bearing: an AutoCount sofa is frequently carried as the
     whole set price on ONE lead module line with 0 on its siblings, so under
     plain `true` every sibling would still be handed a catalogue price and the
     set would be billed several times over. Never use it for a line the operator
     is authoring now — there a 0 really does mean "not provided".

     'operator-zero' is the one sanctioned way for an authored 0 to survive: the
     ERP line editor stated that the operator typed it (see TrustSelling). Same
     effect HERE, deliberately different mode — it must not read as migrated. */
  if (trustOperatorSelling
      && (manualUnitSelling > 0
          || trustOperatorSelling === 'including-zero'
          || trustOperatorSelling === 'operator-zero')) {
    unitToPersistSen = manualUnitSelling;
  }

  return {
    itemCode:          item.itemCode,
    // Persist the AUTHORITATIVE selling price on a catalog line (D4) — UNLESS a
    // trusted non-POS author entered their own price (owner ruling); the
    // operator's manual price on a sofa / custom / not-found line.
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
    drift,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PRODUCT LOOKUP BY CODE — `code` IS NOT UNIQUE. PASS THE COMPANY.
   ═══════════════════════════════════════════════════════════════════════════

   `idx_mfg_products_code` is a plain btree, and both companies keep their own
   SKU master, so a code can name two different products. On production
   2026-08-01 SEVENTEEN codes did — CODY / FENRIR / JAGER × (K)(Q)(S)(SK)(SS)
   plus two mattress codes — HOUZS's manufacturing row and 2990's selling row,
   and TWELVE of them disagreed on `pwp_price_sen`. Both are legitimate rows;
   neither can be renamed.

   Unscoped, these two loaders picked between them at the database's whim:
   `.in()` has no ORDER BY and the Map keeps whichever came back last, and
   `.eq().maybeSingle()` errors outright on two rows (PGRST116) with the error
   discarded into `data = null`. That is how a POS order died on
   `pwp_code_rejected — CODY-(SS): this SKU has no PWP price set (SKU Master)`
   while the SKU Master, which IS company-scoped, showed RM 490 the whole time.
   The same wrong row also carries a NULL `sell_price_sen`, so the plain
   (voucher-free) order fails too — `driftThresholdExceeded` rejects a non-zero
   client price against a server 0.

   `companyId` follows the house pattern for a read helper that cannot take a
   Hono Context (validateSoDropdownFields, loadFabricTierAddonConfig): callers
   pass `activeCompanyId(c)` — or, in createSalesOrderCore, its local
   `companyId` — and null/undefined DEGRADES to no predicate so a
   single-company install, a headless job and the tests read exactly as before.
   Migration 0233 adds UNIQUE (company_id, code), which makes the scoped
   `.maybeSingle()` below single by construction rather than by luck. */

/** Load a single product row from mfg_products by code, within one company. */
export async function loadProductByCode(sb: any, code: string, companyId: number | null | undefined): Promise<ProductRowLite | null> {
  if (!code) return null;
  let q = sb
    .from('mfg_products')
    .select('code, category, base_price_sen, price1_sen, cost_price_sen, seat_height_prices, sell_price_sen, pwp_price_sen, model_id, size_code, base_model, branding, default_free_gifts')
    .eq('code', code);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q.maybeSingle();
  /* Never silent again. Unscoped (or pre-0189) this is where a duplicated code
     turns into "unknown item code" / a 0 price with nothing in the log to say
     why — the one symptom that cost a day. Still returns null: callers already
     handle a miss, and throwing here would fail an order on a diagnostic. */
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
    .select('code, category, base_price_sen, price1_sen, cost_price_sen, seat_height_prices, sell_price_sen, pwp_price_sen, model_id, size_code, base_model, branding, default_free_gifts')
    .in('code', uniq);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q;
  const rows = ((data as ProductRowLite[]) ?? []);
  /* More rows than codes means a code still resolves to two products in this
     scope — the Map below would silently keep one. Say so; the pricing that
     follows is a coin toss until it is fixed. */
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
export async function loadSpecialAddons(sb: any): Promise<SpecialAddonDef[]> {
  const { data } = await sb
    .from('special_addons')
    .select('code, selling_price_sen, cost_price_sen, option_groups')
    .eq('active', true);
  return ((data as any[]) ?? []).map((r) => ({
    code:            r.code,
    sellingPriceSen: r.selling_price_sen ?? 0,
    costPriceSen:    r.cost_price_sen ?? 0,
    optionGroups:    Array.isArray(r.option_groups) ? r.option_groups : [],
  }));
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
/*  `base_model` is no more unique than `code` — it is a plain text grouping on
 *  the same per-company table, so an unscoped read merges BOTH companies' sofa
 *  SKUs into one module→price map. That is worse than the by-code bug: the map
 *  is keyed by module suffix, so the other company's module silently REPLACES
 *  this one's, and the drift gate then compares the POS's (company-scoped) map
 *  against a mixed one. Same `companyId` contract as loadProductByCode. */
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
      sellPriceSen: r.base_price_sen,   // reuse the SELLING builder; field carries COST here
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
  // Audit (ported from 2990 20190257) — fabric_code carries only a NON-unique
  // index, so a duplicate would make .maybeSingle() error → null → the fabric
  // tier surcharge silently drops in the (non-negotiable) server-side recompute.
  // Resolve deterministically like the batched twin loadFabricsByCodes instead.
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

/** Load the most-recent master maintenance config row's `config` JSON. */
export async function loadMaintenanceConfig(sb: any): Promise<MaintenanceConfig | null> {
  const { data } = await sb
    .from('maintenance_config_history')
    .select('config')
    .eq('scope', 'master')
    .order('effective_from', { ascending: false })
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
  /* chunkIn — sales-analysis hands this the distinct fabricId of every SO line
     in its window (uuids), while its two sibling reads there were already
     chunked and this one was not. Keyed by id, so merging batches is a no-op on
     the result. */
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
  // Key by company_id (each company has one row; 2990's is id=100001, not 1).
  // When companyId is unresolved (single-company fallback) read the sole row.
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
  // Intentional model-only fallback on error (table may not exist pre-0025) —
  // we DON'T throw, but a real misconfiguration must not be silent.
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
  /* Key required, value still nullable — TypeScript forbids a required
     parameter after an optional one, and `companyId` below is the one that must
     not be omissible. Passing `null`/`undefined` here keeps the old behaviour
     (load the config on demand); what is no longer possible is dropping BOTH
     and silently re-pricing against every company's catalogue. */
  cachedConfig: MaintenanceConfig | null | undefined,
  companyId: number | null | undefined,
  opts?: { trustOperatorSelling?: TrustSelling },
): Promise<RecomputedLine> {
  const config = cachedConfig ?? await loadMaintenanceConfig(sb);
  const [product, fabric, sellingTiers, fabricAddonConfig, modelOverrides, compartmentOverrides] = await Promise.all([
    loadProductByCode(sb, item.itemCode, companyId),
    loadFabricByCode(sb, item.variants?.fabricCode ?? null),
    loadFabricSellingTiers(sb, item.variants?.fabricId ?? null),
    loadFabricTierAddonConfig(sb, companyId),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  const [sofaModulePrices, sofaModuleCostRows] = product?.category === 'SOFA'
    ? await Promise.all([
        loadModelSofaModulePrices(
          sb,
          product.base_model,
          /* Variants-vocabulary unification (port of 2990 73aeeb1e) — dual-read
             depth ?? seatHeight so a canonical persisted sofa line loads the
             same module-price grid as a raw POS line. */
          String((item.variants as { depth?: unknown; seatHeight?: unknown } | null | undefined)?.depth ?? (item.variants as { seatHeight?: unknown } | null | undefined)?.seatHeight ?? '24'),
          companyId,
        ),
        loadModelSofaModuleCostRows(sb, product.base_model, companyId),
      ])
    : [null, null];
  return recomputeFromSnapshot(item, product, fabric, config, null, sofaModulePrices, sellingTiers, fabricAddonConfig, null, null, null, sofaModuleCostRows, modelOverrides, compartmentOverrides, opts?.trustOperatorSelling ?? false);
}
