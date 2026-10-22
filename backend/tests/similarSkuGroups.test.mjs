/* HC-0147: the duplicate-SKU scan behind report-similar-skus.mjs. */
import { describe, it, expect } from 'vitest';
import { groupSimilarSkus, REASONS } from '../scripts/lib/similar-sku-groups.mjs';

const sku = (code, category = 'MATTRESS', status = 'ACTIVE') => ({ code, category, status });

describe('groupSimilarSkus', () => {
  it('finds the HC-0147 ROY / ROYAL twins by their shared AutoCount item and by spelling', () => {
    const groups = groupSimilarSkus({
      products: [
        sku('DUNLOPILLO ROY EXECUTIVE LUXE 2.0 MATT (K)'),
        sku('DUNLOPILLO ROYAL EXECUTIVE LUXE 2.0 MATT (K)'),
        sku('DUNLOPILLO ROY EXECUTIVE LUXE 2.0 MATT (Q)'),
        sku('DUNLOPILLO ROYAL EXECUTIVE LUXE 2.0 MATT (Q)'),
      ],
      bindings: [
        { itemCode: 'DUNLOPILLO ROY EXECUTIVE LUXE 2.0 MATT (K)', acCode: 'DL-ROYAL EXECUTIVE LUXE 2.0(K)' },
        { itemCode: 'DUNLOPILLO ROYAL EXECUTIVE LUXE 2.0 MATT (K)', acCode: 'DL-ROYAL EXECUTIVE LUXE 2.0(K)' },
      ],
    });
    expect(groups).toEqual([
      {
        codes: ['DUNLOPILLO ROY EXECUTIVE LUXE 2.0 MATT (K)', 'DUNLOPILLO ROYAL EXECUTIVE LUXE 2.0 MATT (K)'],
        reasons: [REASONS.ac, REASONS.near],
        acCodes: ['DL-ROYAL EXECUTIVE LUXE 2.0(K)'],
      },
      {
        codes: ['DUNLOPILLO ROY EXECUTIVE LUXE 2.0 MATT (Q)', 'DUNLOPILLO ROYAL EXECUTIVE LUXE 2.0 MATT (Q)'],
        reasons: [REASONS.near],
        acCodes: [],
      },
    ]);
  });

  it('pairs codes that differ only in spacing', () => {
    const [g] = groupSimilarSkus({
      products: [sku('ROYAL EXECUTIVE LUXE2.0 MATT (SK)'), sku('ROYAL EXECUTIVE LUXE 2.0 MATT (SK)')],
      bindings: [],
    });
    expect(g.reasons).toContain(REASONS.spacing);
  });

  it('leaves alone different sizes, changed letters, added digits, other categories and inactive rows', () => {
    expect(groupSimilarSkus({
      products: [
        sku('DUNLOPILLO ROYAL EXECUTIVE MATT (K)'),
        sku('DUNLOPILLO ROYAL EXECUTIVE MATT (Q)'),
        sku('SOFA MAYBATCH 9058-1 SEATER', 'SOFA'),
        sku('SOFA MAYBATCH 9058-12 SEATER', 'SOFA'),
        sku('AF RM PE PNK 4KFIT', 'ACCESSORY'),
        sku('AF RM PE PNK 4QFIT', 'ACCESSORY'),
        sku('AF RM PE BLU 4QFIT', 'ACCESSORY'),
        sku('CODY-(SS)', 'BEDFRAME'),
        sku('CODYS-(S)', 'BEDFRAME'),
        sku('HAPPI SLEEP SOLITUDE MATT (S)'),
        sku('HAPPI SLEEP SOLITUDE BEDF (S)', 'BEDFRAME'),
        sku('HAPPI SLEEP SOLITUDES MATT (S)', 'MATTRESS', 'INACTIVE'),
      ],
      bindings: [],
    })).toEqual([]);
  });
});
