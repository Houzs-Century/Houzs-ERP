import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Env } from '../types';

const posted: Array<{ userIds: number[]; title: string; body: string; source: string }> = [];

type NoticeArgs = { userIds: number[]; title: string; body: string; source: string };

vi.mock('./personalNotice', () => ({
  postPersonalNotice: async (_env: unknown, opts: NoticeArgs) => {
    posted.push({
      userIds: [...opts.userIds],
      title: opts.title,
      body: opts.body,
      source: opts.source,
    });
  },
}));

vi.mock('./orgScope', () => ({
  uplineUserIds: async (_env: unknown, id: number) =>
    id === 41 ? [41, 40, 39, 38] : [id],
}));

const { notifySoAmendmentRaised, notifySoAmendmentResolved, notifySoAmendmentHandedOver } = await import('./amendmentNotify');
const { usersHoldingPermission } = await import('./permissionHolders');
const { LANE_APPROVE_KEY } = await import('../scm/shared/amendment-lane');

/* One role table, one user table, one grant table — enough for the resolver.
   Roles: 10 Purchaser (lines), 11 Logistic (delivery), 12 Owner ('*'),
   13 Finance/price approver (the 2990 PRICE lane, owner 2026-09-21).
   Users: 41 purchaser (Houzs+2990), 42 purchaser (2990 only), 43 logistics
   (no grants at all — the single-company shape), 44 owner, 46 price approver
   (Houzs+2990, like Kris). */
const ROLES = [
  { id: 10, permissions: '["scm.amendment.approve_lines","scm.po_amendment.approve"]' },
  { id: 11, permissions: '["scm.amendment.approve_delivery"]' },
  { id: 12, permissions: '["*"]' },
  { id: 13, permissions: '["scm.amendment.approve_price"]' },
];
const USERS = [
  { id: 41, role_id: 10, status: 'active' },
  { id: 42, role_id: 10, status: 'active' },
  { id: 43, role_id: 11, status: 'active' },
  { id: 44, role_id: 12, status: 'active' },
  { id: 45, role_id: 10, status: 'disabled' },
  { id: 46, role_id: 13, status: 'active' },
];
const GRANTS = [
  { user_id: 41, company_id: 1 },
  { user_id: 41, company_id: 2 },
  { user_id: 42, company_id: 2 },
  { user_id: 46, company_id: 1 },
  { user_id: 46, company_id: 2 },
];

function fakeEnv() {
  const run = (sql: string, args: unknown[]) => {
    if (/FROM roles/.test(sql)) return { results: ROLES };
    if (/FROM users/.test(sql)) {
      const ids = args.map(Number);
      return {
        results: USERS.filter((u) => u.status === 'active' && ids.includes(u.role_id)),
      };
    }
    if (/FROM user_companies/.test(sql)) {
      const ids = args.map(Number);
      return { results: GRANTS.filter((g) => ids.includes(g.user_id)) };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...a: unknown[]) => { args = a; return stmt; },
          all: async () => run(sql, args),
        };
        return stmt;
      },
    },
  } as unknown as Env;
}

beforeEach(() => { posted.length = 0; });

describe('amendment notice audience', () => {
  it('routes each lane to the SAME key its approval gate checks', async () => {
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-1/A1', soDocNo: 'SO-1', lane: 'LINES', companyId: 1,
    });
    expect(posted[0].userIds.sort()).toEqual([40, 41]);

    posted.length = 0;
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-1/A2', soDocNo: 'SO-1', lane: 'DELIVERY', companyId: null,
    });
    expect(posted[0].userIds).toEqual([43]);

    posted.length = 0;
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: '2990-SO-1/A3', soDocNo: '2990-SO-1', lane: 'PRICE', companyId: 2,
    });
    expect(posted[0].userIds).toEqual([46]);

    posted.length = 0;
    // An add/cancel-line lane reaches the SAME Sales Director key (owner 2026-11-16).
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: '2990-SO-1/A4', soDocNo: '2990-SO-1', lane: 'LINE_ADDREMOVE', companyId: 2,
    });
    expect(posted[0].userIds).toEqual([46]);

    expect(LANE_APPROVE_KEY.LINES).toBe('scm.amendment.approve_lines');
    expect(LANE_APPROVE_KEY.DELIVERY).toBe('scm.amendment.approve_delivery');
    expect(LANE_APPROVE_KEY.PRICE).toBe('scm.amendment.approve_price');
    expect(LANE_APPROVE_KEY.LINE_ADDREMOVE).toBe('scm.amendment.approve_price');
  });

  it('never notifies the wildcard (owner / IT admin) roles', async () => {
    const ids = await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_lines');
    expect(ids).not.toContain(44);
    expect(ids).toContain(41);
    expect(ids).not.toContain(45);
  });

  it('drops a user granted only the OTHER company, keeps one with no grants', async () => {
    expect(await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_lines', { companyId: 1 }))
      .toEqual([41]);
    expect((await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_lines', { companyId: 2 })).sort())
      .toEqual([41, 42]);
    expect(await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_delivery', { companyId: 1 }))
      .toEqual([43]);
  });

  it('tells the salesperson separately, and tells the requester nothing', async () => {
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-9/A1',
      soDocNo: 'SO-9',
      lane: 'LINES',
      companyId: 1,
      requesterUserId: 40,
      salespersonUserId: 77,
      requesterName: 'Ivy',
      reason: 'customer changed the fabric',
    });
    const approver = posted.find((p) => p.title.includes('needs approval'))!;
    expect(approver.userIds).toEqual([41]);
    const sales = posted.find((p) => p.title.includes('your Sales Order'))!;
    expect(sales.userIds).toEqual([77]);
    expect(sales.body).toContain('by Ivy');
    expect(sales.body).toContain('customer changed the fabric');
    expect(new Set(posted.map((p) => p.source))).toEqual(new Set(['so_amendment']));
    expect(posted.some((p) => p.title.includes('wrong desk'))).toBe(false);
  });

  /* Owner 2026-09-17, option B: an approver who says "not mine" PASSES the
     request to the other desk. That desk gets a to-do card — it now waits on
     them — carrying the note; the requester is told it changed hands; the
     approver who passed it on hears nothing back. */
  it('a handover gives the receiving desk a to-do and tells the requester, never the one who passed it', async () => {
    await notifySoAmendmentHandedOver(fakeEnv(), {
      amendmentNo: 'SO-12757/A1',
      soDocNo: 'SO-12757',
      fromLane: 'LINES',
      toLane: 'DELIVERY',
      companyId: 1,
      note: 'transport charge, Logistic approves these',
      actorName: 'Purchaser Pat',
      actorUserId: 41,
      requesterUserId: 77,
      byAdmin: false,
    });
    const todo = posted.find((p) => p.title.includes('needs approval'))!;
    expect(todo.userIds).toEqual([43]);
    expect(todo.body).toContain('Purchaser Pat (product lines approver) passed amendment SO-12757/A1 on Sales Order SO-12757 to you as not theirs to approve: ');
    expect(todo.body).toContain('transport charge, Logistic approves these');
    expect(todo.body).toContain('waiting for delivery / customer info approval');
    expect(todo.source).toBe('so_amendment');
    const requester = posted.find((p) => p.title.includes('was passed to another approver'))!;
    expect(requester.userIds).toEqual([77]);
    expect(posted.flatMap((p) => p.userIds)).not.toContain(41);
  });

  it('an admin changing the approver is named as the admin, not as the desk that had it', async () => {
    await notifySoAmendmentHandedOver(fakeEnv(), {
      amendmentNo: 'SO-12757/A1', soDocNo: 'SO-12757', fromLane: 'LINES', toLane: 'DELIVERY', companyId: 1,
      note: 'transport charge', actorName: 'Admin Ann', actorUserId: 1, requesterUserId: 77, byAdmin: true,
    });
    const todo = posted.find((p) => p.title.includes('needs approval'))!;
    expect(todo.body).toContain('Admin Ann (admin) passed amendment SO-12757/A1 on Sales Order SO-12757 to you: transport charge');
    expect(todo.body).not.toContain('not theirs');
  });

  it('carries the rejection reason to the requester and the salesperson', async () => {
    await notifySoAmendmentResolved(fakeEnv(), {
      amendmentNo: 'SO-9/A1',
      soDocNo: 'SO-9',
      outcome: 'rejected',
      reason: 'price below floor',
      actorName: 'Ken',
      actorUserId: 41,
      requesterUserId: 40,
      salespersonUserId: 77,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0].userIds.sort()).toEqual([40, 77]);
    expect(posted[0].body).toContain('price below floor');
    expect(posted[0].body).toContain('by Ken');
  });

  it('leaves the top two levels of the reporting chain out of the audience', async () => {
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-7/A1', soDocNo: 'SO-7', lane: 'LINES', companyId: 1,
    });
    const audience = posted[0].userIds;
    expect(audience.sort()).toEqual([40, 41]);
    expect(audience).not.toContain(39);
    expect(audience).not.toContain(38);
  });

  it('still reaches an approver who reports straight to the top', async () => {
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-8/A1', soDocNo: 'SO-8', lane: 'DELIVERY', companyId: null,
    });
    expect(posted[0].userIds).toEqual([43]);
  });

  it('says nothing when the only person to tell is the one who acted', async () => {
    await notifySoAmendmentResolved(fakeEnv(), {
      amendmentNo: 'SO-9/A1', soDocNo: 'SO-9', outcome: 'approved',
      actorUserId: 40, requesterUserId: 40, salespersonUserId: null,
    });
    expect(posted).toHaveLength(0);
  });

  it('swallows a lookup failure rather than failing the amendment write', async () => {
    const brokenEnv = {
      DB: { prepare: () => { throw new Error('db down'); } },
    } as unknown as Env;
    await expect(
      notifySoAmendmentRaised(brokenEnv, {
        amendmentNo: 'SO-9/A1', soDocNo: 'SO-9', lane: 'LINES',
      }),
    ).resolves.toBeUndefined();
    expect(posted).toHaveLength(0);
  });
});
