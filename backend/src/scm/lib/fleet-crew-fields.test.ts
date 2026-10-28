import { describe, expect, it } from 'vitest';
import { normalizeIc, INVALID_IC, IC_MAX } from './fleet-crew-fields';

/**
 * The IC field had NO validation, no uniqueness and not even a placeholder —
 * `ic_number: (body.icNumber as string) ?? null`, a raw cast into a TEXT column.
 *
 * The rule here is deliberately tolerant, and the reason is in the module: a
 * large part of this fleet's crew are foreign workers carrying PASSPORT
 * numbers. A strict 12-digit NRIC check would refuse to register the people the
 * field exists to record.
 */

describe('normalizeIc', () => {
  it('blank is null — the field is optional, not rejected', () => {
    expect(normalizeIc(null)).toBeNull();
    expect(normalizeIc(undefined)).toBeNull();
    expect(normalizeIc('')).toBeNull();
    expect(normalizeIc('   ')).toBeNull();
  });

  it('collapses the three ways one NRIC gets typed into one value', () => {
    const canonical = '900101-01-5523';
    expect(normalizeIc('900101015523')).toBe(canonical);
    expect(normalizeIc('900101-01-5523')).toBe(canonical);
    expect(normalizeIc('900101 01 5523')).toBe(canonical);
    expect(normalizeIc('  900101015523  ')).toBe(canonical);
  });

  it('KEEPS a passport number as typed — foreign crew are the common case here', () => {
    expect(normalizeIc('A12345678')).toBe('A12345678');
    expect(normalizeIc('e 9876543')).toBe('E 9876543');
  });

  it('a passport that happens to contain 12 digits is NOT reformatted as an NRIC', () => {
    expect(normalizeIc('AB900101015523')).toBe('AB900101015523');
  });

  it('a wrong-length digit string is kept, not reformatted and not refused', () => {
    // 11 digits: not an NRIC, but refusing it would block a real registration.
    expect(normalizeIc('90010101552')).toBe('90010101552');
  });

  it('refuses only what is too long to be any identity document', () => {
    expect(normalizeIc('X'.repeat(IC_MAX))).toBe('X'.repeat(IC_MAX));
    expect(normalizeIc('X'.repeat(IC_MAX + 1))).toBe(INVALID_IC);
  });

  it('the refusal is a sentinel, not null — null already means "left blank"', () => {
    expect(normalizeIc('X'.repeat(99))).not.toBeNull();
    expect(normalizeIc('')).toBeNull();
  });
});
