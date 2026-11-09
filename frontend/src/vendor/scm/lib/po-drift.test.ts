import { describe, expect, it } from 'vitest';
import { poDriftMode } from './po-drift';

describe('PO drift notice', () => {
  it('with the supplier: sync and re-send', () => {
    expect(poDriftMode('SUBMITTED')).toBe('actionable');
    expect(poDriftMode('PARTIALLY_RECEIVED')).toBe('actionable');
  });
  it('received: still shown, as a check before delivery (HC-PO-2610-142 said nothing)', () => {
    expect(poDriftMode('RECEIVED')).toBe('received');
  });
  it('nothing ordered: no notice', () => {
    expect(poDriftMode('DRAFT')).toBeNull();
    expect(poDriftMode('CANCELLED')).toBeNull();
    expect(poDriftMode(null)).toBeNull();
  });
});
