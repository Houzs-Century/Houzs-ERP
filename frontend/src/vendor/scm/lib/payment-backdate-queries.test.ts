import { describe, expect, it } from 'vitest';
import { slipDateNeedsRequest } from './payment-backdate-queries';

/* Owner 2026-09-30 — a slip older than 14 days goes to an admin as a request;
   only the too-old half qualifies, and a backdater never needs one. */
describe('slipDateNeedsRequest', () => {
  const today = '2026-09-30';
  it('asks for a request only for a slip older than the window', () => {
    expect(slipDateNeedsRequest('2026-09-15', today, false)).toBe(true);
    expect(slipDateNeedsRequest('2026-09-16', today, false)).toBe(false);
    expect(slipDateNeedsRequest(today, today, false)).toBe(false);
  });
  it('never for a future date — that stays a refusal', () => {
    expect(slipDateNeedsRequest('2026-10-01', today, false)).toBe(false);
  });
  it('never for a caller holding the backdate right', () => {
    expect(slipDateNeedsRequest('2026-08-01', today, true)).toBe(false);
  });
});
