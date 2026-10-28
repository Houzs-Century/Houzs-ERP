// Free Item Campaign (standalone giveaway, no qualifying purchase). Pure,
// shared by the POS cart "Make free" button and the server SO validator so the
// two NEVER drift (honest-pricing). A campaign lists eligible targets; each
// target is a Model + scope (model / variant / combo / compartment) — see
// rule-target.ts (the unified matcher). Ported from 2990 (#691, Wave 1).
import { lineMatchesTargets, parseRuleTargets, type RuleTarget } from './rule-target';

/** A campaign eligibility entry is a unified RuleTarget. Kept as an alias so the
 *  old name still resolves for existing importers. */
export type FreeItemEligibility = RuleTarget;

export interface FreeItemCampaign {
  id: string;
  name: string;
  active: boolean;
  /** per-line max free units (>= 1). */
  maxFreeQty: number;
  eligible: RuleTarget[];
}

/** One cart/order line flattened to what the matcher needs. */
export interface FreeItemLineInput {
  /** SOFA / MATTRESS / BEDFRAME / ACCESSORY (case-insensitive). */
  category: string;
  /** product_models.id of the line's Model (null = no match possible). */
  modelId: string | null;
  /** mfg_products.size_code for mattress/bedframe (UPPERCASE); null otherwise. */
  sizeCode: string | null;
  /** sofa build module codes (normalized later); [] for non-sofa. */
  builtModuleIds: string[];
}

/** Coerce raw jsonb into clean RuleTarget[] (drops malformed entries; reads a
 *  legacy single `comboId` as `comboIds:[id]`). */
export function parseFreeItemEligible(raw: unknown): RuleTarget[] {
  return parseRuleTargets(raw);
}

/** A persisted line carries a free-item marker iff variants.freeItem.campaignId is set. */
export function isFreeItemLine(variants: unknown): boolean {
  const v = variants as { freeItem?: { campaignId?: unknown } } | null;
  return Boolean(v?.freeItem && typeof v.freeItem === 'object' && v.freeItem.campaignId);
}

/** Every ACTIVE campaign that covers this line, via the unified matcher. Returns
 *  all covering campaigns so the cart can let the salesperson pick (D4). */
export function campaignsCoveringLine(
  line: FreeItemLineInput,
  campaigns: FreeItemCampaign[],
  comboModulesById: Map<string, string[][]>,
): FreeItemCampaign[] {
  if (!line.modelId) return [];
  const li = {
    category: line.category,
    modelId: line.modelId,
    sizeCode: line.sizeCode,
    builtCompartments: line.builtModuleIds,
  };
  // A Free Item Campaign must list explicit targets — an EMPTY eligible covers
  // NOTHING (mirrors the original `eligible.some()`, where [].some() === false).
  // The matcher's "empty = all of category" is a PWP-only semantic (PWP carries
  // a trigger/reward category to scope it); applying it here would make every
  // Model in every category free-eligible. Guard before delegating.
  return campaigns.filter(
    (c) => c.active && c.eligible.length > 0 && lineMatchesTargets(li, c.eligible, comboModulesById),
  );
}
