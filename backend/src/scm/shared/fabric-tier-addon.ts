// The SOLE source of truth for the POS selling fabric-tier add-on. Pure — no I/O.
// POST /mfg-sales-orders (server recompute) and the POS configurator import THIS
// same function so the figure cannot drift. Returns WHOLE MYR for ONE configured
// item; callers multiply by qty and convert to the order's unit (×100 for *_centi).
// COST is unaffected: this is selling-only.

export type FabricTier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3';
export type FabricAddonCategory = 'SOFA' | 'BEDFRAME';

export interface FabricTierAddonConfig {
  sofaTier2Delta:     number; // whole MYR
  sofaTier3Delta:     number;
  bedframeTier2Delta: number;
  bedframeTier3Delta: number;
}

/** Per-Model override of the tier Δ (migration 0172). A value REPLACES the
 *  global Δ for that tier on that Model; null = inherit the global standard. An
 *  explicit 0 = free upgrade for that Model (distinct from null). The Model's
 *  category decides which global value the null-inherit falls back to. */
export interface FabricTierModelOverride {
  tier2Delta: number | null;
  tier3Delta: number | null;
}

/** Flat selling add-on (whole MYR) for ONE configured item, from its fabric's
 *  per-context tier. PRICE_1 / null / undefined → 0. Negative config → 0. When
 *  `override` is given, its non-null tier value REPLACES the global; null/absent
 *  inherits the global (back-compatible — omitting `override` is the old fn). */
export const fabricTierAddon = (
  category: FabricAddonCategory,
  tier: FabricTier | null | undefined,
  config: FabricTierAddonConfig,
  override?: FabricTierModelOverride | null,
): number => {
  const clamp = (n: number) => Math.max(0, Math.trunc(n));
  const pick = (ovr: number | null | undefined, glob: number) =>
    (ovr === null || ovr === undefined) ? clamp(glob) : clamp(ovr);
  if (category === 'SOFA') {
    if (tier === 'PRICE_2') return pick(override?.tier2Delta, config.sofaTier2Delta);
    if (tier === 'PRICE_3') return pick(override?.tier3Delta, config.sofaTier3Delta);
    return 0;
  }
  if (category === 'BEDFRAME') {
    if (tier === 'PRICE_2') return pick(override?.tier2Delta, config.bedframeTier2Delta);
    if (tier === 'PRICE_3') return pick(override?.tier3Delta, config.bedframeTier3Delta);
    return 0;
  }
  return 0;
};
