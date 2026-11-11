// A write in one tab refreshes the others' screens: only the queries that write
// touched (a PO save must not re-read the Delivery Planning board), everything
// for a legacy / unscoped message, and a HIDDEN tab re-reads nothing until it is
// shown, then once. A hidden Merchant Recon tab used to re-read every report on
// it after every save made anywhere.

import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { claimCrossTabRefresh, createWriteBroadcaster, listenForWrites, type WriteMessage } from './cross-tab-sync';

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

const pause = () => new Promise((res) => setTimeout(res, 20));

const rig = () => {
  const qc = new QueryClient();
  const observers: Array<() => void> = [];
  /* An on-screen query, already read: observed, so invalidation refetches it. */
  const onScreen = (queryKey: QueryKey, data: unknown = 'rows') => {
    const queryFn = vi.fn(async () => data);
    qc.setQueryData(queryKey, data);
    observers.push(new QueryObserver(qc, { queryKey, queryFn, staleTime: Infinity }).subscribe(() => {}));
    return queryFn;
  };
  const so = onScreen(['mfg-sales-orders', 1]);
  const po = onScreen(['mfg-purchase-orders', 1]);
  const ch = { onmessage: null } as unknown as BroadcastChannel;
  const stop = listenForWrites(qc, ch);
  const send = (data: unknown) => (ch.onmessage as (e: MessageEvent) => void)({ data } as MessageEvent);
  const write = (keys?: QueryKey[]) => send(keys ? { t: 'changed', keys } : { t: 'changed' });
  return { qc, so, po, onScreen, write, send, stop: () => { stop(); observers.forEach((u) => u()); } };
};

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((c) => c()); cleanup = []; setVisibility('visible'); });

describe('a write in another tab', () => {
  test('a save of SOs re-reads only the SO queries', async () => {
    setVisibility('visible');
    const r = rig(); cleanup.push(r.stop);
    r.write([['mfg-sales-orders']]);
    await vi.waitFor(() => expect(r.so).toHaveBeenCalledTimes(1));
    await pause();
    expect(r.po).not.toHaveBeenCalled();
    expect(r.qc.getQueryState(['mfg-purchase-orders', 1])?.isInvalidated).toBe(false);
  });

  test('a legacy / unknown message re-reads everything on screen', async () => {
    setVisibility('visible');
    const r = rig(); cleanup.push(r.stop);
    r.write();
    r.send({ t: 'changed', keys: 'so' });
    await vi.waitFor(() => { expect(r.so).toHaveBeenCalled(); expect(r.po).toHaveBeenCalled(); });
  });

  test('a hidden tab re-reads nothing, then once when shown, however many writes it missed', async () => {
    setVisibility('hidden');
    const r = rig(); cleanup.push(r.stop);
    r.write([['mfg-sales-orders']]); r.write([['mfg-sales-orders', 1]]); r.write([['mfg-sales-orders']]);
    await pause();
    expect(r.so).not.toHaveBeenCalled();
    /* Marked stale, so a screen opened while hidden still reads fresh. */
    expect(r.qc.getQueryState(['mfg-sales-orders', 1])?.isInvalidated).toBe(true);

    setVisibility('visible');
    await vi.waitFor(() => expect(r.so).toHaveBeenCalledTimes(1));
    await pause();
    expect(r.po).not.toHaveBeenCalled();
    /* Shown again with nothing new: no further read. */
    setVisibility('hidden'); setVisibility('visible');
    await pause();
    expect(r.so).toHaveBeenCalledTimes(1);
  });

  test('a hidden tab given a legacy message re-reads everything once when shown', async () => {
    setVisibility('hidden');
    const r = rig(); cleanup.push(r.stop);
    r.write(); r.write();
    await pause();
    expect(r.so).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.waitFor(() => { expect(r.so).toHaveBeenCalledTimes(1); expect(r.po).toHaveBeenCalledTimes(1); });
  });

  test('a message that is not a write changes nothing', async () => {
    setVisibility('visible');
    const r = rig(); cleanup.push(r.stop);
    r.send({ t: 'hello' });
    r.send(null);
    await pause();
    expect(r.so).not.toHaveBeenCalled();
  });

  test('a claimed query (the DP board rows) is refreshed by its claim, not re-read', async () => {
    setVisibility('visible');
    const r = rig(); cleanup.push(r.stop);
    const board = r.onScreen(['delivery-planning', 'ALL', 'OPEN', 'band', 1], { orders: [] });
    const lines = r.onScreen(['delivery-planning', 'lines', 'SO-1']);
    const refresh = vi.fn();
    cleanup.push(claimCrossTabRefresh({ owns: (q) => q.queryKey[3] === 'band', refresh }));
    r.write([['delivery-planning']]);
    await vi.waitFor(() => expect(lines).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(board).not.toHaveBeenCalled();

    /* Hidden: the claim waits for the tab to be shown, like everything else. */
    setVisibility('hidden');
    r.write([['delivery-planning']]);
    await pause();
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(board).not.toHaveBeenCalled();
  });
});

describe('the writing tab', () => {
  const sender = () => {
    const qc = new QueryClient();
    const sent: WriteMessage[] = [];
    const b = createWriteBroadcaster(qc, (m) => sent.push(m));
    const save = async (onSuccess: () => unknown) => {
      const m = qc.getMutationCache().build(qc, { mutationFn: async () => 'ok', onSuccess });
      b.succeeded(m);
      await onSuccess();
      b.settled(m);
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    };
    return { qc, sent, save, b };
  };

  test('sends the keys its mutation invalidated', async () => {
    const s = sender();
    await s.save(() => { void s.qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] }); void s.qc.invalidateQueries({ queryKey: ['delivery-planning'] }); });
    expect(s.sent).toEqual([{ t: 'changed', keys: [['mfg-sales-orders'], ['delivery-planning']] }]);
  });

  test('a mutation that invalidated nothing, or by predicate, sends no keys (receiver re-reads everything)', async () => {
    const s = sender();
    await s.save(() => undefined);
    expect(s.sent).toEqual([{ t: 'changed' }]);
    const t = sender();
    await t.save(() => { void t.qc.invalidateQueries({ queryKey: ['x'] }); void t.qc.invalidateQueries({ predicate: () => true }); });
    expect(t.sent).toEqual([{ t: 'changed' }]);
  });

  test('an invalidation outside a write (a poll) is not broadcast', async () => {
    const s = sender();
    void s.qc.invalidateQueries({ queryKey: ['delivery-planning'] });
    await pause(); await pause(); await pause();
    expect(s.sent).toEqual([]);
  });
});
