import { describe, expect, test, vi } from 'vitest';
import { startEarly } from './start-early';

describe('startEarly', () => {
  test('awaiting it later still gets the value and still rejects', async () => {
    await expect(startEarly(Promise.resolve(7))).resolves.toBe(7);
    await expect(startEarly(Promise.reject(new Error('read failed')))).rejects.toThrow('read failed');
  });

  test('a rejection left behind by an early return is handled, not unhandled', () => {
    const p = Promise.reject(new Error('left behind'));
    const handled = vi.spyOn(p, 'catch');
    expect(startEarly(p)).toBe(p);
    expect(handled).toHaveBeenCalledTimes(1);
  });
});
