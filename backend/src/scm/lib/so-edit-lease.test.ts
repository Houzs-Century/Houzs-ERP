// ----------------------------------------------------------------------------
// THE SAVE LOCK: how long it lives, and what it says when a save hits one.
//
// Owner, 2026-09-03, working alone on HC-SO-013361 and unable to save it:
//
//   「我现在一个人只能 edit 一次，不可以呀。我一 save 了，我一 edit，关了就是关了？」
//   「为什么是 5 分钟呢？不是看 live 的吗？」
//
// Both questions were right. A save of his had timed out (a 504 in his console)
// and left its lease behind; for the next FIVE MINUTES every retry answered
// "This order is being saved on another screen." There was no other screen, and
// nothing ever checks whether one is alive - the row holds a token and an
// expiry, nothing more.
//
// Two properties are pinned here. The lock is bounded to a length that covers
// one save rather than an editing session, and the refusal no longer claims to
// know something the row cannot tell it.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  SO_EDIT_LEASE_MS,
  soEditLeaseExpiryIso,
  soEditLeaseRefusal,
  soEditLeaseTakeoverAllowed,
} from './so-edit-lease';
import { lockSoCommandLease } from './pg-supabase-transaction';

describe('the lock covers one save, not an editing session', () => {
  /* The frontend reserves the lease, acts, and releases it in a `finally`
     (so-versioned-mutation.ts). Opening an order takes no lock at all, so the
     expiry only has to outlast one round trip. Everything beyond that is time a
     document spends locked for nothing after a save dies. */
  test('it is one minute, and long enough for a save round trip', () => {
    expect(SO_EDIT_LEASE_MS).toBe(60_000);
    expect(SO_EDIT_LEASE_MS).toBeGreaterThanOrEqual(30_000);
    /* THE REGRESSION. Five minutes is what locked the owner out of his own
       order after one timed-out save. */
    expect(SO_EDIT_LEASE_MS).toBeLessThan(5 * 60_000);
  });

  test('the expiry is minted from that one constant', () => {
    const now = Date.parse('2026-09-03T00:00:00.000Z');
    expect(soEditLeaseExpiryIso(now)).toBe(new Date(now + SO_EDIT_LEASE_MS).toISOString());
  });
});

describe('the refusal says which of the three, and never guesses a person', () => {
  /* ONE MESSAGE FOR FOUR STATES is what sent him looking for a colleague who
     was not there. The row records a token and an expiry; it does not record
     WHO, so no message may assert another screen. */
  test('only HELD may speak of another person, and the other two never do', () => {
    /* Since mig 0348 the holder is recorded and the same person takes their own
       lock back, so a refusal that reaches `held` really is somebody else. The
       other two are about THIS screen and must not blame anyone. */
    for (const reason of ['expired', 'missing'] as const) {
      const m = soEditLeaseRefusal(reason).message;
      expect(m, `${reason} blames another screen`).not.toMatch(/another screen|someone else/i);
    }
    expect(soEditLeaseRefusal('held').message).toMatch(/someone else/i);
  });

  test('each one tells the operator what to do next', () => {
    expect(soEditLeaseRefusal('held').message).toMatch(/wait/i);
    expect(soEditLeaseRefusal('expired').message).toMatch(/reload/i);
    expect(soEditLeaseRefusal('missing').message).toMatch(/reload/i);
    /* Their changes survive a refusal, and saying so is what stops a retype. */
    for (const reason of ['held', 'expired', 'missing'] as const) {
      expect(soEditLeaseRefusal(reason).message).toMatch(/changes are still here/i);
    }
  });

  test('the wire code is unchanged — only the wording and the reason are new', () => {
    expect(soEditLeaseRefusal('held').error).toBe('so_edit_lease_conflict');
    expect(soEditLeaseRefusal('expired').reason).toBe('expired');
  });
});

describe('lockSoCommandLease tells the three apart', () => {
  const rowSql = (row: Record<string, unknown> | null) => ({
    unsafe: async () => (row ? [row] : []),
  }) as never;

  const live = () => new Date(Date.now() + 30_000).toISOString();
  const dead = () => new Date(Date.now() - 30_000).toISOString();

  test('no token supplied is MISSING, not held', async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 3, edit_lease_token: 'other', edit_lease_expires_at: live() }),
      'HC-SO-1', '', 1, 7,
    );
    expect(r).toEqual({ ok: false, reason: 'lease', lease: 'missing' });
  });

  /* THE CASE THAT WAS MISREPORTED. His own dead save's lock had lapsed, and the
     screen was told somebody else was saving. */
  test('a lapsed lock is EXPIRED, not held', async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 3, edit_lease_token: 'mine', edit_lease_expires_at: dead() }),
      'HC-SO-1', 'mine', 1, 7,
    );
    expect(r).toEqual({ ok: false, reason: 'lease', lease: 'expired' });
  });

  test('a live lock with a different token is HELD', async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 3, edit_lease_token: 'theirs', edit_lease_expires_at: live() }),
      'HC-SO-1', 'mine', 1, 7,
    );
    expect(r).toEqual({ ok: false, reason: 'lease', lease: 'held' });
  });

  test('the caller holding a live lock is let through', async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 7, edit_lease_token: 'mine', edit_lease_expires_at: live() }),
      'HC-SO-1', 'mine', 1, 7,
    );
    expect(r).toEqual({ ok: true, version: 7 });
  });

  test('a document that is not there is still not_found, not a lock problem', async () => {
    const r = await lockSoCommandLease(rowSql(null), 'HC-SO-1', 'mine', 1, 7);
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('the same person takes their own lock back — mig 0348', () => {
  /* 「锁记住是谁上的 —— 同一个人直接拿回自己的锁」. A lock left by your own crashed
     save is not a colleague editing, and waiting it out protects nobody. */
  test('same holder, different token, is allowed', () => {
    expect(soEditLeaseTakeoverAllowed(7, 7)).toBe(true);
    /* bigint arrives as a STRING from the driver; both shapes must work or the
       takeover silently stops applying in production only. */
    expect(soEditLeaseTakeoverAllowed('7', 7)).toBe(true);
    expect(soEditLeaseTakeoverAllowed(7, '7')).toBe(true);
  });

  test('a different person is NEVER taken over', () => {
    expect(soEditLeaseTakeoverAllowed(7, 8)).toBe(false);
  });

  /* ABSENCE IS THE STRICTER ANSWER. A lock written before 0348, or by a path
     with no authenticated user, has no holder and is never taken over. */
  test('an unknown holder or an unknown caller is never taken over', () => {
    expect(soEditLeaseTakeoverAllowed(null, 7)).toBe(false);
    expect(soEditLeaseTakeoverAllowed(7, null)).toBe(false);
    expect(soEditLeaseTakeoverAllowed(undefined, undefined)).toBe(false);
    expect(soEditLeaseTakeoverAllowed('', 7)).toBe(false);
    expect(soEditLeaseTakeoverAllowed('  ', 7)).toBe(false);
  });
});

describe('lockSoCommandLease honours the takeover', () => {
  const rowSql = (row: Record<string, unknown>) => ({
    unsafe: async () => [row],
  }) as never;
  const live = () => new Date(Date.now() + 30_000).toISOString();

  test("the caller's own live lock under a different token is taken over", async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 4, edit_lease_token: 'a-dead-save', edit_lease_expires_at: live(), edit_lease_user_id: 7 }),
      'HC-SO-1', 'mine', 1, 7,
    );
    expect(r).toEqual({ ok: true, version: 4 });
  });

  test("somebody else's live lock is still refused", async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 4, edit_lease_token: 'theirs', edit_lease_expires_at: live(), edit_lease_user_id: 8 }),
      'HC-SO-1', 'mine', 1, 7,
    );
    expect(r).toEqual({ ok: false, reason: 'lease', lease: 'held' });
  });

  test('a pre-0348 lock has no holder and is refused, not taken over', async () => {
    const r = await lockSoCommandLease(
      rowSql({ version: 4, edit_lease_token: 'old', edit_lease_expires_at: live(), edit_lease_user_id: null }),
      'HC-SO-1', 'mine', 1, 7,
    );
    expect(r).toEqual({ ok: false, reason: 'lease', lease: 'held' });
  });
});
