/* Who is told about a payment backdate request (owner 2026-09-30: Owner +
 * Super Admin + Finance). The wildcard roles are in the audience ON PURPOSE —
 * unlike the amendment / cancellation notices. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';

const holders: Record<string, number[]> = {};
vi.mock('./permissionHolders', () => ({ usersHoldingPermission: async (_env: unknown, key: string) => holders[key] ?? [] }));
const posted = vi.fn(async (_env: unknown, _n: { userIds: number[]; title: string; body: string }) => undefined);
vi.mock('./personalNotice', () => ({ postPersonalNotice: (env: unknown, n: { userIds: number[]; title: string; body: string }) => posted(env, n) }));

const { notifyBackdateRequest } = await import('./backdateRequestNotify');
const ENV = {} as Env;
const base = { docNo: 'SO-1', amount: 'RM 500.00', slipDate: '2026-09-10', companyId: 1 };

beforeEach(() => {
  holders['scm.payment.backdate'] = [30, 31];
  holders['*'] = [1, 31];
  posted.mockClear();
});

describe('notifyBackdateRequest', () => {
  it('a raised request reaches Finance AND the wildcard admins, once each, never the raiser', async () => {
    await notifyBackdateRequest(ENV, 'raised', { ...base, reason: 'late slip', requesterUserId: 30, requesterName: 'Fin', actorUserId: 30 });
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0]![1].userIds.sort()).toEqual([1, 31]);
    expect(posted.mock.calls[0]![1].body).toContain('late slip');
  });

  it('a decision reaches the requester only, and not when they decided it themselves', async () => {
    await notifyBackdateRequest(ENV, 'rejected', { ...base, reason: 'no bank line', requesterUserId: 11, actorUserId: 1, actorName: 'Owner' });
    expect(posted.mock.calls[0]![1]).toMatchObject({ userIds: [11] });
    expect(posted.mock.calls[0]![1].body).toContain('no bank line');
    posted.mockClear();
    await notifyBackdateRequest(ENV, 'approved', { ...base, requesterUserId: 1, actorUserId: 1 });
    expect(posted).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    posted.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyBackdateRequest(ENV, 'raised', { ...base, actorUserId: 99 })).resolves.toBeUndefined();
  });
});
