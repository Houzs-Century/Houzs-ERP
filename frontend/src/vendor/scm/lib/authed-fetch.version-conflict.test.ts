import { describe, expect, it } from 'vitest';
import { humanApiError } from './authed-fetch';

describe('SO header version failures', () => {
  it('explains a conflict without implying that the unsaved input was discarded', () => {
    const message = humanApiError(409, JSON.stringify({
      error: 'so_version_conflict',
      currentVersion: 4,
    }));

    expect(message).toMatch(/someone else updated/i);
    expect(message).toMatch(/changes are still on this screen/i);
    expect(message).toMatch(/refresh/i);
    expect(message).not.toMatch(/409|currentVersion|so_version_conflict/);
  });

  it('turns a stale pre-version client into a recoverable 428 instruction', () => {
    const message = humanApiError(428, JSON.stringify({
      error: 'so_version_required',
      currentVersion: 2,
    }));

    expect(message).toMatch(/older screen/i);
    expect(message).toMatch(/changes are still here/i);
    expect(message).toMatch(/refresh/i);
    expect(message).not.toMatch(/428|currentVersion|so_version_required/);
  });

  it('keeps lease contention recoverable without exposing the lease protocol', () => {
    const message = humanApiError(409, JSON.stringify({ error: 'so_edit_lease_conflict' }));

    expect(message).toMatch(/another screen/i);
    expect(message).toMatch(/changes are still here/i);
    expect(message).toMatch(/try save again/i);
    expect(message).not.toMatch(/409|lease|so_edit_lease_conflict/);
  });
});

/* The bill-can-only-go-up floor. `so_total_below_original` had ZERO occurrences
   anywhere under frontend/ — no ERROR_CODE_MESSAGES entry — so every operator
   who tripped it got the generic 422 fallback and no idea which lever they had
   pulled. Same shape as the 35 silent write paths in BUG-HISTORY: the server
   refused correctly and told nobody why. */
describe('SO price-floor refusal', () => {
  it('names the action instead of falling through to the generic message', () => {
    const message = humanApiError(422, JSON.stringify({
      error: 'so_total_below_original',
      reason: 'Changes cannot reduce the bill below the original sales order total.',
      itemCode: 'SOFA-A',
      previous: 500000,
      next: 400000,
    }));

    expect(message).toMatch(/below what the customer already agreed to/i);
    expect(message).toMatch(/put the amount back/i);
    // House rule: no codes, no raw JSON, no DB internals in an operator sentence.
    expect(message).not.toMatch(/422|so_total_below_original|centi/);
  });
});
