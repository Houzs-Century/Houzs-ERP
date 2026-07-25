// Classification coverage for amendment-routing.ts — proves the owner's model:
// a colour change is PROCESSING (Production / Design); a delivery-date change is
// DELIVERY/COMMERCIAL (Logistics); a mixed amendment tags BOTH types and both
// departments.
import { describe, it, expect } from 'vitest';
import {
  routeField,
  fieldKindFromLabel,
  summariseRouting,
  FIELD_KIND_LABEL,
  type AmendmentFieldKind,
} from './amendment-routing';

describe('routeField', () => {
  it('classifies a colour/fabric change as processing, owned by Production / Design', () => {
    const r = routeField('VARIANT');
    expect(r.type).toBe('PROCESSING');
    expect(r.department).toContain('Production');
  });

  it('classifies a delivery-date change as delivery/commercial, owned by Logistics', () => {
    const r = routeField('DELIVERY');
    expect(r.type).toBe('DELIVERY_COMMERCIAL');
    expect(r.department).toBe('Logistics');
  });

  it('routes SKU/qty/line to processing and price/supplier to delivery-commercial', () => {
    expect(routeField('SPEC').type).toBe('PROCESSING');
    expect(routeField('QTY').type).toBe('PROCESSING');
    expect(routeField('LINE').type).toBe('PROCESSING');
    expect(routeField('PRICE').type).toBe('DELIVERY_COMMERCIAL');
    expect(routeField('PRICE').department).toBe('Finance');
    expect(routeField('SUPPLIER').type).toBe('DELIVERY_COMMERCIAL');
    expect(routeField('SUPPLIER').department).toBe('Purchasing');
  });

  it('has a human label for every atom', () => {
    (['SPEC', 'VARIANT', 'QTY', 'LINE', 'PRICE', 'DELIVERY', 'SUPPLIER'] as AmendmentFieldKind[])
      .forEach((k) => expect(FIELD_KIND_LABEL[k]).toBeTruthy());
  });
});

describe('fieldKindFromLabel', () => {
  it('folds the PDF/UI field labels back to atoms, case-insensitively', () => {
    expect(fieldKindFromLabel('Unit cost')).toBe('PRICE');
    expect(fieldKindFromLabel('Unit price')).toBe('PRICE');
    expect(fieldKindFromLabel('Delivery date')).toBe('DELIVERY');
    expect(fieldKindFromLabel('Quantity')).toBe('QTY');
    expect(fieldKindFromLabel('Spec')).toBe('SPEC');
    expect(fieldKindFromLabel('Supplier')).toBe('SUPPLIER');
  });
  it('returns null for an unroutable label', () => {
    expect(fieldKindFromLabel('mystery')).toBeNull();
    expect(fieldKindFromLabel(null)).toBeNull();
  });
});

describe('summariseRouting', () => {
  it('a single processing change reports one type, not mixed', () => {
    const s = summariseRouting(['VARIANT']);
    expect(s.types).toEqual(['PROCESSING']);
    expect(s.isMixed).toBe(false);
    expect(s.departments).toEqual([{ department: 'Production / Design', kinds: ['VARIANT'] }]);
  });

  it('a MIXED amendment (colour + delivery date) tags BOTH types and both departments', () => {
    const s = summariseRouting(['VARIANT', 'DELIVERY']);
    expect(s.isMixed).toBe(true);
    expect(s.types).toEqual(['PROCESSING', 'DELIVERY_COMMERCIAL']);
    const depts = s.departments.map((d) => d.department);
    expect(depts).toContain('Production / Design');
    expect(depts).toContain('Logistics');
  });

  it('de-duplicates a field atom that appears on several lines', () => {
    const s = summariseRouting(['QTY', 'QTY', 'PRICE', null, undefined]);
    const proc = s.departments.find((d) => d.department === 'Production / Design')!;
    expect(proc.kinds).toEqual(['QTY']);
    expect(s.isMixed).toBe(true);
  });

  it('empty input is not mixed and lists no departments', () => {
    const s = summariseRouting([]);
    expect(s.types).toEqual([]);
    expect(s.isMixed).toBe(false);
    expect(s.departments).toEqual([]);
  });
});
