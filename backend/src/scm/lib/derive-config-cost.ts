// ─────────────────────────────────────────────────────────────────────────
// derive-config-cost.ts — the specials/legs/height/gap cost derivation
// (auto-derive stage 5, owner Option 1: COST-ONLY). Pure: NO db, NO io.
//
// The SO cost path (computeMfgLineCost) reads the MASTER maintenance_config's
// `priceSen` surcharges (divan / leg / total-height / specials / sofa-leg /
// sofa-specials). Owner 2026-09-16: those cost benchmarks auto-derive from the
// MOST EXPENSIVE supplier — so this takes, per priced-pool entry (keyed by
// `value`), the MAX `priceSen` across every supplier scope's config.
//
// COST-ONLY, and that is load-bearing: `sellingPriceSen` (the Sales-Director
// buyer price) is NEVER touched — the master keeps its own selling values, and
// a supplier-only entry is added with a cost but no selling. The two unpriced
// pools (`gaps`, `sofaSizes`) are copied from the master unchanged. This mirrors
// the SKU rule (product cost = max supplier) without disturbing any buyer price.
// ─────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- the config pools
   come from a jsonb column (maintenance_config_history.config); the declared
   type says every field is present, but a stored/hand-edited row is not
   guaranteed to be, so the runtime guards below are deliberate, not redundant. */
import type { MaintenanceConfig, MfgPricedOption } from '../shared/mfg-pricing';

/** The priced pools whose `priceSen` this derivation maxes over suppliers. The
 *  unpriced pools (gaps, sofaSizes) are not listed and are copied verbatim. */
const PRICED_POOLS = [
  'divanHeights', 'legHeights', 'totalHeights', 'specials', 'sofaLegHeights', 'sofaSpecials',
] as const;

const emptyConfig = (): MaintenanceConfig => ({
  divanHeights: [], legHeights: [], totalHeights: [], gaps: [],
  specials: [], sofaLegHeights: [], sofaSpecials: [], sofaSizes: [],
});

/** Deep-clone a config (plain JSON data) so the derivation never mutates input. */
function clone(cfg: MaintenanceConfig): MaintenanceConfig {
  return JSON.parse(JSON.stringify(cfg)) as MaintenanceConfig;
}

/**
 * Master config with every priced-pool `priceSen` raised to the most-expensive
 * supplier's value, preserving all `sellingPriceSen` (and `active`, labels).
 *
 * Starts from the master (so its selling values and any master-only entries
 * survive); for each supplier config, an entry present in the master takes the
 * MAX cost (selling untouched), and an entry only a supplier has is added
 * COST-ONLY. No supplier config -> the master is returned unchanged.
 */
export function deriveMasterConfigCostFromSuppliers(
  master: MaintenanceConfig | null,
  supplierConfigs: readonly MaintenanceConfig[],
): MaintenanceConfig {
  const base = master ? clone(master) : emptyConfig();
  if (!supplierConfigs || supplierConfigs.length === 0) return base;

  for (const pool of PRICED_POOLS) {
    const byValue = new Map<string, MfgPricedOption>();
    for (const e of base[pool] ?? []) {
      if (e && typeof e.value === 'string') byValue.set(e.value, { ...e });
    }
    for (const sc of supplierConfigs) {
      for (const se of sc[pool] ?? []) {
        if (!se || typeof se.value !== 'string') continue;
        const supCost = Number(se.priceSen ?? 0);
        if (!Number.isFinite(supCost)) continue;
        const cur = byValue.get(se.value);
        if (cur) {
          // Max the COST only; keep the master's sellingPriceSen / active / label.
          if (supCost > Number(cur.priceSen ?? 0)) cur.priceSen = supCost;
        } else {
          // A pool entry only a supplier has: add it cost-only (no selling).
          byValue.set(se.value, { value: se.value, priceSen: supCost });
        }
      }
    }
    base[pool] = [...byValue.values()];
  }
  return base;
}

/** True when the derived config's COST side differs from `current` (a
 *  master-config write is worth appending only then). Compares the priced
 *  pools' (value -> priceSen) maps; ignores selling and the unpriced pools. */
export function configCostChanged(current: MaintenanceConfig | null, derived: MaintenanceConfig): boolean {
  if (!current) return true;
  const costMap = (cfg: MaintenanceConfig, pool: (typeof PRICED_POOLS)[number]) => {
    const m: Record<string, number> = {};
    for (const e of cfg[pool] ?? []) {
      if (e && typeof e.value === 'string') m[e.value] = Number(e.priceSen ?? 0);
    }
    return m;
  };
  for (const pool of PRICED_POOLS) {
    if (JSON.stringify(costMap(current, pool)) !== JSON.stringify(costMap(derived, pool))) return true;
  }
  return false;
}
