import { describe, expect, it } from 'vitest';
import { canCreateConsignmentNote } from './co-note-gate';

describe('canCreateConsignmentNote', () => {
  it('allows a confirmed order whose list row carries no has_undelivered flag (the CO list never stamps it)', () => {
    expect(canCreateConsignmentNote({ status: 'CONFIRMED' })).toBe(true);
  });

  it('allows an order that still has undelivered lines', () => {
    expect(canCreateConsignmentNote({ status: 'CONFIRMED', has_undelivered: true })).toBe(true);
  });

  it('blocks only when has_undelivered is explicitly false', () => {
    expect(canCreateConsignmentNote({ status: 'CONFIRMED', has_undelivered: false })).toBe(false);
  });

  it('blocks cancelled, closed and on-hold orders regardless of the flag', () => {
    for (const status of ['CANCELLED', 'CLOSED', 'ON_HOLD']) {
      expect(canCreateConsignmentNote({ status, has_undelivered: true })).toBe(false);
      expect(canCreateConsignmentNote({ status })).toBe(false);
    }
  });
});
