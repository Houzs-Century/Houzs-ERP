// ----------------------------------------------------------------------------
// The way out of a Sales Order version conflict.
//
// Owner 2026-08-16, on his own (non-POS) account: once the SO's version moved
// while he had the editor open, that editor could never save again. The server
// had been sending the recovery datum all along and nothing read it.
//
// NOTE ON THE SENTENCE. `authed-fetch.version-conflict.test.ts` asserts the
// operator-facing message does NOT contain `currentVersion`, and that assertion
// is CORRECT — it enforces the repo's 白话文 rule (authed-fetch.ts:406: no HTTP
// codes, no raw JSON, no DB internals) and must not be relaxed to "fix" this.
// Both things hold at once, and the pairing test below pins exactly that: the
// sentence stays clean while the machine-readable body is finally read.
// ----------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { humanApiError } from '../../vendor/scm/lib/authed-fetch';
import { readVersionConflict, SoVersionConflictBanner } from './so-version-conflict';

// The literal body backend/src/scm/routes/mfg-sales-orders.ts:356 builds.
const CONFLICT_BODY = JSON.stringify({
  error: 'so_version_conflict',
  message: 'Someone else updated this order while you were editing. Your changes are still on this screen; review the latest order before saving again.',
  currentVersion: 7,
});

describe('reading the server version off the 409 body', () => {
  it('recovers currentVersion from a so_version_conflict body', () => {
    expect(readVersionConflict(CONFLICT_BODY)).toEqual({ serverVersion: 7 });
  });

  it('covers the other two shapes of the same dead end', () => {
    expect(readVersionConflict(JSON.stringify({ error: 'so_version_required', currentVersion: 2 })))
      .toEqual({ serverVersion: 2 });
    expect(readVersionConflict(JSON.stringify({ error: 'so_version_invalid', currentVersion: 3 })))
      .toEqual({ serverVersion: 3 });
  });

  it('still reports the conflict when the body carries no usable version', () => {
    // The refusal is real even if the recovery number is missing; the banner
    // must still appear, just without the one-press continue.
    expect(readVersionConflict(JSON.stringify({ error: 'so_version_conflict' })))
      .toEqual({ serverVersion: null });
    expect(readVersionConflict(JSON.stringify({ error: 'so_version_conflict', currentVersion: 0 })))
      .toEqual({ serverVersion: null });
  });

  it('leaves every other failure to the ordinary error path', () => {
    expect(readVersionConflict(JSON.stringify({ error: 'so_edit_lease_conflict' }))).toBeNull();
    expect(readVersionConflict(JSON.stringify({ error: 'validation_failed' }))).toBeNull();
    expect(readVersionConflict('not json')).toBeNull();
    expect(readVersionConflict('')).toBeNull();
    expect(readVersionConflict(null)).toBeNull();
  });

  it('the SENTENCE stays clean while the BODY yields the version', () => {
    // One body, two readers, two different jobs. This is the pairing that was
    // missing: humanApiError was doing its job and nobody did the other one.
    expect(humanApiError(409, CONFLICT_BODY)).not.toMatch(/currentVersion|\b7\b/);
    expect(readVersionConflict(CONFLICT_BODY)?.serverVersion).toBe(7);
  });
});

describe('the conflict banner', () => {
  const setup = (serverVersion: number | null) => {
    const onReview = vi.fn();
    const onProceed = vi.fn();
    render(
      <SoVersionConflictBanner
        conflict={{ serverVersion }}
        className="banner"
        saving={false}
        onReview={onReview}
        onProceed={onProceed}
      />,
    );
    return { onReview, onProceed };
  };

  it('promises the operator their typing survived — nothing to retype', () => {
    setup(7);
    expect(screen.getByRole('alert').textContent).toMatch(/still on this screen/i);
  });

  it('offers a LOOK before a write', async () => {
    const { onReview, onProceed } = setup(7);
    await userEvent.click(screen.getByRole('button', { name: /see what changed/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onProceed).not.toHaveBeenCalled();   // looking writes nothing
  });

  it('offers an explicit proceed — the adoption is never silent', async () => {
    const { onProceed } = setup(7);
    await userEvent.click(screen.getByRole('button', { name: /save my changes on top/i }));
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('withholds proceed when the server gave no version to adopt', () => {
    setup(null);
    expect(screen.queryByRole('button', { name: /save my changes on top/i })).toBeNull();
    expect(screen.getByRole('button', { name: /see what changed/i })).toBeTruthy();
  });
});
