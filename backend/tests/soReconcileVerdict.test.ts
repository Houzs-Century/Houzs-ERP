/* The SPECIFICATION for "does this migrated sales order still differ from the
   account book?" (backend/src/scm/lib/so-reconcile-verdict.ts).

   ONE PROPERTY carries the whole file and every case below is a way of trying
   to break it:

       ONLY `clean` OPENS. Every other answer LOCKS.

   The permissive answer must be unreachable by a read that did not run, by a
   measurement that has expired, and by a row that was never published. That is
   the same position so-is-migrated.ts takes, and it is what separates this gate
   from theatre: an origin-grained lock fails safe by accident (everything is
   shut), a correctness-grained one only fails safe on purpose. */
import { describe, expect, test } from 'vitest';
import {
  readSoVerdict,
  soVerdictFromRow,
  VERDICT_MAX_AGE_MS,
  type SoVerdictRow,
} from '../src/scm/lib/so-reconcile-verdict';

const NOW = Date.parse('2026-09-08T06:00:00.000Z');
const fresh = (over: Partial<SoVerdictRow> = {}): SoVerdictRow => ({
  clean: true,
  axes: [],
  measured_at: new Date(NOW - 60_000).toISOString(),
  ...over,
});

describe('soVerdictFromRow', () => {
  test('a fresh CLEAN row is the only thing that opens', () => {
    expect(soVerdictFromRow(fresh(), NOW).kind).toBe('clean');
  });

  test('a fresh row that is not clean DIFFERS, and carries its axes', () => {
    const v = soVerdictFromRow(fresh({ clean: false, axes: ['document total'] }), NOW);
    expect(v.kind).toBe('differs');
    expect(v.kind === 'differs' && v.axes).toEqual(['document total']);
  });

  /* ABSENT MUST MEAN LOCKED. A document nobody has published a verdict for is
     the single most likely state during a cutover — the reconcile has not run
     yet, or it ran and never reached this document — and it is the one case
     where "no news is good news" would be catastrophic. */
  test('NO ROW is unknown, never clean', () => {
    expect(soVerdictFromRow(null, NOW)).toEqual({ kind: 'unknown', why: 'no-verdict-published' });
  });

  test('a verdict older than the max age EXPIRES to unknown', () => {
    const old = fresh({ measured_at: new Date(NOW - VERDICT_MAX_AGE_MS - 1000).toISOString() });
    expect(soVerdictFromRow(old, NOW)).toEqual({ kind: 'unknown', why: 'verdict-stale' });
  });

  test('a verdict exactly at the max age still stands — the boundary is not off by one', () => {
    const edge = fresh({ measured_at: new Date(NOW - VERDICT_MAX_AGE_MS).toISOString() });
    expect(soVerdictFromRow(edge, NOW).kind).toBe('clean');
  });

  /* An unparseable timestamp answers 'stale' rather than falling through a NaN
     comparison that happens to be false. The behaviour is the same either way
     TODAY; the point is that it is asserted, so a refactor cannot flip it. */
  test('an unreadable measured_at is stale, not fresh', () => {
    expect(soVerdictFromRow(fresh({ measured_at: 'not a date' }), NOW))
      .toEqual({ kind: 'unknown', why: 'verdict-stale' });
  });

  /* A publisher bug that lost the axis list must not be able to OPEN a
     document. It costs the reason, not the lock. */
  test('not clean with NO axes still differs', () => {
    const v = soVerdictFromRow(fresh({ clean: false, axes: null }), NOW);
    expect(v.kind).toBe('differs');
    expect(v.kind === 'differs' && v.axes).toEqual([]);
  });

  test('a stale row that is NOT clean is still locked — staleness cannot rescue it', () => {
    const v = soVerdictFromRow(
      fresh({ clean: false, axes: ['quantity'], measured_at: new Date(NOW - VERDICT_MAX_AGE_MS - 1).toISOString() }),
      NOW,
    );
    expect(v.kind).not.toBe('clean');
  });
});

describe('readSoVerdict', () => {
  const row = { doc_no: 'HC-SO-000001', clean: true, axes: [], measured_at: new Date(NOW - 1000).toISOString() };

  test('reads a clean row', async () => {
    const v = await readSoVerdict(async () => ({ data: row, error: null }), 'HC-SO-000001', NOW);
    expect(v.kind).toBe('clean');
  });

  /* THE CASE THAT DECIDES WHETHER THIS GATE IS SAFE. A failed read has to be
     unable to look like the permissive answer, whether it fails by returning an
     error or by throwing. */
  test('an ERRORED read locks', async () => {
    const v = await readSoVerdict(async () => ({ data: null, error: { message: 'boom' } }), 'X', NOW);
    expect(v).toEqual({ kind: 'unknown', why: 'verdict-read-failed' });
  });

  test('a THROWN read locks', async () => {
    const v = await readSoVerdict(() => { throw new Error('boom'); }, 'X', NOW);
    expect(v).toEqual({ kind: 'unknown', why: 'verdict-read-failed' });
  });

  test('a missing row locks', async () => {
    const v = await readSoVerdict(async () => ({ data: null, error: null }), 'X', NOW);
    expect(v).toEqual({ kind: 'unknown', why: 'no-verdict-published' });
  });

  /* PostgREST has already been caught in this repo returning camelCase where
     snake_case was expected. Here that would read as "no measurement", which
     locks every document at once and looks exactly like an outage. */
  test('camelCase measuredAt is accepted', async () => {
    const v = await readSoVerdict(
      async () => ({ data: { clean: true, axes: [], measuredAt: new Date(NOW - 1000).toISOString() }, error: null }),
      'X',
      NOW,
    );
    expect(v.kind).toBe('clean');
  });

  test('a row with no timestamp at all locks', async () => {
    const v = await readSoVerdict(async () => ({ data: { clean: true, axes: [] }, error: null }), 'X', NOW);
    expect(v).toEqual({ kind: 'unknown', why: 'verdict-read-failed' });
  });

  /* `clean` is compared with === true, so no truthy impostor gets through. */
  test.each([1, 'true', 'yes', {}])('clean = %p (truthy, not boolean) does NOT open', async (v) => {
    const got = await readSoVerdict(
      async () => ({ data: { clean: v, axes: [], measured_at: new Date(NOW - 1000).toISOString() }, error: null }),
      'X',
      NOW,
    );
    expect(got.kind).not.toBe('clean');
  });
});
