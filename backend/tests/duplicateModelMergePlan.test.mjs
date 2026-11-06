/* The planner behind merge-duplicate-models.mjs (HC-0202: one mattress family
 * under two or three Product Models). The ruling file is pinned here too, so a
 * group cannot name the same Model twice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planModelGroup, planIdleModel, sizeOf, confirmPhrase } from '../scripts/lib/duplicate-model-merge-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'scripts', 'data', 'duplicate-model-merges.json'), 'utf8'));

const model = (id, code, over = {}) => ({ id, model_code: code, category: 'MATTRESS', active: true, allowed_options: { sizes: ['K', 'Q'] }, ...over });
const sku = (code, modelId, over = {}) => ({
  id: `s-${code}`, code, status: 'ACTIVE', size_code: null, model_id: modelId, base_model: null,
  main: null, use: { lines: 0, stock: 0, openSo: 0 }, master: { base_price_sen: 0, cost_price_sen: null }, ...over,
});
const group = { category: 'MATTRESS', keep: 'COOLSILK 2.0 VISCO BLISS', drops: ['CS2 VISCO BLISS'] };
const models = [model('m-keep', 'COOLSILK 2.0 VISCO BLISS'), model('m-fold', 'CS2 VISCO BLISS', { allowed_options: { sizes: ['K', 'SS'] } })];

describe('planModelGroup', () => {
  it('moves a size only the folded Model has and merges a size both have', () => {
    const p = planModelGroup({
      group, models,
      skus: [
        sku('DUNLOPILLO COOLSILK 2.0 VISCO BLISS MATT (K)', 'm-keep', { main: '400-D001' }),
        sku('DUNLOPILLO CS2 VISCO BLISS MATT (K)', 'm-fold'),
        sku('DUNLOPILLO CS2 VISCO BLISS MATT (SS)', 'm-fold'),
      ],
    });
    expect(p.refusals).toEqual([]);
    expect(p.pairs).toEqual([{ drop: 'DUNLOPILLO CS2 VISCO BLISS MATT (K)', keep: 'DUNLOPILLO COOLSILK 2.0 VISCO BLISS MATT (K)', size: 'K' }]);
    expect(p.moves.map((m) => m.code)).toEqual(['DUNLOPILLO CS2 VISCO BLISS MATT (SS)']);
    expect(p.addSizes).toEqual(['SS']);
    expect(p.foldModels).toEqual([{ id: 'm-fold', code: 'CS2 VISCO BLISS' }]);
  });

  it('keeps the used, supplied code of a size and gives it nothing it already has', () => {
    const p = planModelGroup({
      group, models,
      skus: [
        sku('KEEP-SIDE (K)', 'm-keep'),
        sku('FOLD-SIDE (K)', 'm-fold', { main: '400-D001', use: { lines: 4, stock: 2, openSo: 1 }, master: { base_price_sen: 100 } }),
      ],
    });
    expect(p.pairs).toEqual([{ drop: 'KEEP-SIDE (K)', keep: 'FOLD-SIDE (K)', size: 'K' }]);
    expect(p.moves.map((m) => m.code)).toEqual(['FOLD-SIDE (K)']);
    expect(p.fills).toEqual([]);
  });

  it('never keeps a misspelt or placeholder code over a clean twin, and fills it from the absorbed one', () => {
    const p = planModelGroup({
      group: { category: 'MATTRESS', keep: 'RELAX SLEEP LUXURY', drops: ['RELAX SLEEP LUXURTY'] },
      models: [model('m-keep', 'RELAX SLEEP LUXURY'), model('m-fold', 'RELAX SLEEP LUXURTY')],
      skus: [
        sku('DUNLOPILLO RELAX SLEEP LUXURY MATT (K)', 'm-keep'),
        sku('DUNLOPILLO RELAX SLEEP LUXURTY MATT (K)', 'm-fold', { main: '400-D001', use: { lines: 2, stock: 0, openSo: 2 }, master: { base_price_sen: 900, cost_price_sen: 500 } }),
      ],
    });
    expect(p.pairs[0].keep).toBe('DUNLOPILLO RELAX SLEEP LUXURY MATT (K)');
    expect(p.fills.map((f) => f.field)).toEqual(['main supplier', 'base_price_sen', 'cost_price_sen']);
  });

  it('refuses the whole group when twins of a size are bound to different main suppliers', () => {
    const p = planModelGroup({
      group, models,
      skus: [sku('A (K)', 'm-keep', { main: '400-D001' }), sku('B (K)', 'm-fold', { main: '400-E001' })],
    });
    expect(p.refusals[0]).toMatch(/different main suppliers/);
    expect(p.pairs).toEqual([]);
    expect(p.foldModels).toEqual([]);
  });

  it('creates the named Model for a group with no kept one', () => {
    const p = planModelGroup({
      group: { category: 'MATTRESS', keep: null, newModel: 'DREAM VALLEY', drops: ['DV (Q)', 'DV (K)'] },
      models: [model('m1', 'DV (Q)', { allowed_options: {} }), model('m2', 'DV (K)', { allowed_options: {} })],
      skus: [sku('DV (Q)', 'm1'), sku('DV (K)', 'm2')],
    });
    expect(p.createModel.code).toBe('DREAM VALLEY');
    expect(p.moves.map((m) => [m.size, m.setSizeCode])).toEqual([['K', true], ['Q', true]]);
    expect(p.addSizes).toEqual(['K', 'Q']);
  });

  it('leaves INACTIVE SKUs where they are', () => {
    const p = planModelGroup({ group, models, skus: [sku('OLD (K)', 'm-fold', { status: 'INACTIVE' })] });
    expect(p.leftInactive).toEqual(['OLD (K)']);
    expect(p.moves).toEqual([]);
  });
});

describe('planIdleModel', () => {
  const m = [model('m1', 'ZEN', { category: 'BEDFRAME' })];
  it('switches off a Model with no stock and no open sales-order line', () => {
    const p = planIdleModel({ entry: { category: 'BEDFRAME', model: 'ZEN' }, models: m, skus: [sku('ZEN-(K)', 'm1')] });
    expect(p.modelId).toBe('m1');
    expect(p.skuCodes).toEqual(['ZEN-(K)']);
  });
  it('keeps it on while a unit is in stock', () => {
    const p = planIdleModel({ entry: { category: 'BEDFRAME', model: 'ZEN' }, models: m, skus: [sku('ZEN-(K)', 'm1', { use: { lines: 0, stock: 1, openSo: 0 } })] });
    expect(p.refusals).toEqual(['1 unit(s) in stock']);
    expect(p.skuIds).toEqual([]);
  });
});

describe('twins with different main suppliers', () => {
  const twins = [
    sku('DUNLOPILLO COOLSILK 2.0 VISCO BLISS MATT (K)', 'm-keep', { main: '400-D001' }),
    sku('DUNLOPILLO CS2 VISCO BLISS MATT (K)', 'm-fold', { main: '400-E001' }),
  ];
  it('are refused until the owner rules they are one product', () => {
    expect(planModelGroup({ group, models, skus: twins }).refusals).toHaveLength(1);
    const ruled = planModelGroup({ group: { ...group, ruledOneProduct: true }, models, skus: twins });
    expect(ruled.refusals).toEqual([]);
    expect(ruled.pairs).toHaveLength(1);
  });
});

describe('ruling file', () => {
  it('names no Model twice and reads its size from a code ending in "(K" too', () => {
    for (const e of Object.values(BOOK)) {
      const codes = [...e.groups.flatMap((g) => [g.keep, ...g.drops].filter(Boolean)), ...(e.deactivateIfIdle ?? []).map((x) => x.model)];
      expect(new Set(codes).size).toBe(codes.length);
    }
    expect(sizeOf({ code: 'DL-CS2 NN-WINTER DREAM MATT (K', size_code: null })).toBe('K');
    expect(confirmPhrase({ groups: 1, pairs: 2, moves: 3, fills: 4, folds: 5, idleModels: 6, idleSkus: 7 })).toBe('MERGE 1 MODELS: 2 SKU MERGES, MOVE 3 SKUS, FILL 4, FOLD 5, IDLE OFF 6/7');
  });
});

describe('HC-0208 KŌRI IYASH -> KŌRI IYASHI', () => {
  it('keeps the IYASHI code even when the IYASH twin has the supplier and the use', () => {
    const p = planModelGroup({
      group: BOOK['HC-0208'].groups[0],
      models: [model('m-keep', 'KŌRI IYASHI'), model('m-fold', 'KŌRI IYASH')],
      skus: [
        sku('AKEMI KŌRI IYASHI MATT (K)', 'm-keep'),
        sku('AKEMI KŌRI IYASH MATT (K)', 'm-fold', { main: '400-A002', use: { lines: 3, stock: 1, openSo: 1 } }),
      ],
    });
    expect(p.refusals).toEqual([]);
    expect(p.pairs).toEqual([{ drop: 'AKEMI KŌRI IYASH MATT (K)', keep: 'AKEMI KŌRI IYASHI MATT (K)', size: 'K' }]);
    expect(p.foldModels).toEqual([{ id: 'm-fold', code: 'KŌRI IYASH' }]);
  });
});
