/* BUG-31 — a model-less BEDFRAME SKU (CROWN (SS+S)) never showed in Modular,
   because the Modular backfill only covered the flat categories. Pinned:
     · a model-less SKU of ANY category is a target, variant categories included;
     · a SKU that already has a model, or a one-shot mint, is not;
     · a variant SKU links to its base_model's model, a flat one to its own code;
     · "link" when the model exists, "create" once, then "link" for its siblings. */

import { describe, expect, test } from 'vitest';
import { isModelBackfillTarget, planModelBackfill } from '../scripts/lib/product-model-backfill.mjs';

const sku = (over: Record<string, unknown>) => ({
  id: 'mfg-1', code: 'X', category: 'ACCESSORY', base_model: null, model_id: null, one_shot: false, ...over,
});

describe('Modular backfill target rule', () => {
  test('a model-less bedframe, sofa and mattress are targets', () => {
    for (const category of ['BEDFRAME', 'SOFA', 'MATTRESS', 'ACCESSORY']) {
      expect(isModelBackfillTarget(sku({ category }))).toBe(true);
    }
  });

  test('a linked SKU and a one-shot mint are not', () => {
    expect(isModelBackfillTarget(sku({ model_id: 'm-1' }))).toBe(false);
    expect(isModelBackfillTarget(sku({ one_shot: true }))).toBe(false);
    expect(isModelBackfillTarget(sku({ one_shot: null }))).toBe(true);
  });
});

describe('planModelBackfill', () => {
  test('CROWN (SS+S) with no base_model becomes its own bedframe model', () => {
    const plan = planModelBackfill([sku({ id: 'mfg-crown', code: 'CROWN (SS+S)', category: 'BEDFRAME' })], []);
    expect(plan).toEqual([{ id: 'mfg-crown', code: 'CROWN (SS+S)', category: 'BEDFRAME', modelCode: 'CROWN (SS+S)', action: 'create' }]);
  });

  test('a variant SKU links to the existing model of its base_model, same category only', () => {
    const plan = planModelBackfill(
      [sku({ code: 'B25-(Q)', category: 'BEDFRAME', base_model: 'B25' })],
      [{ model_code: 'B25', category: 'MATTRESS' }, { model_code: 'B25', category: 'BEDFRAME' }],
    );
    expect(plan[0]).toMatchObject({ modelCode: 'B25', action: 'link' });
    expect(planModelBackfill([sku({ code: 'B25-(Q)', category: 'BEDFRAME', base_model: 'B25' })], [{ model_code: 'B25', category: 'MATTRESS' }])[0])
      .toMatchObject({ action: 'create' });
  });

  test('siblings of a new model: the first creates, the rest link', () => {
    const plan = planModelBackfill(
      [
        sku({ id: 'a', code: 'NEW-(K)', category: 'MATTRESS', base_model: 'NEW' }),
        sku({ id: 'b', code: 'NEW-(Q)', category: 'MATTRESS', base_model: 'NEW' }),
      ],
      [],
    );
    expect(plan.map((p: { action: string }) => p.action)).toEqual(['create', 'link']);
  });

  test('skips linked SKUs and one-shot mints', () => {
    const plan = planModelBackfill([sku({ model_id: 'm-1' }), sku({ one_shot: true }), sku({ id: 'keep' })], []);
    expect(plan.map((p: { id: string }) => p.id)).toEqual(['keep']);
  });
});
