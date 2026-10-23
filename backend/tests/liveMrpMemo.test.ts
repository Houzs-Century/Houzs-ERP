import { beforeEach, describe, expect, it, vi } from 'vitest';

const computeMrp = vi.fn();
vi.mock('../src/scm/routes/mrp', () => ({ computeMrp: (...a: unknown[]) => computeMrp(...a) }));
vi.mock('../src/services/agents/procurement-learning', () => ({ loadLeadBuffers: async () => ({}) }));

import { LIVE_MRP_TTL_MS, forgetLiveMrp, forgetLiveMrpOnWrite, sharedLiveMrp } from '../src/scm/lib/live-mrp-memo';

const db = {} as D1Database;

beforeEach(() => {
  forgetLiveMrp();
  computeMrp.mockReset();
  computeMrp.mockImplementation(async () => ({ skus: [], sofaSets: [] }));
});

/* HC-0002: the SO list's Stock column and the SO detail's /coverage share one
   live MRP run. These pin when a held run may answer and when it must not. */
describe('sharedLiveMrp', () => {
  it('reuses one run for the same company inside the window', async () => {
    let t = 1_000;
    await sharedLiveMrp({}, db, 1, null, () => t).result;
    t += LIVE_MRP_TTL_MS - 1;
    await sharedLiveMrp({}, db, 1, null, () => t).result;
    expect(computeMrp).toHaveBeenCalledTimes(1);
  });

  it('runs again once the window has passed', async () => {
    let t = 1_000;
    await sharedLiveMrp({}, db, 1, null, () => t).result;
    t += LIVE_MRP_TTL_MS;
    await sharedLiveMrp({}, db, 1, null, () => t).result;
    expect(computeMrp).toHaveBeenCalledTimes(2);
  });

  it('a second caller joins a run still in flight', async () => {
    let release!: () => void;
    computeMrp.mockImplementation(() => new Promise((r) => { release = () => r({ skus: [], sofaSets: [] }); }));
    const a = sharedLiveMrp({}, db, 1);
    const b = sharedLiveMrp({}, db, 1);
    expect(b.result).toBe(a.result);
    await Promise.resolve();
    release();
    await a.result;
    expect(computeMrp).toHaveBeenCalledTimes(1);
  });

  it('keeps companies apart', async () => {
    await sharedLiveMrp({}, db, 1).result;
    await sharedLiveMrp({}, db, 2).result;
    expect(computeMrp).toHaveBeenCalledTimes(2);
    expect(computeMrp.mock.calls.map((c) => (c[1] as { companyId: number }).companyId)).toEqual([1, 2]);
  });

  it('asks for the same run the detail and the list always asked for', async () => {
    await sharedLiveMrp({}, db, 1).result;
    expect(computeMrp.mock.calls[0][1]).toMatchObject({ catFilter: null, whFilter: null, includeUndated: true, companyId: 1 });
  });

  it('an order saved after the held run started gets a fresh run', async () => {
    const t = Date.parse('2026-10-22T02:00:00Z');
    await sharedLiveMrp({}, db, 1, null, () => t).result;
    await sharedLiveMrp({}, db, 1, '2026-10-22T02:00:05Z', () => t + 10_000).result;
    expect(computeMrp).toHaveBeenCalledTimes(2);
  });

  it('an order saved before the held run started reuses it', async () => {
    const t = Date.parse('2026-10-22T02:00:00Z');
    await sharedLiveMrp({}, db, 1, null, () => t).result;
    await sharedLiveMrp({}, db, 1, '2026-10-22T01:59:00Z', () => t + 10_000).result;
    expect(computeMrp).toHaveBeenCalledTimes(1);
  });

  it('a failed run is not held', async () => {
    computeMrp.mockRejectedValueOnce(new Error('pool'));
    await expect(sharedLiveMrp({}, db, 1).result).rejects.toThrow('pool');
    await sharedLiveMrp({}, db, 1).result;
    expect(computeMrp).toHaveBeenCalledTimes(2);
  });
});

describe('forgetLiveMrpOnWrite', () => {
  const ctx = (method: string, status: number) => ({ req: { method }, res: { status } }) as never;

  it('a successful write drops the held run', async () => {
    await sharedLiveMrp({}, db, 1).result;
    await forgetLiveMrpOnWrite()(ctx('POST', 200), async () => {});
    await sharedLiveMrp({}, db, 1).result;
    expect(computeMrp).toHaveBeenCalledTimes(2);
  });

  it('a read, or a refused write, keeps it', async () => {
    await sharedLiveMrp({}, db, 1).result;
    await forgetLiveMrpOnWrite()(ctx('GET', 200), async () => {});
    await forgetLiveMrpOnWrite()(ctx('PATCH', 409), async () => {});
    await sharedLiveMrp({}, db, 1).result;
    expect(computeMrp).toHaveBeenCalledTimes(1);
  });
});
