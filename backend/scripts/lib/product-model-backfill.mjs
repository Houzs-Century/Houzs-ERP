// Which model-less SKUs the Modular backfill links to a Model, and how.
//
// Every category is in scope. The first run kept to the flat categories on the
// belief that SOFA / BEDFRAME / MATTRESS were all modelled by the align seed, but
// a bedframe the seed did not list (CROWN (SS+S), BUG-31) stayed model-less and
// so never showed in Modular. One-shot mints are per-order specials, not
// catalogue products, and stay out.
//
// Keyed with modelCodeForSku, the rule the create routes use, so a variant SKU
// links to its base_model's model and a flat one becomes its own 1:1 model.

import { modelCodeForSku } from '../../src/scm/lib/ensure-model-for-sku.ts';

/** @param {{ model_id: string | null, one_shot: boolean | null }} sku */
export function isModelBackfillTarget(sku) {
  return sku.model_id == null && sku.one_shot !== true;
}

/**
 * @param {Array<{ id: string, code: string, category: string, base_model: string | null, model_id: string | null, one_shot: boolean | null }>} skus
 * @param {Array<{ model_code: string, category: string }>} existingModels  the company's product_models
 * @returns {Array<{ id: string, code: string, category: string, modelCode: string, action: 'link' | 'create' }>}
 */
export function planModelBackfill(skus, existingModels) {
  const have = new Set(existingModels.map((m) => `${m.category}\u0000${m.model_code}`));
  const plan = [];
  for (const sku of skus) {
    if (!isModelBackfillTarget(sku)) continue;
    const modelCode = modelCodeForSku(sku.base_model, sku.code);
    const key = `${sku.category}\u0000${modelCode}`;
    // A second SKU of the same new model links to the one the first creates.
    plan.push({ id: sku.id, code: sku.code, category: sku.category, modelCode, action: have.has(key) ? 'link' : 'create' });
    have.add(key);
  }
  return plan;
}
