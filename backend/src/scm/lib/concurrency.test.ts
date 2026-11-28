import { describe, expect, test, vi } from 'vitest';
import { mapBounded, eager } from './concurrency';

type UnhandledHost = {
  on(event: 'unhandledRejection', listener: (e: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (e: unknown) => void): void;
};
const unhandledHost = (globalThis as { process?: UnhandledHost }).process;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mapBounded', () => {
  test('returns results in INPUT order, not completion order', async () => {
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
    const thunk = await held;
    expect(() => thunk()).toThrow('load failed');
  });

  test('a rejection that is never read does not become an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    expect(unhandledHost).toBeDefined();
    unhandledHost!.on('unhandledRejection', onUnhandled);
    try {
      void eager(Promise.reject(new Error('never read')));
      await tick(20);
    } finally {
      unhandledHost!.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  test('error PRECEDENCE is preserved when two reads are hoisted together', async () => {
    const first = eager((async () => { await tick(20); throw new Error('first'); })());
    const second = eager((async () => { await tick(1); throw new Error('second'); })());
    const a = await first;
    const b = await second;
    expect(() => a()).toThrow('first');
    expect(() => b()).toThrow('second');
  });
});
