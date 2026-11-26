import { describe, expect, test } from 'vitest';
import { humanApiError } from './authed-fetch';


const GENERIC_409 = 'That clashes with something already in the system. Please refresh and check.';
const body = (o: unknown) => JSON.stringify(o);

describe('over-receipt refusal reaches the operator', () => {
  test('qty_exceeds_remaining is a plain reason, not the generic 409', () => {
    const shown = humanApiError(409, body({
      error: 'qty_exceeds_remaining', poItemId: 'poi-1', requested: 1, remaining: 0,
    }));
    expect(shown).not.toBe(GENERIC_409);
    expect(shown).toMatch(/already .*received/i);
    expect(shown).toMatch(/refresh/i);
  });
});
