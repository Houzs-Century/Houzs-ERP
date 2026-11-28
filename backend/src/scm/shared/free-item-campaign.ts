import { lineMatchesTargets, parseRuleTargets, type RuleTarget } from './rule-target';

/** A campaign eligibility entry is a unified RuleTarget. Kept as an alias so the
 *  old name still resolves for existing importers. */
export type FreeItemEligibility = RuleTarget;

export interface FreeItemCampaign {
  id: string;
  name: string;
  active: boolean;
  maxFreeQty: number;
  eligible: RuleTarget[];
}

/** One cart/order line flattened to what the matcher needs. */
export interface FreeItemLineInput {
  category: string;
  modelId: string | null;
  sizeCode: string | null;
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
  return campaigns.filter(
    (c) => c.active && c.eligible.length > 0 && lineMatchesTargets(li, c.eligible, comboModulesById),
  );
}
