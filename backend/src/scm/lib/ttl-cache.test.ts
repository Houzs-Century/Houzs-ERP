import { describe, expect, test } from 'vitest';
import { ttlCached } from './ttl-cache';

describe('ttlCached', () => {
  test('loads once inside the window, again after it, per key', async () => {
    const store = new Map<string, { at: number; p: Promise<number> }>();
    let t = 0; let n = 0;
    const load = async () => ++n;
    const get = (k: string) => ttlCached(store, k, 1000, load, () => t);
    expect(await get('a')).toBe(1);
    expect(await get('a')).toBe(1);
    expect(await get('b')).toBe(2);
    t = 1000;
    expect(await get('a')).toBe(3);
  });

  test('a failed load is not kept', async () => {
    const store = new Map<string, { at: number; p: Promise<number> }>();
    let n = 0;
    const load = async () => { if (++n === 1) throw new Error('db down'); return n; };
    await expect(ttlCached(store, 'a', 1000, load)).rejects.toThrow('db down');
    expect(await ttlCached(store, 'a', 1000, load)).toBe(2);
  });
});
