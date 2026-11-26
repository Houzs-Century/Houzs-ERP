import { describe, expect, test } from 'vitest';
import { readStatusCounts, tallyStatusRows } from './status-counts';


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
      (r) => r.cnt,
    );
    expect(read).toEqual({ ok: true, byStatus: { CONFIRMED: 35, DELIVERED: 33 } });
  });
});
