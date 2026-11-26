
import type { Cell, Depth, SofaPriceResult, SofaProductPricing } from './sofa-build';
import { fmtSen } from './format';


export type SofaCell = Cell;
export type SofaDepth = Depth;
export type { SofaProductPricing, SofaPriceResult };


export interface MattressPricing {
  variants: { sizeId: string; price: number; active: boolean }[];
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


export type BedframeLineConfig = {
  kind: 'bedframe';
  productId: string;
  sizeId: string;
  sizeOther?: string;
  colourId: string;
  colourLabel?: string | null;
  gapId?: string;
  legHeightId: string;
  divanHeightId?: string;
  totalHeightId?: string;
  specialIds?: string[];
  gapLabel?: string | null;
  legHeightLabel?: string | null;
  divanHeightLabel?: string | null;
  totalHeightLabel?: string | null;
  specialLabels?: string[];
};

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


export interface DeliveryFeeConfig {
  baseFee:          number;
  crossCategoryFee: number;
}


const tripsCrossCategory = (categories: ReadonlySet<string>): boolean =>
  categories.has('sofa') && (categories.has('mattress') || categories.has('bedframe'));

export interface SpecialModelDeliveryFee {
  standaloneFee: number;
  crossCategoryFollowupFee: number;
}

export interface SoDeliveryFeeInput {
  categoryIds: string[];
  specialModels: SpecialModelDeliveryFee[];
  isCrossCategoryFollowup: boolean;
  additionalFee: number;
}

export interface SoDeliveryFeeResult {
  base:          number;
  crossCategory: number;
  additional:    number;
  total:         number;
  isSpecial:     boolean;
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

  if (categories.size === 0 && !hasSpecial) {
    return { base: 0, crossCategory: 0, additional, total: additional, isSpecial: false, isFollowup: false };
  }

  if (input.isCrossCategoryFollowup) {
    let base = config.crossCategoryFee;
    if (hasSpecial) {
      const specialFollowup = Math.max(...specials.map((s) => Math.max(0, s.crossCategoryFollowupFee)));
      if (specialFollowup > 0) base = specialFollowup;
    }
    return { base, crossCategory: 0, additional, total: base + additional, isSpecial: hasSpecial, isFollowup: true };
  }

  let base = config.baseFee;
  if (hasSpecial) {
    const specialStandalone = Math.max(...specials.map((s) => Math.max(0, s.standaloneFee)));
    if (specialStandalone > 0) base = specialStandalone;
  }
  const crossCategory = tripsCrossCategory(categories) ? config.crossCategoryFee : 0;
  return { base, crossCategory, additional, total: base + crossCategory + additional, isSpecial: hasSpecial, isFollowup: false };
};
