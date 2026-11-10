// A write in one tab refreshes the others' screens — but a HIDDEN tab must not
// re-read anything until it is shown, and then only once. A hidden Merchant
// Recon tab used to re-read every report on it after every save made anywhere.

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { listenForWrites } from './cross-tab-sync';

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

const rig = () => {
  const qc = new QueryClient();
  const queryFn = vi.fn(async () => 'rows');
  /* An on-screen query, already read: observed, so invalidation refetches it. */
  qc.setQueryData(['settlement-batch', 1], 'rows');
  const unobserve = new QueryObserver(qc, { queryKey: ['settlement-batch', 1], queryFn, staleTime: Infinity }).subscribe(() => {});
  const ch = { onmessage: null } as unknown as BroadcastChannel;
  const stop = listenForWrites(qc, ch);
  const send = (data: unknown) => (ch.onmessage as (e: MessageEvent) => void)({ data } as MessageEvent);
  const write = () => send({ t: 'changed' });
  return { qc, queryFn, write, send, stop: () => { stop(); unobserve(); } };
};

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; setVisibility('visible'); });

describe('a write in another tab', () => {
  test('a visible tab re-reads what is on screen at once', async () => {
    setVisibility('visible');
    const r = rig(); cleanup = r.stop;
    r.write();
    await vi.waitFor(() => expect(r.queryFn).toHaveBeenCalledTimes(1));
  });

  test('a hidden tab re-reads nothing — then once when shown, however many writes it missed', async () => {
    setVisibility('hidden');
    const r = rig(); cleanup = r.stop;
    r.write(); r.write(); r.write();
    await new Promise((res) => setTimeout(res, 20));
    expect(r.queryFn).not.toHaveBeenCalled();
    /* Marked stale, so a screen opened while hidden still reads fresh. */
    expect(r.qc.getQueryState(['settlement-batch', 1])?.isInvalidated).toBe(true);

    setVisibility('visible');
    await vi.waitFor(() => expect(r.queryFn).toHaveBeenCalledTimes(1));
    /* Shown again with nothing new: no further read. */
    setVisibility('hidden'); setVisibility('visible');
    await new Promise((res) => setTimeout(res, 20));
    expect(r.queryFn).toHaveBeenCalledTimes(1);
  });

  test('a message that is not a write changes nothing', async () => {
    setVisibility('visible');
    const r = rig(); cleanup = r.stop;
    r.send({ t: 'hello' });
    r.send(null);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.queryFn).not.toHaveBeenCalled();
  });
});
