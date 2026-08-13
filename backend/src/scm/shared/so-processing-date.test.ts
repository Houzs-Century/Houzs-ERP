// ----------------------------------------------------------------------------
// so-processing-date — the seam that keeps a STORED payload readable across a
// rename of the key it was written under.
//
// The failure being guarded is silent by construction: applySoAmendment
// (lib/so-revision.ts) `continue`s on a header_changes key the amendable
// allow-list does not have, and routes/so-amendments.ts gates on the same
// literal. Rename the payload key and a pending amendment requested before the
// deploy approves cleanly, audits cleanly, skips the deposit gate, and writes
// nothing. No error anywhere.
//
// Both halves are asserted: today's identity behaviour (so this cannot be
// landing a behaviour change), and the rename behaviour (so the seam is proved
// to work rather than merely intended to).
// ----------------------------------------------------------------------------
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
  /* If these ever disagree, the policy table (which drives the lock set, the
     amendment allow-list and the frontend mirror) and everything keyed on the
     constants are describing two different columns — which is the three-names
     problem returning under new management. */
  it('matches the policy table row for the Processing Date', () => {
    const row = SO_HEADER_FIELD_POLICY.find((f) => f.label === 'Processing Date');
    expect(row, 'no Processing Date row in SO_HEADER_FIELD_POLICY').toBeDefined();
    expect(row!.column).toBe(SO_PROCESSING_DATE_COLUMN);
    expect(row!.payloadKey).toBe(SO_PROCESSING_DATE_PAYLOAD_KEY);
  });

  it('lists the OLD inbound name, because 2990 still sends it', () => {
    /* Empty is indistinguishable from "somebody forgot". Before the rename this
       list held the CURRENT name (the alias was a proven no-op); migration 0284
       landed on 2026-08-13, so it must now hold the OLD one. 2990 is a separate
       repo on its own deploy schedule, and without the alias its mirror payload
       loses the key against information_schema, returns 200, and the date never
       arrives. */
    expect([...SO_PROCESSING_DATE_LEGACY_COLUMNS]).toContain('internal_expected_dd');
    expect([...SO_PROCESSING_DATE_LEGACY_COLUMNS]).not.toContain(SO_PROCESSING_DATE_COLUMN);
  });

  it('maps the OLD payload key onto the current one, and never onto itself', () => {
    /* The seam was an identity map until the rename landed. Now every entry
       must MOVE a key: an entry mapping a name to itself is a leftover that
       makes the map look wired when it is not. */
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
    /* This is the silent failure the seam exists for. A Processing-Date
       amendment REQUESTED before the rename and APPROVED after it carries the
       old key; applySoAmendment `continue`s on any key absent from the
       amendable allow-list, so without this the approval succeeds, the date
       never moves, and the audit line does not mention it. Other keys pass
       through untouched. */
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

  /* THE ONE THAT MATTERS: an amendment requested BEFORE a payload-key rename,
     approved AFTER it. Without this the apply loop skips the key and the date is
     never written — a Processing Date that was reviewed and signed off, and then
     silently did not happen. */
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

  /* Prototype-pollution shape: applySoAmendment already uses hasOwnProperty for
     exactly this reason, and this helper runs BEFORE it. */
  it('does not resolve an inherited key through the alias map', () => {
    const out = canonicaliseSoHeaderChanges({ constructor: 'x', toString: 'y' } as Record<string, string>);
    expect(out).toEqual({ constructor: 'x', toString: 'y' });
  });
});
