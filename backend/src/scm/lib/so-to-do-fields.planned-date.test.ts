import { describe, expect, test } from 'vitest';
import { SO_CONVERT_HEADER, soHeaderToDoSource, soPlannedDeliveryDate } from './so-to-do-fields';

/* Owner 2026-11-27: a DO cut from a Sales Order is delivered on the date set on
   Delivery Planning (amended_delivery_date), not the SO's original customer date. */
describe('soPlannedDeliveryDate', () => {
  test('the Delivery Planning date wins over the SO customer date', () => {
    expect(soPlannedDeliveryDate({ customer_delivery_date: '2026-10-31', amended_delivery_date: '2026-11-29' })).toBe('2026-11-29');
  });
  test('falls back to the customer date when nothing was planned', () => {
    expect(soPlannedDeliveryDate({ customer_delivery_date: '2026-10-31T00:00:00', amended_delivery_date: null })).toBe('2026-10-31');
  });
  test('null when the SO has neither', () => {
    expect(soPlannedDeliveryDate({ customer_delivery_date: '', amended_delivery_date: null })).toBeNull();
  });
  test('the header select reads the planned date and the form preview carries it', () => {
    expect(SO_CONVERT_HEADER).toContain('amended_delivery_date');
    expect(soHeaderToDoSource({ doc_no: 'SO-1', customer_delivery_date: '2026-10-31', amended_delivery_date: '2026-11-29' }).customerDeliveryDate).toBe('2026-11-29');
  });
});
