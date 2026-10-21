/* HC-0136: a product request reaches the Purchaser's bell, like an SO
 * amendment does — literal holders of the approve key, never the requester. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { PRODUCT_REQUEST_APPROVE_KEY } from '../scm/routes/product-requests';

const holders: Record<string, number[]> = {};
const asked = vi.fn((_key: string, _opts: unknown) => undefined);
vi.mock('./permissionHolders', () => ({
  usersHoldingPermission: async (_env: unknown, key: string, opts: unknown) => { asked(key, opts); return holders[key] ?? []; },
}));
const posted = vi.fn(async (_env: unknown, _n: { userIds: number[]; title: string; body: string; source: string }) => undefined);
vi.mock('./personalNotice', () => ({ postPersonalNotice: (env: unknown, n: { userIds: number[]; title: string; body: string; source: string }) => posted(env, n) }));

const { notifyProductRequest, PRODUCT_REQUEST_APPROVE_PERM } = await import('./productRequestNotify');
const ENV = {} as Env;
const base = { requestNo: 'HC-PDR-2610-004', companyId: 1, requesterUserId: 31, requesterName: 'Amy Tan', products: 'Aurora (new) ×2; 5530-3S ×1', lineCount: 2 };

beforeEach(() => {
  holders['scm.product_request.approve'] = [9, 31];
  holders['*'] = [1];
  posted.mockClear();
  asked.mockClear();
});

describe('notifyProductRequest', () => {
  it('asks for the same key the approve gate checks', () => {
    expect(PRODUCT_REQUEST_APPROVE_PERM).toBe(PRODUCT_REQUEST_APPROVE_KEY);
  });

  it('a raised request reaches the approve-key holders of its company, not the requester and not the wildcard roles', async () => {
    await notifyProductRequest(ENV, 'raised', base);
    expect(asked).toHaveBeenCalledWith('scm.product_request.approve', { companyId: 1 });
    expect(posted).toHaveBeenCalledTimes(1);
    const n = posted.mock.calls[0]![1];
    expect(n.userIds).toEqual([9]);
    expect(n.source).toBe('product_request');
    expect(n.title).toBe('HC-PDR-2610-004 — product request needs approval');
    expect(n.body).toContain('from Amy Tan');
    expect(n.body).toContain('2 lines: Aurora (new) ×2; 5530-3S ×1');
  });

  it('a resubmitted request says it came back', async () => {
    await notifyProductRequest(ENV, 'resubmitted', { ...base, lineCount: 1, products: '5530-3S ×1' });
    expect(posted.mock.calls[0]![1].body).toContain('changed and sent again by Amy Tan (1 line: 5530-3S ×1)');
  });

  it('no Purchaser holds the key: nothing is posted', async () => {
    holders['scm.product_request.approve'] = [31];
    await notifyProductRequest(ENV, 'raised', base);
    expect(posted).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    posted.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyProductRequest(ENV, 'raised', base)).resolves.toBeUndefined();
  });
});
