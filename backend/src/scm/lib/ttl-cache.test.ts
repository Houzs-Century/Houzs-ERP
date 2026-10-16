import { afterEach, describe, expect, test, vi } from 'vitest';
import { ttlCached } from './ttl-cache';

type Store = Map<string, { at: number; v: number }>;

describe('ttlCached', () => {
  afterEach(() => vi.useRealTimers());

  test('loads once inside the window, again after it, per key', async () => {
    const store: Store = new Map();
    vi.useFakeTimers(); vi.setSystemTime(0);
    let n = 0;
    const get = (k: string) => ttlCached(store, k, 1000, async () => ++n);
    expect(await get('a')).toBe(1);
    expect(await get('a')).toBe(1);
    expect(await get('b')).toBe(2);
    vi.setSystemTime(1000);
    expect(await get('a')).toBe(3);
  });

  test('a failed load is not kept', async () => {
    const store: Store = new Map();
    let n = 0;
    const load = async () => { if (++n === 1) throw new Error('db down'); return n; };
    await expect(ttlCached(store, 'a', 1000, load)).rejects.toThrow('db down');
    expect(await ttlCached(store, 'a', 1000, load)).toBe(2);
  });

  test('a degraded result is returned but not kept', async () => {
    const store: Store = new Map();
    let n = 0;
    const load = async () => (++n === 1 ? 0 : n);
    const keep = (v: number) => v > 0;
    expect(await ttlCached(store, 'a', 1000, load, keep)).toBe(0);
    expect(await ttlCached(store, 'a', 1000, load, keep)).toBe(2);
    expect(await ttlCached(store, 'a', 1000, load, keep)).toBe(2);
  });
});
