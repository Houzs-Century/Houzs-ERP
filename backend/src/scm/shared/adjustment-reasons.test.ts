import { describe, expect, test } from 'vitest';
import { ADJUSTMENT_REASONS, isAdjustmentReasonCode, adjustmentReasonLabel } from './adjustment-reasons';

describe('Free Gift adjustment reason', () => {
  test('is in the shared catalogue as FREEGIFT / Free Gift', () => {
    expect(ADJUSTMENT_REASONS.find((r) => r.code === 'FREEGIFT')?.label).toBe('Free Gift');
  });

  test('passes the backend validation gate', () => {
    expect(isAdjustmentReasonCode('FREEGIFT')).toBe(true);
  });

  test('renders back to its label for the movement lists', () => {
    expect(adjustmentReasonLabel('FREEGIFT')).toBe('Free Gift');
  });
});
