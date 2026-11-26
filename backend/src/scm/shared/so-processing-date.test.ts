import { describe, it, expect } from 'vitest';
import {
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_PAYLOAD_KEY,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
  SO_HEADER_LEGACY_PAYLOAD_KEYS,
  canonicaliseSoHeaderChanges,
} from './so-processing-date';
import { SO_HEADER_FIELD_POLICY } from './so-field-policy';

describe('so-processing-date — the constants name the SAME field the policy table does', () => {
  it('matches the policy table row for the Processing Date', () => {
    const row = SO_HEADER_FIELD_POLICY.find((f) => f.label === 'Processing Date');
    expect(row, 'no Processing Date row in SO_HEADER_FIELD_POLICY').toBeDefined();
    expect(row!.column).toBe(SO_PROCESSING_DATE_COLUMN);
    expect(row!.payloadKey).toBe(SO_PROCESSING_DATE_PAYLOAD_KEY);
  });

  it('lists the OLD inbound name, because 2990 still sends it', () => {
    expect([...SO_PROCESSING_DATE_LEGACY_COLUMNS]).toContain('internal_expected_dd');
    expect([...SO_PROCESSING_DATE_LEGACY_COLUMNS]).not.toContain(SO_PROCESSING_DATE_COLUMN);
  });

  it('maps the OLD payload key onto the current one, and never onto itself', () => {
    expect(SO_HEADER_LEGACY_PAYLOAD_KEYS.internalExpectedDd).toBe(SO_PROCESSING_DATE_PAYLOAD_KEY);
    for (const [from, to] of Object.entries(SO_HEADER_LEGACY_PAYLOAD_KEYS)) {
      expect(from, `${from} maps to itself — that is not an alias`).not.toBe(to);
    }
  });
});

describe('canonicaliseSoHeaderChanges', () => {
  it('returns null for null / undefined', () => {
    expect(canonicaliseSoHeaderChanges(null)).toBeNull();
    expect(canonicaliseSoHeaderChanges(undefined)).toBeNull();
  });

  it('rewrites a stored amendment that was frozen under the OLD key', () => {
    const stored = {
      internalExpectedDd: '2026-09-01',
      customerDeliveryDate: '2026-09-20',
      postcode: '47500',
    };
    expect(canonicaliseSoHeaderChanges(stored)).toEqual({
      processingDate: '2026-09-01',
      customerDeliveryDate: '2026-09-20',
      postcode: '47500',
    });
  });

  it('does not mutate the caller\'s object', () => {
    const stored = { internalExpectedDd: '2026-09-01' };
    const out = canonicaliseSoHeaderChanges(stored, { internalExpectedDd: 'processingDate' });
    expect(stored).toEqual({ internalExpectedDd: '2026-09-01' });
    expect(out).toEqual({ processingDate: '2026-09-01' });
  });

  it('rewrites a legacy stored key onto the current one', () => {
    const out = canonicaliseSoHeaderChanges(
      { internalExpectedDd: '2026-09-01', customerDeliveryDate: '2026-09-20' },
      { internalExpectedDd: 'processingDate' },
    );
    expect(out).toEqual({ processingDate: '2026-09-01', customerDeliveryDate: '2026-09-20' });
  });

  it('keeps a null value — clearing the date is a real amendment, not an absent key', () => {
    const out = canonicaliseSoHeaderChanges<string | null>(
      { internalExpectedDd: null },
      { internalExpectedDd: 'processingDate' },
    );
    expect(out).toEqual({ processingDate: null });
    expect('processingDate' in out!).toBe(true);
  });

  it('lets the CURRENT spelling win when a payload carries both', () => {
    const out = canonicaliseSoHeaderChanges(
      { internalExpectedDd: '2026-09-01', processingDate: '2026-10-02' },
      { internalExpectedDd: 'processingDate' },
    );
    expect(out).toEqual({ processingDate: '2026-10-02' });
  });

  it('passes unaliased keys through unchanged', () => {
    const out = canonicaliseSoHeaderChanges(
      { customerState: 'Johor', city: 'Johor Bahru' },
      { internalExpectedDd: 'processingDate' },
    );
    expect(out).toEqual({ customerState: 'Johor', city: 'Johor Bahru' });
  });

  it('is safe to apply twice — an already-canonical key has no alias', () => {
    const aliases = { internalExpectedDd: 'processingDate' };
    const once = canonicaliseSoHeaderChanges({ internalExpectedDd: '2026-09-01' }, aliases);
    expect(canonicaliseSoHeaderChanges(once, aliases)).toEqual(once);
  });

  it('does not resolve an inherited key through the alias map', () => {
    const out = canonicaliseSoHeaderChanges({ constructor: 'x', toString: 'y' } as Record<string, string>);
    expect(out).toEqual({ constructor: 'x', toString: 'y' });
  });
});
