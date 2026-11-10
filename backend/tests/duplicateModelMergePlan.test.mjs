/* The planner behind merge-duplicate-models.mjs (HC-0202: one mattress family
 * under two or three Product Models). The ruling file is pinned here too, so a
 * group cannot name the same Model twice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planModelGroup, planIdleModel, sizeOf, confirmPhrase, foldOnlyPlan, foldTargets } from '../scripts/lib/duplicate-model-merge-plan.mjs';

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
    expect(p.refusals.some((r) => /different main suppliers/.test(r))).toBe(true);
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

  it("moves a folded Model's INACTIVE SKUs under the kept Model too, and leaves the kept Model's own where they are", () => {
    const p = planModelGroup({ group, models, skus: [sku('OLD (K)', 'm-fold', { status: 'INACTIVE' }), sku('KEPT OLD (Q)', 'm-keep', { status: 'INACTIVE' })] });
    expect(p.inactiveMoves).toEqual([{ id: 's-OLD (K)', code: 'OLD (K)', fromModelId: 'm-fold' }]);
    expect(p.leftInactive).toEqual(['KEPT OLD (Q)']);
    expect(p.moves).toEqual([]);
  });

  it('folds a switched-off Model whose codes were all merged away, so it ends with none', () => {
    const offModels = [model('m-keep', 'AMIRA PREMIUM'), model('m-fold', 'AMIRA PREMUIM', { active: false })];
    const p = planModelGroup({
      group: { category: 'MATTRESS', keep: 'AMIRA PREMIUM', drops: ['AMIRA PREMUIM'] }, models: offModels,
      skus: [sku('AMIRA PREMIUM (K)', 'm-keep'), ...['K', 'Q', 'S', 'SS'].map((z) => sku(`AMIRA PREMUIM (${z})`, 'm-fold', { status: 'INACTIVE' }))],
    });
    expect(p.refusals).toEqual([]);
    expect(p.inactiveMoves.map((m) => m.code)).toEqual(['AMIRA PREMUIM (K)', 'AMIRA PREMUIM (Q)', 'AMIRA PREMUIM (S)', 'AMIRA PREMUIM (SS)']);
    expect(p.foldModels).toEqual([]);
  });

  it('never folds a Model whose merged-away INACTIVE code has a different supplier (owner rule 2026-11-10)', () => {
    const offModels = [model('m-keep', 'AMIRA PREMIUM'), model('m-fold', 'AMIRA PREMUIM', { active: false })];
    const p = planModelGroup({
      group: { category: 'MATTRESS', keep: 'AMIRA PREMIUM', drops: ['AMIRA PREMUIM'] }, models: offModels,
      skus: [sku('AMIRA PREMIUM (K)', 'm-keep', { main: '400-D001' }), sku('AMIRA PREMUIM (K)', 'm-fold', { status: 'INACTIVE', main: '400-E001' })],
    });
    expect(p.refusals).toEqual(['different supplier: Model "AMIRA PREMUIM" has switched-off codes supplied by 400-E001, "AMIRA PREMIUM" by 400-D001']);
    expect(p.inactiveMoves).toEqual([]);
    const v = foldOnlyPlan(p, true);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/^different supplier/);
  });

  it('refuses a fold whose ACTIVE code of a new size has a different supplier too', () => {
    const p = planModelGroup({ group, models, skus: [sku('A (K)', 'm-keep', { main: 'S1' }), sku('B (SS)', 'm-fold', { main: 'S2' })] });
    expect(p.moves).toEqual([]);
    expect(foldOnlyPlan(p, true).reason).toMatch(/^different supplier: /);
  });

  it('moves no INACTIVE SKU when the group is refused', () => {
    const p = planModelGroup({
      group, models,
      skus: [sku('A (K)', 'm-keep', { main: 'S1' }), sku('B (K)', 'm-fold', { main: 'S2' }), sku('OLD (Q)', 'm-fold', { status: 'INACTIVE' })],
    });
    expect(p.refusals.length).toBeGreaterThan(0);
    expect(p.inactiveMoves).toEqual([]);
    expect(p.leftInactive).toEqual(['OLD (Q)']);
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
    expect(planModelGroup({ group, models, skus: twins }).refusals.length).toBeGreaterThan(0);
    const ruled = planModelGroup({ group: { ...group, ruledOneProduct: true }, models, skus: twins });
    expect(ruled.refusals).toEqual([]);
    expect(ruled.pairs).toHaveLength(1);
  });
});

describe('Models of different suppliers (owner, 2026-11-10)', () => {
  it('are refused even when no size is on both sides', () => {
    const p = planModelGroup({
      group, models,
      skus: [sku('KEEP-SIDE (Q)', 'm-keep', { main: '400-D001' }), sku('FOLD-SIDE (K)', 'm-fold', { main: '400-D002' })],
    });
    expect(p.refusals).toHaveLength(1);
    expect(p.refusals[0]).toMatch(/different main suppliers .*400-D001 vs .*400-D002/);
    expect(p.moves).toEqual([]);
    expect(p.foldModels).toEqual([]);
  });

  it('still merge when one side has no main supplier yet', () => {
    const p = planModelGroup({
      group, models,
      skus: [sku('KEEP-SIDE (Q)', 'm-keep', { main: '400-D001' }), sku('FOLD-SIDE (K)', 'm-fold')],
    });
    expect(p.refusals).toEqual([]);
    expect(p.moves.map((m) => m.code)).toEqual(['FOLD-SIDE (K)']);
  });

  // An INACTIVE SKU used to stay where it was, so its supplier did not count. A
  // fold now moves it under the kept Model (option C), so it counts.
  it('count a folded Model\'s INACTIVE SKU, because the fold moves it', () => {
    const p = planModelGroup({
      group, models,
      skus: [sku('KEEP-SIDE (Q)', 'm-keep', { main: '400-D001' }), sku('OLD (K)', 'm-fold', { main: '400-D002', status: 'INACTIVE' })],
    });
    expect(p.refusals).toEqual(['different supplier: Model "CS2 VISCO BLISS" has switched-off codes supplied by 400-D002, "COOLSILK 2.0 VISCO BLISS" by 400-D001']);
    expect(p.inactiveMoves).toEqual([]);
  });

  it('but not one on the kept Model, which does not move', () => {
    const p = planModelGroup({
      group, models,
      skus: [sku('KEEP-SIDE (Q)', 'm-keep', { main: '400-D001' }), sku('KEEP OLD (K)', 'm-keep', { main: '400-D002', status: 'INACTIVE' })],
    });
    expect(p.refusals).toEqual([]);
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

describe('foldTargets (SKU merge -> Model fold)', () => {
  const cm = (rows) => new Map(rows.map(([code, model_id, model_code, status = 'ACTIVE']) => [code, { model_id, model_code, status }]));
  it('folds the dropped code\'s Model when the merge takes its last active code', () => {
    const t = foldTargets({
      pairs: [{ drop: 'P (K)', keep: 'M (K)' }],
      codeModels: cm([['P (K)', 'm-p', 'PREMUIM'], ['M (K)', 'm-m', 'PREMIUM']]),
      activeByModel: new Map([['m-p', 1], ['m-m', 3]]), retiring: new Set(['P (K)']),
    });
    expect(t).toEqual([{ fromModelId: 'm-p', from: 'PREMUIM', intoModelId: 'm-m', into: 'PREMIUM', fold: true, reason: null }]);
  });
  it('leaves a Model that still has an active code', () => {
    const [t] = foldTargets({
      pairs: [{ drop: 'P (K)', keep: 'M (K)' }],
      codeModels: cm([['P (K)', 'm-p', 'PREMUIM'], ['M (K)', 'm-m', 'PREMIUM']]),
      activeByModel: new Map([['m-p', 2]]), retiring: new Set(['P (K)']),
    });
    expect(t.fold).toBe(false);
    expect(t.reason).toBe('it still has 1 active code(s)');
  });
  it('after the merge (nothing retiring) reads the live count, and skips a merge inside one Model', () => {
    const codeModels = cm([['P (K)', 'm-p', 'PREMUIM', 'INACTIVE'], ['M (K)', 'm-m', 'PREMIUM'], ['M (Q)', 'm-m', 'PREMIUM']]);
    expect(foldTargets({ pairs: [{ drop: 'P (K)', keep: 'M (K)' }], codeModels, activeByModel: new Map(), retiring: new Set() })[0].fold).toBe(true);
    expect(foldTargets({ pairs: [{ drop: 'M (Q)', keep: 'M (K)' }], codeModels, activeByModel: new Map(), retiring: new Set() })).toEqual([]);
  });
  it('refuses a Model whose codes went into two different Models', () => {
    const [t] = foldTargets({
      pairs: [{ drop: 'P (K)', keep: 'M (K)' }, { drop: 'P (Q)', keep: 'N (Q)' }],
      codeModels: cm([['P (K)', 'm-p', 'P'], ['P (Q)', 'm-p', 'P'], ['M (K)', 'm-m', 'M'], ['N (Q)', 'm-n', 'N']]),
      activeByModel: new Map(), retiring: new Set(),
    });
    expect(t.fold).toBe(false);
    expect(t.reason).toBe('its codes went into more than one Model (M / N)');
  });
});

describe('foldOnlyPlan', () => {
  const base = { label: 'M', refusals: [], pairs: [], moves: [], fills: [], addSizes: ['Q'], activateKept: true, createModel: null, inactiveMoves: [{ id: 'x' }], foldModels: [] };
  it('passes a pure fold, without touching the kept Model\'s own sizes or switch', () => {
    const v = foldOnlyPlan(base, true);
    expect(v.ok).toBe(true);
    expect(v.plan.addSizes).toEqual([]);
    expect(v.plan.activateKept).toBe(false);
  });
  it('reports the planner\'s refusal and anything that is more than a fold', () => {
    expect(foldOnlyPlan({ ...base, refusals: ['the Models are bound to different main suppliers (A vs B)'] }, true))
      .toEqual({ ok: false, reason: 'different supplier: the Models are bound to different main suppliers (A vs B)' });
    expect(foldOnlyPlan({ ...base, refusals: ['a SKU has no size'] }, true)).toEqual({ ok: false, reason: 'a SKU has no size' });
    expect(foldOnlyPlan({ ...base, pairs: [{ drop: 'A', keep: 'B' }] }, true).reason).toMatch(/two codes of one size \(A \/ B\)/);
    expect(foldOnlyPlan(base, false)).toEqual({ ok: false, reason: 'Model "M" is switched off' });
  });
});

describe('stock acknowledgements in the ruling file', () => {
  it('are written per code, warehouse and exact numbers, and only where the owner ruled one', () => {
    const acks = Object.entries(BOOK).flatMap(([ticket, e]) => e.groups.flatMap((g) => (g.ackStockDivergence ?? []).map((a) => ({ ticket, ...a }))));
    expect(acks).toEqual([{ ticket: 'OWNER-2026-11-10-RELAX', code: 'DUNLOPILLO RELAX SLEEP LUXURTY MATT (K)', warehouse: 'PG SERVICE', ledger: -1, lots: 0, reason: 'owner 2026-11-10: merge anyway, owner corrects stock' }]);
  });
});
