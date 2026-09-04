/* The amendment notice exists because an approval used to sit in a queue that
 * nothing pointed at. Three things have to hold for it to be worth having, and
 * each of them fails silently — which is why they are pinned here rather than
 * left to a read of the file.
 *
 *  1. IT REACHES THE DESK THAT CAN SIGN. The lane decides the permission key,
 *     and the notice audience is derived from that key. If this table ever
 *     drifts from the one the GATE reads (scm/shared/amendment-lane.ts), the
 *     notice goes to people who then cannot act on it — a bug that looks like
 *     working software from every angle except the one that matters.
 *
 *  2. IT DOES NOT REACH EVERYONE. Owner and IT Admin carry the '*' wildcard, so
 *     a literal "who can approve this" read would put the owner on every
 *     amendment ever raised. A channel that pings you about work that is not
 *     yours is a channel you turn off, and then the real notice is lost too.
 *
 *  3. IT DOES NOT CROSS COMPANIES. Houzs and 2990 share this table; a 2990
 *     amendment must not land on a Houzs-only desk.
 */
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

// Reporting chain: 41 reports to 40, 40 to nobody. 42 stands alone.
vi.mock('./orgScope', () => ({
  uplineUserIds: async (_env: unknown, id: number) =>
    id === 41 ? [41, 40] : [id],
}));

const { notifySoAmendmentRaised, notifySoAmendmentResolved } = await import('./amendmentNotify');
const { usersHoldingPermission } = await import('./permissionHolders');
const { LANE_APPROVE_KEY } = await import('../scm/shared/amendment-lane');

/* One role table, one user table, one grant table — enough for the resolver.
   Roles: 10 Purchaser (lines), 11 Logistic (delivery), 12 Owner ('*').
   Users: 41 purchaser (Houzs+2990), 42 purchaser (2990 only), 43 logistics
   (no grants at all — the single-company shape), 44 owner. */
const ROLES = [
  { id: 10, permissions: '["scm.amendment.approve_lines","scm.po_amendment.approve"]' },
  { id: 11, permissions: '["scm.amendment.approve_delivery"]' },
  { id: 12, permissions: '["*"]' },
];
const USERS = [
  { id: 41, role_id: 10, status: 'active' },
  { id: 42, role_id: 10, status: 'active' },
  { id: 43, role_id: 11, status: 'active' },
  { id: 44, role_id: 12, status: 'active' },
  { id: 45, role_id: 10, status: 'disabled' },
];
const GRANTS = [
  { user_id: 41, company_id: 1 },
  { user_id: 41, company_id: 2 },
  { user_id: 42, company_id: 2 },
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
    // Not a tautology: amendmentNotify holds its own copy (a Houzs-side service
    // must not import the SCM bundle), and a copy is exactly what drifts.
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-1/A1', soDocNo: 'SO-1', lane: 'LINES', companyId: 1,
    });
    // 41 holds approve_lines and reports to 40 — both notified, 43 (delivery)
    // and 44 (wildcard) are not.
    expect(posted[0].userIds.sort()).toEqual([40, 41]);

    posted.length = 0;
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-1/A2', soDocNo: 'SO-1', lane: 'DELIVERY', companyId: null,
    });
    expect(posted[0].userIds).toEqual([43]);

    // And the two tables agree, key for key.
    expect(LANE_APPROVE_KEY.LINES).toBe('scm.amendment.approve_lines');
    expect(LANE_APPROVE_KEY.DELIVERY).toBe('scm.amendment.approve_delivery');
  });

  it('never notifies the wildcard (owner / IT admin) roles', async () => {
    const ids = await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_lines');
    expect(ids).not.toContain(44);
    expect(ids).toContain(41);
    // …nor a disabled account.
    expect(ids).not.toContain(45);
  });

  it('drops a user granted only the OTHER company, keeps one with no grants', async () => {
    // Company 1: 42 is 2990-only and must not hear about a Houzs amendment.
    expect(await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_lines', { companyId: 1 }))
      .toEqual([41]);
    // Company 2: both purchasers are granted it.
    expect((await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_lines', { companyId: 2 })).sort())
      .toEqual([41, 42]);
    // 43 holds ZERO grant rows — the single-company / pre-activation shape,
    // where companyContext never consults the table. Filtering them out would
    // silence the delivery lane entirely on a one-company install.
    expect(await usersHoldingPermission(fakeEnv(), 'scm.amendment.approve_delivery', { companyId: 1 }))
      .toEqual([43]);
  });

  it('tells the salesperson separately, and tells the requester nothing', async () => {
    await notifySoAmendmentRaised(fakeEnv(), {
      amendmentNo: 'SO-9/A1',
      soDocNo: 'SO-9',
      lane: 'LINES',
      companyId: 1,
      requesterUserId: 40,        // also sits in the approver upline
      salespersonUserId: 77,
      requesterName: 'Ivy',
      reason: 'customer changed the fabric',
    });
    const approver = posted.find((p) => p.title.includes('needs approval'))!;
    expect(approver.userIds).toEqual([41]);      // 40 raised it — excluded
    const sales = posted.find((p) => p.title.includes('your Sales Order'))!;
    expect(sales.userIds).toEqual([77]);
    expect(sales.body).toContain('by Ivy');
    expect(sales.body).toContain('customer changed the fabric');
    expect(new Set(posted.map((p) => p.source))).toEqual(new Set(['so_amendment']));
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
