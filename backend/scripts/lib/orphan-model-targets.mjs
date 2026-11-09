// Where a Model with no ACTIVE code should fold to, from the merge records only
// (merge-orphan-models.mjs). PURE: rows in, targets out.
//
// NO SHEBANG: tests/orphanModelTargets.test.mjs imports this module.

/**
 * @param {object} w
 * @param {Array<{id: string, model_code: string, category: string, codes: string[]}>} w.orphans
 * @param {Array<{drop: string, keep: string, source: string}>} w.skuMerges
 * @param {Array<{category: string, keep: string, drops: string[]}>} w.modelMerges
 * @param {Map<string, {model_code: string, category: string}>} w.keptModelOf  kept code -> the Model it sits under now
 */
export function orphanTargets({ orphans, skuMerges, modelMerges, keptModelOf }) {
  return orphans.map((o) => {
    const into = new Map();
    const codes = new Set(o.codes);
    for (const m of skuMerges) {
      if (!codes.has(m.drop)) continue;
      const k = keptModelOf.get(m.keep);
      if (k && k.model_code !== o.model_code) into.set(k.model_code, [...(into.get(k.model_code) ?? []), `${m.source} SKU merge`]);
    }
    for (const g of modelMerges) {
      if (g.category === o.category && g.drops.includes(o.model_code) && g.keep && g.keep !== o.model_code) {
        into.set(g.keep, [...(into.get(g.keep) ?? []), "Model merge ruling"]);
      }
    }
    const base = { modelId: o.id, model: o.model_code, category: o.category, codes: o.codes.length };
    const names = [...into.keys()];
    if (names.length === 1) return { ...base, into: names[0], evidence: [...new Set(into.get(names[0]))].join(" + "), reason: null };
    return { ...base, into: null, evidence: null, reason: names.length === 0 ? "no merge record names where its codes went" : `its codes went to more than one Model (${names.join(", ")})` };
  });
}
