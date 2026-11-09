import { describe, expect, it } from 'vitest';
import { FIELD_PHOTO_HOLD_HOURS, parseSlipPurpose, slipSessionExpiry } from './slip';

/* A field photo is uploaded when it is taken and claimed only at Complete. If
   its session expired after the usual hour, the slip reaper would delete the
   photo during a long installation and Complete would refuse it. */
describe('slipSessionExpiry', () => {
  const now = new Date('2026-11-08T02:00:00.000Z');

  it('keeps a payment slip session at one hour', () => {
    expect(slipSessionExpiry(null, now)).toBe('2026-11-08T03:00:00.000Z');
  });

  it('holds a field photo session for a day', () => {
    expect(FIELD_PHOTO_HOLD_HOURS).toBe(24);
    expect(slipSessionExpiry('field_photo', now)).toBe('2026-11-09T02:00:00.000Z');
  });

  it('accepts only the known purpose; anything else is an ordinary slip', () => {
    expect(parseSlipPurpose('field_photo')).toBe('field_photo');
    expect(parseSlipPurpose('forever')).toBeNull();
    expect(parseSlipPurpose(undefined)).toBeNull();
    expect(parseSlipPurpose(1)).toBeNull();
  });
});
