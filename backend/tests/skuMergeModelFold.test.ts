/* Option C (owner, 2026-11-10): SKU Master "Merge codes" folds a dropped code's
 * Product Model into the kept code's Model when the merge leaves it with no
 * ACTIVE code. A refused or failed fold is reported, never silent, and never
 * undoes the SKU merge (which committed before the fold runs). */
import { describe, expect, it } from 'vitest';
import { foldModelsAfterSkuMerge, previewModelFolds, notFoldedText, type FoldIo } from '../src/scm/lib/sku-merge-model-fold';
import { planModelGroup } from '../scripts/lib/duplicate-model-merge-plan.mjs';
import { writeModelGroup } from '../scripts/lib/duplicate-model-merge-run.mjs';

const model = (id: string, code: string, over = {}) => ({ id, model_code: code, category: 'MATTRESS', active: true, allowed_options: { sizes: ['K'] }, ...over });
const sku = (code: string, modelId: string, status = 'ACTIVE') => ({
  id: `s-${code}`, code, status, size_code: null, model_id: modelId, base_model: null, main: null, use: { lines: 0, stock: 0, openSo: 0 }, master: {},
});

function io(over: Partial<FoldIo> & { active?: Record<string, number>; status?: Record<string, string> } = {}) {
  const calls: Array<{ fn: string; co: number }> = [];
  const models = [model('m-keep', 'AMIRA PREMIUM'), model('m-fold', 'AMIRA PREMUIM', { active: false })];
  const skus = [sku('AMIRA PREMIUM (K)', 'm-keep'), sku('AMIRA PREMUIM (K)', 'm-fold', over.status?.['AMIRA PREMUIM (K)'] ?? 'INACTIVE'), sku('AMIRA PREMUIM (Q)', 'm-fold', 'INACTIVE')];
  const base: FoldIo = {
    readFoldInputs: async ({ co }) => {
      calls.push({ fn: 'read', co });
      return {
        codeModels: new Map(skus.map((s) => [s.code, { model_id: s.model_id, model_code: s.model_id === 'm-keep' ? 'AMIRA PREMIUM' : 'AMIRA PREMUIM', status: s.status }])),
        activeByModel: new Map(Object.entries(over.active ?? { 'm-keep': 1 })),
      };
    },
    planModelFold: async ({ co, keep, drops, retiring }) => {
      calls.push({ fn: 'plan', co });
      const world = { models, skus: skus.map((s) => (retiring?.has(s.code) ? { ...s, status: 'INACTIVE' } : s)) };
      return { world, plan: planModelGroup({ group: { category: 'MATTRESS', keep, drops }, models, skus: world.skus }), keptActive: true };
    },
    applyFold: async ({ co }) => { calls.push({ fn: 'apply', co }); return []; },
  };
  return { io: { ...base, ...over } as FoldIo, calls };
}

const pair = [{ drop: 'AMIRA PREMUIM (K)', keep: 'AMIRA PREMIUM (K)' }];

describe('SKU merge -> Model fold', () => {
  it('a merge that empties a Model folds it, moving its switched-off codes, all in the caller\'s company', async () => {
    const { io: x, calls } = io();
    const r = await foldModelsAfterSkuMerge(x, 7, pair);
    expect(r.folds).toEqual([{ from: 'AMIRA PREMUIM', into: 'AMIRA PREMIUM', fold: true, codes: 2, reason: null }]);
    expect(calls.map((c) => c.fn)).toEqual(['read', 'plan', 'apply']);
    expect(calls.every((c) => c.co === 7)).toBe(true);
  });

  it('a merge that leaves an active code under the Model does not fold it, and says why', async () => {
    const { io: x, calls } = io({ active: { 'm-keep': 1, 'm-fold': 1 } });
    const r = await foldModelsAfterSkuMerge(x, 1, pair);
    expect(r.folds[0]).toMatchObject({ fold: false, reason: 'it still has 1 active code(s)' });
    expect(calls.map((c) => c.fn)).toEqual(['read']);
  });

  it('a planner refusal is reported, the SKU merge is not undone, nothing is written', async () => {
    const { io: x, calls } = io({
      planModelFold: async () => ({ world: {}, plan: { label: 'AMIRA PREMIUM', refusals: ['a folded Model still carries sofa rows (sofa_quick_picks 1)'], pairs: [], moves: [], fills: [] }, keptActive: true }),
    });
    const r = await foldModelsAfterSkuMerge(x, 1, pair);
    expect(r.folds[0].fold).toBe(false);
    expect(notFoldedText(r.folds[0])).toBe('Model AMIRA PREMUIM was not merged: a folded Model still carries sofa rows (sofa_quick_picks 1)');
    expect(calls.map((c) => c.fn)).not.toContain('apply');
  });

  it('a fold whose write fails is reported, not thrown', async () => {
    const { io: x } = io({ applyFold: async () => { throw new Error('"AMIRA PREMUIM (Q)" changed since the plan'); } });
    const r = await foldModelsAfterSkuMerge(x, 1, pair);
    expect(r.folds[0]).toMatchObject({ fold: false, reason: '"AMIRA PREMUIM (Q)" changed since the plan' });
  });

  it('the Check preview plans the drop as already off and writes nothing', async () => {
    const { io: x, calls } = io({ active: { 'm-keep': 1, 'm-fold': 1 }, status: { 'AMIRA PREMUIM (K)': 'ACTIVE' } });
    const r = await previewModelFolds(x, 1, pair, new Set(['AMIRA PREMUIM (K)']));
    expect(r).toEqual([{ from: 'AMIRA PREMUIM', into: 'AMIRA PREMIUM', fold: true, codes: 2, reason: null }]);
    expect(calls.map((c) => c.fn)).not.toContain('apply');
  });
});

describe('writeModelGroup moves INACTIVE codes inside the company only', () => {
  it('every UPDATE carries company_id and re-asserts the Model it moves the code from', async () => {
    const seen: Array<{ text: string; values: unknown[] }> = [];
    const tag = (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return { ident: strings };
      seen.push({ text: strings.join('?'), values });
      return Promise.resolve([{ id: 'x' }]);
    };
    const sql = Object.assign(tag, { begin: async (cb: (tx: typeof tag) => Promise<void>) => cb(tag) });
    const models = [model('m-keep', 'AMIRA PREMIUM'), model('m-fold', 'AMIRA PREMUIM', { active: false })];
    const skus = [sku('AMIRA PREMIUM (K)', 'm-keep'), sku('AMIRA PREMUIM (K)', 'm-fold', 'INACTIVE')];
    const plan = { ...planModelGroup({ group: { category: 'MATTRESS', keep: 'AMIRA PREMIUM', drops: ['AMIRA PREMUIM'] }, models, skus }), addSizes: [], activateKept: false };
    await writeModelGroup(sql, { co: 9, plan, world: { models, skus, near: new Map(), bindings: [] }, log: () => {} });
    const moves = seen.filter((s) => /UPDATE scm\.mfg_products/.test(s.text));
    expect(moves).toHaveLength(1);
    expect(moves[0].text).toMatch(/WHERE company_id = \?/);
    expect(moves[0].text).toMatch(/status <> 'ACTIVE' AND model_id::text IS NOT DISTINCT FROM \?/);
    expect(moves[0].values).toContain(9);
    expect(moves[0].values).toContain('m-fold');
  });
});
