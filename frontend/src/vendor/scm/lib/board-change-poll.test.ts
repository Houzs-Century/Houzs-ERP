/* Owner 2026-10-27 option B: the board re-reads only the orders others changed. */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const rowRefresh = vi.fn();
vi.mock('./board-row-refresh', () => ({ scheduleRowRefresh: (_qc: unknown, docs: string[]) => rowRefresh(docs) }));
vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
const { applyChanges, editingDocs } = await import('./board-change-poll');

describe('applyChanges', () => {
  it('re-reads the changed orders, except one with an edit still in flight here', async () => {
    rowRefresh.mockReset();
    const qc = new QueryClient();
    let release: () => void = () => undefined;
    const m = qc.getMutationCache().build(qc, { networkMode: 'always', mutationFn: () => new Promise<void>((r) => { release = r; }) });
    const running = m.execute({ type: 'so', id: 'SO-2' });
    await new Promise((r) => setTimeout(r, 0));   // the mutation starts asynchronously
    expect([...editingDocs(qc)]).toEqual(['SO-2']);
    applyChanges(qc, { cursor: 5, docs: ['SO-1', 'SO-2'], others: false, full: false }, { at: 0 }, 1_000);
    expect(rowRefresh).toHaveBeenCalledWith(['SO-1']);
    release(); await running;
  });
  it('a service / DP / project change re-reads the board, at most every 2 minutes', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const last = { at: 0 };
    applyChanges(qc, { cursor: 5, docs: [], others: true, full: false }, last, 200_000);
    applyChanges(qc, { cursor: 6, docs: [], others: true, full: false }, last, 250_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
