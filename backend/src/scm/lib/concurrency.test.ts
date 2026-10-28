// What these pin, and why each one is here rather than trusted.
//
// mapBounded replaces sequential `for (…) await …` loops in the MRP engine. Two
// properties make that swap safe, and neither is self-evident from reading it:
// results come back in INPUT order (so a caller that concatenates them cannot
// notice), and the number in flight never exceeds the bound (so a shared
// connection pool cannot be exhausted — the owner's "must not destabilise"
// rule, expressed as an assertion).
//
// eager exists to keep error PRECEDENCE identical when reads are hoisted into a
// wave. The failure it prevents is silent: an un-awaited rejected promise is an
// unhandled rejection, which in a Worker kills the request instead of returning
// the route's 500.
import { describe, expect, test, vi } from 'vitest';
import { mapBounded, eager } from './concurrency';

/* The backend tsconfig targets Workers and does not declare `process`, so reach
   it through globalThis with an explicit shape. The test ASSERTS it is present
   rather than skipping when it is not — a guard that silently turns the check
   off is how a test comes to pass over nothing. */
type UnhandledHost = {
  on(event: 'unhandledRejection', listener: (e: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (e: unknown) => void): void;
};
const unhandledHost = (globalThis as { process?: UnhandledHost }).process;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mapBounded', () => {
  test('returns results in INPUT order, not completion order', async () => {
    // Deliberately inverted delays: if the implementation returned results as
    // they settled, this comes back reversed.
    const out = await mapBounded([1, 2, 3, 4, 5], 5, async (n) => {
      await tick((6 - n) * 5);
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  test('never exceeds the bound, and does use it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapBounded(items, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(2);
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // If this drops to 1 the helper has silently become a sequential loop and
    // the whole reason for it is gone, with every test still green.
    expect(maxInFlight).toBe(4);
  });

  test('a bound larger than the work does not over-spawn workers', async () => {
    let calls = 0;
    const out = await mapBounded([1, 2], 50, async (n) => { calls++; return n; });
    expect(out).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  test('an empty list does no work and returns empty', async () => {
    const fn = vi.fn(async (n: number) => n);
    expect(await mapBounded([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test('processes every item exactly once', async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 37 }, (_, i) => i);
    await mapBounded(items, 5, async (i) => { seen.push(i); return i; });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  test('a rejection propagates', async () => {
    await expect(mapBounded([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });

  test('refuses a bound below 1 rather than silently running unbounded', async () => {
    await expect(mapBounded([1], 0, async (n) => n)).rejects.toThrow(/limit must be >= 1/);
  });
});

describe('eager', () => {
  test('a resolved value is returned by the thunk', async () => {
    const v = await eager(Promise.resolve({ data: [1], error: null }));
    expect(v()).toEqual({ data: [1], error: null });
  });

  test('the error is re-thrown at the point of USE, not at creation', async () => {
    const held = eager(Promise.reject(new Error('load failed')));
    // Awaiting the holder must NOT throw — that is what lets a caller await
    // several of these and still decide the order errors surface in.
    const thunk = await held;
    expect(() => thunk()).toThrow('load failed');
  });

  test('a rejection that is never read does not become an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    expect(unhandledHost).toBeDefined();
    unhandledHost!.on('unhandledRejection', onUnhandled);
    try {
      // Created, never read — exactly the hazard of hoisting a read into a wave
      // and then throwing earlier for an unrelated reason.
      void eager(Promise.reject(new Error('never read')));
      await tick(20);
    } finally {
      unhandledHost!.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  test('error PRECEDENCE is preserved when two reads are hoisted together', async () => {
    // Both fail; the SECOND one fails first in wall-clock terms. Sequential code
    // would surface the FIRST one, because it awaited it first. eager must keep
    // that, which a Promise.all would not.
    const first = eager((async () => { await tick(20); throw new Error('first'); })());
    const second = eager((async () => { await tick(1); throw new Error('second'); })());
    const a = await first;
    const b = await second;
    expect(() => a()).toThrow('first');
    expect(() => b()).toThrow('second');
  });
});
