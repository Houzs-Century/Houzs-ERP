import { describe, expect, it } from 'vitest';
import { countModelessMatches, modelMatchesSearch } from './model-picker-search';

const model = { model_code: 'CROWN', name: 'CROWN BEDFRAME', branding: 'HOUZS' };
const skus = [
  { code: 'CROWN-Q', name: 'CROWN BEDFRAME QUEEN', description: null, barcode: null },
  { code: 'CROWN-CUS', name: 'CROWN BEDFRAME (CUSTOM SIZE)', description: null, barcode: '9551234' },
];

describe('modelMatchesSearch', () => {
  it('matches every Model on an empty search', () => {
    expect(modelMatchesSearch(model, skus, '  ')).toBe(true);
  });

  it('matches on Model code / name / branding', () => {
    expect(modelMatchesSearch(model, [], 'crown')).toBe(true);
    expect(modelMatchesSearch(model, [], 'houzs')).toBe(true);
  });

  it('matches a Model through a SKU name the Model itself does not carry (BUG-30)', () => {
    expect(modelMatchesSearch(model, skus, 'custo')).toBe(true);
    expect(modelMatchesSearch(model, skus, 'crown-cus')).toBe(true);
    expect(modelMatchesSearch(model, skus, '9551234')).toBe(true);
  });

  it('does not match when neither the Model nor its SKUs contain the text', () => {
    expect(modelMatchesSearch(model, skus, 'sofa')).toBe(false);
  });
});

describe('countModelessMatches', () => {
  it('counts only model-less SKUs that match', () => {
    const products = [
      { code: 'A-CUSTOM', name: 'A', description: null, barcode: null, model_id: null },
      { code: 'B-CUSTOM', name: 'B', description: null, barcode: null, model_id: 'm1' },
      { code: 'C', name: 'C', description: 'custom order', barcode: null },
      { code: 'D', name: 'D', description: null, barcode: null, model_id: null },
    ];
    expect(countModelessMatches(products, 'custom')).toBe(2);
    expect(countModelessMatches(products, '')).toBe(0);
  });
});
