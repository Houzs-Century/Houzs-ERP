/* merge-orphan-models.mjs: a Model left with only merged-away codes folds into
 * the ONE Model its codes went to, read from the merge records, never guessed. */
import { describe, it, expect } from 'vitest';
import { orphanTargets } from '../scripts/lib/orphan-model-targets.mjs';

const orphan = { id: 'm-old', model_code: 'AMIRA PREMUIM', category: 'MATTRESS', codes: ['AMIRA PREMUIM (K)', 'AMIRA PREMUIM (Q)', 'OLD NEVER MERGED'] };
const kept = new Map([['AMIRA PREMIUM (K)', { model_code: 'AMIRA PREMIUM', category: 'MATTRESS' }], ['OTHER (Q)', { model_code: 'OTHER', category: 'MATTRESS' }]]);

describe('orphanTargets', () => {
  it('targets the Model the kept codes sit under', () => {
    const [t] = orphanTargets({ orphans: [orphan], skuMerges: [{ drop: 'AMIRA PREMUIM (K)', keep: 'AMIRA PREMIUM (K)', source: 'screen' }], modelMerges: [], keptModelOf: kept });
    expect(t).toMatchObject({ modelId: 'm-old', into: 'AMIRA PREMIUM', evidence: 'screen SKU merge', codes: 3 });
  });
  it('takes a Model merge ruling in the same category as evidence too', () => {
    const [t] = orphanTargets({ orphans: [orphan], skuMerges: [], modelMerges: [{ category: 'MATTRESS', keep: 'AMIRA PREMIUM', drops: ['AMIRA PREMUIM'] }], keptModelOf: kept });
    expect(t.into).toBe('AMIRA PREMIUM');
    const [other] = orphanTargets({ orphans: [orphan], skuMerges: [], modelMerges: [{ category: 'BEDFRAME', keep: 'X', drops: ['AMIRA PREMUIM'] }], keptModelOf: kept });
    expect(other.into).toBeNull();
  });
  it('leaves alone a Model with no record, or whose codes went to two Models', () => {
    expect(orphanTargets({ orphans: [orphan], skuMerges: [], modelMerges: [], keptModelOf: kept })[0])
      .toMatchObject({ into: null, reason: 'no merge record names where its codes went' });
    const [t] = orphanTargets({
      orphans: [orphan], modelMerges: [], keptModelOf: kept,
      skuMerges: [{ drop: 'AMIRA PREMUIM (K)', keep: 'AMIRA PREMIUM (K)', source: 'screen' }, { drop: 'AMIRA PREMUIM (Q)', keep: 'OTHER (Q)', source: 'actions' }],
    });
    expect(t).toMatchObject({ into: null, reason: 'its codes went to more than one Model (AMIRA PREMIUM, OTHER)' });
  });
});
