import { describe, expect, it } from 'vitest';
import { scanCatalogSkus, type ScanCatalogRow } from './scan-catalog-skus';

const row = (code: string, model: ScanCatalogRow['model']): ScanCatalogRow =>
  ({ code, name: code, category: 'ACCESSORY', base_model: null, model });

describe('scanCatalogSkus', () => {
  // 19 Oct: JM-BAMBOO JACQUARD WP MP (K) sat under an inactive Model, the scan
  // offered it, and both create attempts were refused as "no longer active".
  it('drops a SKU whose Model is inactive, as the SO picker and validateItemCodes do', () => {
    const out = scanCatalogSkus([
      row('JM-BAMBOO JACQUARD WP MP (K)', { active: false }),
      row('JM-BAMBOO JACQUARD WP MP (Q)', [{ active: false }]),
      row('JM-COOLING JAC (K)', { active: true }),
      row('NO-MODEL', null),
    ]);
    expect(out.map((s) => s.code)).toEqual(['JM-COOLING JAC (K)', 'NO-MODEL']);
  });

  it('maps base_model to baseModel and reads a null list as empty', () => {
    expect(scanCatalogSkus([{ code: 'A', name: 'n', category: 'SOFA', base_model: 'M1' }]))
      .toEqual([{ code: 'A', name: 'n', category: 'SOFA', baseModel: 'M1' }]);
    expect(scanCatalogSkus(null)).toEqual([]);
  });
});
