// ----------------------------------------------------------------------------
// compartments-from-module-lines — reconstruct a custom sofa build's compartment
// codes from its persisted, split per-module SO lines (migration 0025).
//
// A custom sofa SO line is SPLIT into one row per module at create time, and
// those rows STRIP `variants.cells` (they keep only buildKey/cellIndex/x/y/rot +
// an item_code like `ANNSA-1A(LHF)`). So the only place the build's compartment
// vocabulary survives on a persisted build is the per-module item_code suffix.
//
// `splitSofaCode(item_code).sizeCode` yields the compartment code (`1A(LHF)`,
// `CNR`, …). A non-sofa row (mattress / bedframe / accessory) has no `-suffix`
// module token → it contributes nothing. The returned codes feed the shared
// `resolveFabricTierOverride(buildCompartments, modelOverride, compartmentMap)`
// so the tbc-update path resolves the SAME per-compartment fabric Δ the create
// path billed — never model-only (which under-charges a build that carries a
// per-compartment override on `variants.cells` it no longer persists).
// ----------------------------------------------------------------------------

import { splitSofaCode } from '../shared';

export interface ModuleLineRow {
  item_code: string;
  /** The build this module belongs to (variants.buildKey). */
  buildKey: string | null | undefined;
}

/**
 * Compartment codes for ONE sofa build, reconstructed from its split module
 * lines. Pass the rows that share `targetBuildKey` (or all rows + the key — we
 * filter). Returns e.g. `['1A(LHF)','CNR']`; rows whose item_code has no sofa
 * module suffix (a bare model, a mattress, …) are excluded → can be `[]`.
 * Order follows input order; duplicates are preserved (the resolver de-dups by
 * MAX, so duplicates are harmless).
 */
export function buildCompartmentsFromModuleLines(
  rows: ModuleLineRow[],
  targetBuildKey?: string | null,
): string[] {
  const want = targetBuildKey != null ? String(targetBuildKey) : null;
  const out: string[] = [];
  for (const r of rows) {
    if (want !== null && String(r.buildKey ?? '') !== want) continue;
    const code = splitSofaCode(String(r.item_code ?? '')).sizeCode;
    if (code) out.push(code);
  }
  return out;
}
