// Pricing math. SOLE source of truth — client and server import the same pure
// functions (per CLAUDE.md non-negotiable + PORT_DESIGN.md §5.2). The live SO
// path is /mfg-sales-orders (mfg-pricing.ts: computeMfgLinePrice +
// mfgPricingDriftExceeds); the delivery fee here (computeSoDeliveryFee) is
// shared by the POS handover preview and that server recompute. The legacy
// POST /orders recompute chain (computeOrderTotal / computeDeliveryFee /
// pricingDriftExceeds / OrderPricingError) was deleted with the /orders route
// on 2026-06-12. DO NOT duplicate this logic anywhere.

// computeSofaPrice lives in sofa-build.ts (re-exported via index). Types only:
import type { Cell, Depth, SofaPriceResult, SofaProductPricing } from './sofa-build';
import { fmtSen } from './format';

/* ─── Sofa ─────────────────────────────────────────────────────────── */
// Real implementation lives in sofa-build.ts; re-exported via index.ts. Aliased
// type re-exports are used here for legacy `SofaCell` / `SofaDepth` import sites.

export type SofaCell = Cell;
export type SofaDepth = Depth;
export type { SofaProductPricing, SofaPriceResult };

/* ─── Mattress ─────────────────────────────────────────────────────── */

export interface MattressPricing {
  variants: { sizeId: string; price: number; active: boolean }[];
  /** Optional per-mattress extra-pillow price; falls back to a flat default if not set. */
  extraPillowPrice?: number;
}

export interface MattressPriceResult {
  base: number;
  pillowExtra: number;
  total: number;
  breakdown: string[];
}

const DEFAULT_EXTRA_PILLOW_PRICE = 80;

export const computeMattressPrice = (
  sizeId: string,
  freePillows: number,
  extraPillows: number,
  pricing: MattressPricing,
): MattressPriceResult => {
  const variant = pricing.variants.find((v) => v.sizeId === sizeId);
  if (!variant) {
    return { base: 0, pillowExtra: 0, total: 0, breakdown: [`Unknown size '${sizeId}'`] };
  }
  if (!variant.active) {
    return {
      base: 0,
      pillowExtra: 0,
      total: 0,
      breakdown: [`Size '${sizeId}' is inactive on this Model`],
    };
  }
  const base = variant.price;
  const pricePerExtra = pricing.extraPillowPrice ?? DEFAULT_EXTRA_PILLOW_PRICE;
  const pillowExtra = Math.max(0, extraPillows) * pricePerExtra;
  const total = base + pillowExtra;
  const breakdown = [
    `Mattress · ${sizeId}: ${fmtSen(Math.round(base * 100))}`,
  ];
  if (freePillows > 0) breakdown.push(`Free pillows × ${freePillows}: ${fmtSen(0)}`);
  if (extraPillows > 0) {
    breakdown.push(`Extra pillows × ${extraPillows} @ ${fmtSen(Math.round(pricePerExtra * 100))}: ${fmtSen(Math.round(pillowExtra * 100))}`);
  }
  return { base, pillowExtra, total, breakdown };
};

/* ─── Bedframe ─────────────────────────────────────────────────────── */

export interface BedframePricing {
  variants: { sizeId: string; price: number; active: boolean }[];
}

export const computeBedframePrice = (
  sizeId: string,
  pricing: BedframePricing,
): { total: number; breakdown: string[] } => {
  const variant = pricing.variants.find((v) => v.sizeId === sizeId);
  if (!variant || !variant.active) {
    return { total: 0, breakdown: [`Bedframe size '${sizeId}' unavailable`] };
  }
  return {
    total: variant.price,
    breakdown: [`Bedframe · ${sizeId}: ${fmtSen(Math.round(variant.price * 100))}`],
  };
};

/* ─── Bedframe line description (printed SO / Backend PO sheet) ────── */

export type BedframeLineConfig = {
  kind: 'bedframe';
  productId: string;
  sizeId: string;
  /** Free-text special size (e.g. "200 x 200"). Display only — no structured price. */
  sizeOther?: string;
  colourId: string;
  colourLabel?: string | null;
  gapId?: string;
  legHeightId: string;
  divanHeightId?: string;
  totalHeightId?: string;
  specialIds?: string[];
  // Display-only label snapshots (mirrors the Zod schema). The recompute
  // ignores these; they ride along in configJson for the printed SO / Backend.
  gapLabel?: string | null;
  legHeightLabel?: string | null;
  divanHeightLabel?: string | null;
  totalHeightLabel?: string | null;
  specialLabels?: string[];
};

// The four standard bed sizes → display labels (sizeId is persisted, not the
// label). Falls back to a Title-cased id for any non-standard size.
const BEDFRAME_SIZE_LABELS: Record<string, string> = {
  single: 'Single', 'super-single': 'Super Single', queen: 'Queen', king: 'King',
};

/** Display-only spec line for a persisted bedframe order line, built from the
 *  label snapshots in configJson (no DB join). e.g.
 *  "Queen · Sand · Gap 6\" · Leg 4\" · Divan 8\" · Total 14\"". Used by the
 *  printed Sales Order + Backend PO sheet, mirroring describeSofaLine. */
export const describeBedframeLine = (cfg: Partial<BedframeLineConfig>): string => {
  const parts: string[] = [];
  if (cfg.sizeId) {
    const lbl = BEDFRAME_SIZE_LABELS[cfg.sizeId] ?? (cfg.sizeId.charAt(0).toUpperCase() + cfg.sizeId.slice(1));
    parts.push(cfg.sizeOther ? `${lbl} (${cfg.sizeOther})` : lbl);
  } else if (cfg.sizeOther) {
    parts.push(cfg.sizeOther);
  }
  if (cfg.colourLabel) parts.push(cfg.colourLabel);
  if (cfg.gapLabel) parts.push(`Gap ${cfg.gapLabel}`);
  if (cfg.legHeightLabel) parts.push(`Leg ${cfg.legHeightLabel}`);
  if (cfg.divanHeightLabel) parts.push(`Divan ${cfg.divanHeightLabel}`);
  if (cfg.totalHeightLabel) parts.push(`Total ${cfg.totalHeightLabel}`);
  if (cfg.specialLabels && cfg.specialLabels.length > 0) parts.push(cfg.specialLabels.join(' + '));
  return parts.join(' · ');
};

/* ─── Delivery fee (migration 0029) ────────────────────────────────── */

export interface DeliveryFeeConfig {
  baseFee:          number;
  crossCategoryFee: number;
}

/* ─── SO delivery fee — special models + cross-order link (2026-06-02) ─────
 *
 * THE delivery-fee recompute on the LIVE `/mfg-sales-orders` path (the legacy
 * computeDeliveryFee it superseded was deleted with the /orders route,
 * 2026-06-12). Adds two Chairman rules on top of base + cross-category:
 *   1. SPECIAL MODELS — a model flagged with a special transport fee (e.g. a
 *      full-latex mattress at RM 500) OVERRIDES the normal base. Highest
 *      standalone fee wins; two latex still bill ONE base (max, never summed).
 *   2. CROSS-ORDER LINK — when sales links THIS SO back to the customer's
 *      earlier SO (mattress + sofa must split into 2 SOs), the customer already
 *      paid a full base on SO #1, so this SO owes only the reduced cross rate
 *      (175), or the special model's "cross-category follow-up fee" (e.g. 300).
 *
 * Pure (honest-pricing red line): the server gathers the inputs and calls this;
 * no client-sent fee total is ever trusted. See the design doc
 * docs/superpowers/specs/2026-06-02-delivery-fee-special-and-crossorder-design.md
 */

/* Cross-category rule (Loo 2026-06-12): mattress + bedframe count as ONE
 * delivery category — the bedroom set travels together. Only sofa mixed with
 * a mattress and/or bedframe trips the surcharge; mattress + bedframe alone
 * does NOT. Keys are the lowercase item_groups both callers already send. */
const tripsCrossCategory = (categories: ReadonlySet<string>): boolean =>
  categories.has('sofa') && (categories.has('mattress') || categories.has('bedframe'));

export interface SpecialModelDeliveryFee {
  /** Standalone special transport fee (e.g. RM 500). Replaces the normal base
   *  when any special model is in the cart; highest wins. */
  standaloneFee: number;
  /** Reduced fee when THIS SO is a cross-category follow-up linked to an earlier
   *  SO (e.g. RM 300). Falls back to config.crossCategoryFee when 0/unset. */
  crossCategoryFollowupFee: number;
}

export interface SoDeliveryFeeInput {
  /** Distinct DELIVERABLE category keys in the cart (sofa / mattress / bedframe).
   *  Duplicates + empties ignored. The caller excludes accessories / others —
   *  they don't trip cross-category delivery. Mattress + bedframe count as one
   *  category: only sofa × (mattress|bedframe) trips the surcharge. */
  categoryIds: string[];
  /** One entry per SPECIAL model present in the cart. Empty when none. */
  specialModels: SpecialModelDeliveryFee[];
  /** True when sales linked THIS SO to the customer's earlier SO as a
   *  cross-category follow-up (base already paid on the first SO). */
  isCrossCategoryFollowup: boolean;
  /** Free-form fee keyed by POS sales at handover. Negative clamped to 0. */
  additionalFee: number;
}

export interface SoDeliveryFeeResult {
  /** The (possibly special / possibly follow-up) base portion. */
  base:          number;
  /** In-order cross-category surcharge (0 on a follow-up SO — the link IS the
   *  cross). */
  crossCategory: number;
  /** Free-form operator fee. */
  additional:    number;
  /** base + crossCategory + additional. */
  total:         number;
  /** A special model drove the base (for display / audit). */
  isSpecial:     boolean;
  /** The cross-order follow-up rate applied. */
  isFollowup:    boolean;
}

export const computeSoDeliveryFee = (
  input:  SoDeliveryFeeInput,
  config: DeliveryFeeConfig,
): SoDeliveryFeeResult => {
  const categories = new Set(
    input.categoryIds.filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase()),
  );
  const additional = Math.max(0, input.additionalFee);
  const specials   = input.specialModels ?? [];
  const hasSpecial = specials.length > 0;

  // Empty cart with no special model → only the free-form fee, if any.
  if (categories.size === 0 && !hasSpecial) {
    return { base: 0, crossCategory: 0, additional, total: additional, isSpecial: false, isFollowup: false };
  }

  if (input.isCrossCategoryFollowup) {
    // Linked 2nd SO — full base already paid on SO #1. Charge only the cross
    // portion: the special follow-up fee (highest) if a special model is here
    // and one is configured, else the normal cross-category rate.
    let base = config.crossCategoryFee;
    if (hasSpecial) {
      const specialFollowup = Math.max(...specials.map((s) => Math.max(0, s.crossCategoryFollowupFee)));
      if (specialFollowup > 0) base = specialFollowup;
    }
    return { base, crossCategory: 0, additional, total: base + additional, isSpecial: hasSpecial, isFollowup: true };
  }

  // Standalone / first SO. Special standalone fee (highest) overrides the normal
  // base; the in-order cross-category surcharge stacks only when sofa shares
  // the cart with a mattress / bedframe (mattress + bedframe = one category).
  let base = config.baseFee;
  if (hasSpecial) {
    const specialStandalone = Math.max(...specials.map((s) => Math.max(0, s.standaloneFee)));
    if (specialStandalone > 0) base = specialStandalone;
  }
  const crossCategory = tripsCrossCategory(categories) ? config.crossCategoryFee : 0;
  return { base, crossCategory, additional, total: base + crossCategory + additional, isSpecial: hasSpecial, isFollowup: false };
};
