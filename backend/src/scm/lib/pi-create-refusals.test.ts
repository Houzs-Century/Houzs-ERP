/* The create's refusal bodies have to SURVIVE THE CLIENT, and its rollback has
   to be believed only when it is proven.
 *
 * The sentences are not decoration. humanApiError
 * (frontend/src/vendor/scm/lib/authed-fetch.ts) drops a server sentence that is
 * 200 characters or more, starts with a brace, is code-shaped, or contains
 * internals vocabulary — and falls back to a generic status line. That is
 * exactly what happened on 2026-08-19: these bodies carried a `reason` copied
 * from the driver and nothing else, so a Purchase Invoice create that had
 * refused for a specific, statable reason reached the operator as "The system
 * hit a problem." A message that gets filtered is a message nobody reads, so
 * the shape is asserted here rather than trusted — the same posture
 * tests/entityAudit.test.ts takes for the audit refusal.
 *
 * `rollbackPi` is the money half. Both compensating branches release the
 * operator's idempotency key on its `true`, and a released key over a surviving
 * header is how a corrected resubmit mints a SECOND invoice. */
import { describe, expect, it, vi } from 'vitest';

import { insertFailed, loadFailed, rollbackPi, committedAnyway } from './pi-create-refusals';

/* The client's filter, copied from authed-fetch.ts so a change there shows up
   here as a failing assertion rather than as a silent blank on the screen. */
const survivesTheClient = (s: string) =>
  !!s && s.length < 200 && !s.trim().startsWith('{')
  && !/^[a-z][a-z0-9_]*$/.test(s.trim())
  && !/violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i.test(s);

describe('the bodies say something an operator can act on', () => {
  it('insertFailed reaches the screen, and says nothing was recorded', () => {
    const b = insertFailed('null value in column "material_kind" violates not-null constraint');
    expect(b.error).toBe('insert_failed');
    expect(survivesTheClient(b.message)).toBe(true);
    /* The single fact that decides what the operator does next. */
    expect(b.message).toContain('nothing was recorded');
    /* The driver's text is KEPT — for the log and for anyone reading the
       response — but it is a separate field, so it cannot drag the sentence
       through the filter with it. */
    expect(b.reason).toContain('material_kind');
  });

  it('insertFailed carries the line-insert code when the header was rolled back', () => {
    expect(insertFailed('boom', 'items_insert_failed').error).toBe('items_insert_failed');
  });

  /* A driver error with no message at all still produces a body — `reason: null`
     rather than a key that disappears from the JSON. */
  it('a missing driver message leaves an explicit null, not an absent field', () => {
    const b = insertFailed(undefined);
    expect(b.reason).toBeNull();
    expect(JSON.parse(JSON.stringify(b))).toHaveProperty('reason', null);
  });

  it('loadFailed names what could not be checked, and still fits', () => {
    const b = loadFailed(
      'relation "scm.grns" does not exist',
      'check whether this receipt was carried over from the account book',
    );
    expect(b.error).toBe('load_failed');
    expect(survivesTheClient(b.message)).toBe(true);
    expect(b.message).toContain('NOT saved');
    expect(b.message).toContain('carried over from the account book');
  });

  /* The longest `what` any call site passes must still fit — the filter is a
     cliff, not a taper, and 200 characters is one word away from these. */
  it('the message stays under the client\'s 200-character cliff', () => {
    expect(loadFailed('x', 'check whether this receipt was carried over from the account book').message.length)
      .toBeLessThan(200);
    expect(insertFailed('x').message.length).toBeLessThan(200);
  });
});

describe('rollbackPi answers whether the undo actually happened', () => {
  const sb = (error: { message: string } | null) => {
    const calls: Array<{ table: string; id: unknown }> = [];
    return {
      calls,
      from: (table: string) => ({
        delete: () => ({ eq: async (_col: string, id: unknown) => { calls.push({ table, id }); return { error }; } }),
      }),
    };
  };

  it('deletes the header and reports a PROVEN undo', async () => {
    const client = sb(null);
    await expect(rollbackPi(client, 'pi-1', 'HC-PI-2608-001')).resolves.toBe(true);
    expect(client.calls).toEqual([{ table: 'purchase_invoices', id: 'pi-1' }]);
  });

  /* THE ONE THAT MATTERS. A delete that errored leaves a real invoice with no
     lines; answering `true` here would release the idempotency claim over it and
     let the corrected resubmit mint a second one beside it. */
  it('reports false when the delete errored, so the caller keeps the claim', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(rollbackPi(sb({ message: 'deadlock detected' }), 'pi-1', 'HC-PI-2608-001'))
      .resolves.toBe(false);
    /* And it is findable: the document number rides the log. */
    expect(err.mock.calls[0]?.[0]).toContain('HC-PI-2608-001');
    err.mockRestore();
  });
});

describe('committedAnyway keeps a saved invoice from being reported as a failure', () => {
  it('swallows a throw and names the document in the log', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(committedAnyway('HC-PI-2608-001', async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    })).resolves.toBeUndefined();
    expect(err.mock.calls[0]?.[0]).toContain('HC-PI-2608-001');
    expect(err.mock.calls[0]?.[0]).toContain('the invoice IS saved');
    err.mockRestore();
  });

  /* It is a guard, not a muffler: the happy path runs and nothing is logged. */
  it('runs the work and stays silent when nothing goes wrong', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let ran = 0;
    await committedAnyway('HC-PI-2608-001', async () => { ran += 1; });
    expect(ran).toBe(1);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
