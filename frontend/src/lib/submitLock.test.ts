import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { settleMutation, useKeyedSubmitLock, useSubmitLock } from './submitLock';

describe('useSubmitLock', () => {
  it('refuses a second save while the first is in flight, and frees itself after', async () => {
    const { result } = renderHook(() => useSubmitLock());
    let finish: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));

    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.run(save);
      void result.current.run(save);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.locked).toBe(true);

    await act(async () => { finish(); await first; });
    expect(result.current.locked).toBe(false);
    await act(async () => { void result.current.run(save); });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a failed save frees the lock too', async () => {
    const { result } = renderHook(() => useSubmitLock());
    await act(async () => { await result.current.run(() => Promise.reject(new Error('refused'))).catch(() => undefined); });
    expect(result.current.locked).toBe(false);
  });
});

describe('useKeyedSubmitLock', () => {
  it('holds each row on its own', async () => {
    const { result } = renderHook(() => useKeyedSubmitLock());
    const save = vi.fn(() => new Promise<void>(() => {}));
    await act(async () => {
      void result.current.run('a', save);
      void result.current.run('a', save);
      void result.current.run('b', save);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.isLocked('a')).toBe(true);
    expect(result.current.isLocked('c')).toBe(false);
  });
});

describe('settleMutation', () => {
  it('settles only after the success callback has finished its own awaits', async () => {
    const steps: string[] = [];
    let answer: (data: string) => void = () => {};
    const mutate = (_vars: number, o: { onSuccess: (d: string) => void; onError: (e: unknown) => void }) => { answer = o.onSuccess; };
    const done = settleMutation(mutate, 1, {
      onSuccess: async (d: string) => { await Promise.resolve(); steps.push(`posted payments after ${d}`); },
      onError: () => steps.push('error'),
    }).then(() => steps.push('settled'));
    answer('create');
    await done;
    expect(steps).toEqual(['posted payments after create', 'settled']);
  });
});
