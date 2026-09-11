/* Who is told what when a cancellation request moves (owner 2026-09-08).
 * The keys here are literals so the Houzs-side service does not import the
 * SCM bundle; the first test is the referee that keeps them equal to the
 * gate's own table, so the desk notified is always the desk that can sign. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';

const holders = vi.fn(async (_env: unknown, perm: string) => {
  if (perm.endsWith('approve_l1')) return [21, 22];
  if (perm.endsWith('approve_l2')) return [31];
  return [];
});
const posted = vi.fn(async (_env: unknown, _opts: unknown) => undefined);
vi.mock('./permissionHolders', () => ({ usersHoldingPermission: (...a: unknown[]) => holders(...(a as [unknown, string])) }));
vi.mock('./personalNotice', () => ({ postPersonalNotice: (env: unknown, opts: unknown) => posted(env, opts) }));

const { CANCEL_APPROVE_PERM, notifyCancelRequest } = await import('./cancelRequestNotify');
const { CANCEL_APPROVE_KEY } = await import('../scm/shared/document-cancel');

const env = {} as Env;
const base = { docType: 'SO' as const, docNumber: 'SO-1', reason: 'Customer cancelled', companyId: 1, requesterUserId: 11, requesterName: 'Amy' };

beforeEach(() => { holders.mockClear(); posted.mockClear(); });

describe('cancelRequestNotify', () => {
  it('holds the same permission keys as the gate', () => {
    expect(CANCEL_APPROVE_PERM).toEqual(CANCEL_APPROVE_KEY);
  });

  it('raised → the level-1 desk, minus the person who raised it', async () => {
    holders.mockResolvedValueOnce([11, 21, 22]);
    await notifyCancelRequest(env, 'raised', { ...base, actorUserId: 11 });
    expect(holders).toHaveBeenCalledWith(env, 'scm.so_cancel.approve_l1', { companyId: 1 });
    expect(posted).toHaveBeenCalledTimes(1);
    const call = posted.mock.calls[0]![1] as { userIds: number[]; title: string; body: string; source: string };
    expect(call.userIds).toEqual([21, 22]);
    expect(call.title).toContain('level-1');
    expect(call.body).toContain('Amy');
    expect(call.body).toContain('Customer cancelled');
    expect(call.source).toBe('document_cancel');
  });

  it('level1 → the level-2 desk on a Sales Order; a Purchase Order has no desk to tell', async () => {
    await notifyCancelRequest(env, 'level1', { ...base, actorUserId: 21, actorName: 'Ben' });
    expect(holders).toHaveBeenCalledWith(env, 'scm.so_cancel.approve_l2', { companyId: 1 });
    const call = posted.mock.calls[0]![1] as { userIds: number[]; title: string; body: string };
    expect(call.userIds).toEqual([31]);
    expect(call.title).toContain('Sales Order SO-1');
    expect(call.title).toContain('level-2');
    expect(call.body).toContain('by Ben');
    posted.mockClear(); holders.mockClear();
    await notifyCancelRequest(env, 'level1', { ...base, docType: 'PO', docNumber: 'PO-7', actorUserId: 21 });
    expect(holders).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  /* Owner 2026-09-09 — a Purchase Order cancel needs no approval, so there is
     no desk to notify at any step. The cancellation is still recorded with its
     reason; nobody is asked to act on it. */
  it('a Purchase Order tells nobody, at any step', async () => {
    for (const event of ['raised', 'level1', 'approved'] as const) {
      await notifyCancelRequest(env, event, { ...base, docType: 'PO', docNumber: 'PO-7', actorUserId: 11 });
    }
    expect(holders).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it('approved / rejected → the requester only, never about their own action', async () => {
    await notifyCancelRequest(env, 'approved', { ...base, actorUserId: 31, actorName: 'Cara' });
    expect(posted.mock.calls[0]![1]).toMatchObject({ userIds: [11], title: expect.stringContaining('approved') });
    await notifyCancelRequest(env, 'rejected', { ...base, reason: 'Already in production', actorUserId: 21 });
    expect(posted.mock.calls[1]![1]).toMatchObject({ userIds: [11], body: expect.stringContaining('Already in production') });
    await notifyCancelRequest(env, 'rejected', { ...base, actorUserId: 11 });
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it('never throws', async () => {
    holders.mockRejectedValueOnce(new Error('D1 down'));
    await expect(notifyCancelRequest(env, 'raised', base)).resolves.toBeUndefined();
    expect(posted).not.toHaveBeenCalled();
  });
});
