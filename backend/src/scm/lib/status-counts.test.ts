import { describe, expect, test } from 'vitest';
import { readStatusCounts, tallyStatusRows } from './status-counts';

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

/* The same line, drawn for the OTHER shape: `data ?? []` is `count ?? 0` wearing
   a different hat. PostgREST and paginateAll both answer a failed read with
   `{ data: null, error }`, so tallying `res.data ?? []` turns a failure into
   ZERO ROWS — which is what served the SO list's pills as all-zero beside a full
   page of orders, and what left the Delivery Agent's DO pipeline reporting a
   failed bucket as simply absent. */

describe('tallyStatusRows', () => {
  test('a failed read is a failure, NOT an empty tally', () => {
    const read = tallyStatusRows(
      { data: null, error: { message: 'invalid input value for enum do_status: "COMPLETED"' } },
      () => 1,
    );
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toContain('COMPLETED');
  });

  test('a genuinely empty result is a tally of nothing, not a failure', () => {
    expect(tallyStatusRows({ data: [], error: null }, () => 1)).toEqual({ ok: true, byStatus: {} });
  });

  test('no error and no rows object is still a failure', () => {
    const read = tallyStatusRows({ data: null, error: null }, () => 1);
    expect(read).toEqual({ ok: false, reason: 'status rows returned no value' });
  });

  test('an ABSENT data property is the same failure as a null one', () => {
    // The reason `data` is typed `T[] | null | undefined`: every caller reads
    // through an `sb: any` client, so a response object with no `data` at all
    // is a state that reaches here. Without the undefined arm of the guard this
    // falls through to `for (const row of undefined)` — a TypeError, not an
    // answer — and with the arm but a narrower type, lint calls the arm dead.
    // This is what says the arm is live.
    const read = tallyStatusRows({ data: undefined, error: null }, () => 1);
    expect(read).toEqual({ ok: false, reason: 'status rows returned no value' });
  });

  test('raw rows tally one each; blank and lowercase statuses are not lost', () => {
    const read = tallyStatusRows(
      { data: [{ status: 'DRAFT' }, { status: 'draft' }, { status: null }, { status: '' }], error: null },
      () => 1,
    );
    expect(read).toEqual({ ok: true, byStatus: { DRAFT: 2, UNKNOWN: 2 } });
  });

  test('a grouped aggregate tallies by its OWN count, not one per group', () => {
    const read = tallyStatusRows<{ status: string | null; cnt: number }>(
      { data: [{ status: 'CONFIRMED', cnt: 35 }, { status: 'DELIVERED', cnt: 33 }], error: null },
      // `r.cnt`, not `Number(r.cnt ?? 0)`: the row shape is declared right here,
      // so the `?? 0` could never fire and only made the assertion look like it
      // covered a missing count when it does not.
      (r) => r.cnt,
    );
    expect(read).toEqual({ ok: true, byStatus: { CONFIRMED: 35, DELIVERED: 33 } });
  });
});
