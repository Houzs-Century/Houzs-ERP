import type { FabricTierModelOverride } from './fabric-tier-addon';
import { normalizeCompartmentCode } from './sofa-build';

const maxOrNull = (vals: Array<number | null | undefined>): number | null => {
  const set = vals.filter((v): v is number => v !== null && v !== undefined);
  return set.length ? Math.max(...set) : null;
};

/**
 * Effective fabric-tier Δ override for a sofa line (migration 0025). Per tier,
 * the result is the MAX over the SET special values: the Model override and
 * every compartment override whose code is in the build's cells. Null tier (no
 * special set) → fabricTierAddon falls back to the global Δ. "Take the highest":
 * 0 (free) only wins when nothing pricier is set. Returns null when no special
 * applies at all.
 */
export function resolveFabricTierOverride(
  buildCompartments: string[],
  modelOverride: FabricTierModelOverride | null,
  compartmentOverrides: Map<string, FabricTierModelOverride>,
): FabricTierModelOverride | null {
  const compMatches: FabricTierModelOverride[] = [];
  for (const c of buildCompartments) {
    if (!c) continue;
    const ovr = compartmentOverrides.get(normalizeCompartmentCode(c));
    if (ovr) compMatches.push(ovr);
  }
  if (!modelOverride && compMatches.length === 0) return null;
  const tier2Delta = maxOrNull([modelOverride?.tier2Delta, ...compMatches.map((o) => o.tier2Delta)]);
  const tier3Delta = maxOrNull([modelOverride?.tier3Delta, ...compMatches.map((o) => o.tier3Delta)]);
  if (tier2Delta === null && tier3Delta === null) return null;
  return { tier2Delta, tier3Delta };
}
