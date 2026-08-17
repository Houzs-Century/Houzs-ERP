import { describe, expect, test } from 'vitest';
import { readStatusCounts } from './status-counts';

/* The whole point of this helper is the difference between "none" and "we could
   not find out", which `count ?? 0` erased. Each test below is one side of that
   line — the empty-bucket case is not padding, it is the case that must NOT
   become an error, and it is what a naive "treat a falsy count as a failure"
   fix would have broken on every list with an unused status tab. */

describe('readStatusCounts', () => {
  test('an empty bucket is a fact, not a failure', () => {
    const read = readStatusCounts({
      all: { count: 12, error: null },
      cancelled: { count: 0, error: null },
    });
    expect(read).toEqual({ ok: true, counts: { all: 12, cancelled: 0 } });
  });

  test('a failed count is reported by BUCKET NAME, never served as 0', () => {
    const read = readStatusCounts({
      all: { count: 27, error: null },
      delivered: { count: null, error: { message: 'invalid input value for enum do_status: "COMPLETED"' } },
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('delivered');
    expect(read.reason).toContain('COMPLETED');
  });

  test('a missing count with no error is still a failure', () => {
    // supabase-js leaves `count` null when the Content-Range header it parses
    // is absent. "The server never told us" is not "the server said none".
    const read = readStatusCounts({ all: { count: null, error: null } });
    expect(read).toEqual({ ok: false, reason: 'all count returned no value' });
  });

  test('an error with no message still names the bucket', () => {
    const read = readStatusCounts({ paid: { count: null, error: {} } });
    expect(read).toEqual({ ok: false, reason: 'paid count failed: unknown error' });
  });

  test('the FIRST failing bucket wins, in the map order the caller wrote', () => {
    const read = readStatusCounts({
      all: { count: 5, error: null },
      open: { count: null, error: { message: 'first' } },
      closed: { count: null, error: { message: 'second' } },
    });
    expect(read).toEqual({ ok: false, reason: 'open count failed: first' });
  });
});
