import { describe, it, expect } from 'vitest';
import { warehouseLabel } from './warehouse-label';

describe('warehouseLabel', () => {
  it('prefers the code over the name', () => {
    expect(warehouseLabel({ code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' }))
      .toBe('KL WAREHOUSE');
  });

  it('falls back to the name when the code is absent', () => {
    expect(warehouseLabel({ code: null, name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
    expect(warehouseLabel({ name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
  });

  it('treats blank and whitespace-only values as absent', () => {
    expect(warehouseLabel({ code: '', name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
    expect(warehouseLabel({ code: '   ', name: 'BALAKONG WAREHOUSE' }))
      .toBe('BALAKONG WAREHOUSE');
  });

  it('trims the label it returns', () => {
    expect(warehouseLabel({ code: '  KL WAREHOUSE  ', name: null }))
      .toBe('KL WAREHOUSE');
  });

  it('returns null when the warehouse carries no label at all', () => {
    expect(warehouseLabel({ code: null, name: null })).toBeNull();
    expect(warehouseLabel({ code: '', name: '  ' })).toBeNull();
    expect(warehouseLabel({})).toBeNull();
    expect(warehouseLabel(null)).toBeNull();
    expect(warehouseLabel(undefined)).toBeNull();
  });
});
