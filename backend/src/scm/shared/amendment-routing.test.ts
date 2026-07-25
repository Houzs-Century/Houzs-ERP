// Backend classification coverage — mirror of the frontend routing test, plus the
// routingNote stamped onto the amendment-approved audit row. Proves: colour ->
// processing (Production / Design); delivery date -> delivery/commercial
// (Logistics); a mixed amendment tags both types.
import { describe, it, expect } from 'vitest';
import { routeField, summariseRouting, routingNote } from './amendment-routing';

describe('routeField (backend)', () => {
  it('colour/fabric is processing, owned by Production / Design', () => {
    expect(routeField('VARIANT').type).toBe('PROCESSING');
    expect(routeField('VARIANT').department).toContain('Production');
  });
  it('delivery date is delivery/commercial, owned by Logistics', () => {
    expect(routeField('DELIVERY').type).toBe('DELIVERY_COMMERCIAL');
    expect(routeField('DELIVERY').department).toBe('Logistics');
  });
  it('price -> Finance, supplier -> Purchasing', () => {
    expect(routeField('PRICE').department).toBe('Finance');
    expect(routeField('SUPPLIER').department).toBe('Purchasing');
  });
});

describe('summariseRouting (backend)', () => {
  it('a mixed amendment tags both types', () => {
    const s = summariseRouting(['QTY', 'DELIVERY']);
    expect(s.isMixed).toBe(true);
    expect(s.types).toEqual(['PROCESSING', 'DELIVERY_COMMERCIAL']);
  });
});

describe('routingNote (backend)', () => {
  it('renders a single-line accountability string for the audit', () => {
    const note = routingNote(['VARIANT', 'DELIVERY']);
    expect(note).toContain('Processing + Delivery / Commercial');
    expect(note).toContain('Production / Design: Colour / fabric');
    expect(note).toContain('Logistics: Delivery date');
  });
  it('is empty for no routable changes', () => {
    expect(routingNote([])).toBe('');
    expect(routingNote([null, undefined])).toBe('');
  });
});
