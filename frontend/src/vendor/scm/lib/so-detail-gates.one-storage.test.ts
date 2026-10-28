import { describe, expect, test } from 'vitest';
import { procLockActive } from './so-detail-gates';
import { todayMyt } from './dates';

/* THE FRONTEND HALF OF "ONE PROCESSING DATE" (owner 2026-08-18, naming the
 * scope: frontend, backend AND database).
 *
 * procLockActive used to end `return Boolean(header.proceeded_at)` — a second
 * storage, consulted only when the caller had no `status`. The justification at
 * the time was "so we never over-lock a status-blind header": without a status
 * we cannot tell a DRAFT from a CONFIRMED, and over-locking a DRAFT blocks an
 * edit the operator is entitled to make with no way round it in the UI.
 *
 * That protection is preserved by a STRONGER mechanism — `status` is now
 * required on this function's parameter — so the tests below pin both halves:
 * the date alone decides, and the direction the deleted marker protected is
 * still the direction taken.
 *
 * The populations are real. probe-proceed-split, prod, 2026-08-18, run
 * 32093080121: company 1 has 2724 live orders (519 carrying a Processing Date,
 * 2205 not, zero disagreeing); company 2 has 77 live (21 both, 5 date-only,
 * 16 stamp-only, 35 neither). Every combination asserted here is one of those. */

const shift = (days: number): string => {
  const d = new Date(`${todayMyt()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const past = shift(-1);
const future = shift(1);

describe('the Processing Date alone decides the lock', () => {
  /* company 1: 519 both-set live (440 CONFIRMED, 79 READY_TO_SHIP).
     company 2: 21 both-set live (14 CONFIRMED, 7 READY_TO_SHIP). */
  test.each(['CONFIRMED', 'READY_TO_SHIP', 'IN_PRODUCTION'])(
    'a %s order past its processing day is locked', (status) => {
      expect(procLockActive({ processing_date: past, status })).toBe(true);
    },
  );

  /* company 2's date-only class: 5 live orders, all CONFIRMED. They were
     already locked by the date before this change and must not move. */
  test('a date with no stamp still locks — it always did', () => {
    expect(procLockActive({ processing_date: past, status: 'CONFIRMED' })).toBe(true);
  });

  /* company 2's stamp-only class: 16 live orders (12 CONFIRMED, 4
     READY_TO_SHIP). No date means nothing has elapsed, so the editor stays
     open. This is the assertion that fails if anyone reintroduces
     "locked if EITHER column says proceeded". */
  test.each(['CONFIRMED', 'READY_TO_SHIP'])(
    'a %s order with no Processing Date is never process-locked', (status) => {
      expect(procLockActive({ processing_date: null, status })).toBe(false);
      expect(procLockActive({ status })).toBe(false);
    },
  );

  test('today is still open; only the day AFTER locks', () => {
    expect(procLockActive({ processing_date: todayMyt(), status: 'CONFIRMED' })).toBe(false);
    expect(procLockActive({ processing_date: future, status: 'CONFIRMED' })).toBe(false);
  });

  test('DRAFT and CANCELLED stay editable past the date', () => {
    expect(procLockActive({ processing_date: past, status: 'DRAFT' })).toBe(false);
    expect(procLockActive({ processing_date: past, status: 'CANCELLED' })).toBe(false);
    expect(procLockActive({ processing_date: past, status: 'cancelled' })).toBe(false);
  });
});

describe('what the deleted proceeded_at marker was protecting', () => {
  /* The old fallback answered the question "no status — should I lock?" with
     "only if there is a Proceed stamp". With one storage there is no second
     signal, so the answer is the side that never blocks an entitled edit. */
  test('an empty status answers NOT locked', () => {
    expect(procLockActive({ processing_date: past, status: '' })).toBe(false);
    expect(procLockActive({ processing_date: past, status: null })).toBe(false);
  });

  /* ...and the po_locked road is untouched by any of it: it short-circuits the
     date test entirely, including the DRAFT/CANCELLED exemptions. */
  test('po_locked still wins outright, with or without a date', () => {
    expect(procLockActive({ po_locked: true, status: 'DRAFT' })).toBe(true);
    expect(procLockActive({ po_locked: true, processing_date: null, status: 'CONFIRMED' })).toBe(true);
    expect(procLockActive({ po_locked: true, processing_date: future, status: 'CANCELLED' })).toBe(true);
  });
});

describe('the source carries no second storage', () => {
  /* Source-level, because the regression is a two-line "defensive" addition
     that every behavioural test above would still pass if it were written as
     `|| header.proceeded_at` on a header that also has a date. */
  const sources = import.meta.glob('./so-detail-gates.ts', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  test('the gate module was loaded', () => {
    expect(Object.keys(sources)).toHaveLength(1);
    expect(Object.values(sources)[0]!.length).toBeGreaterThan(1000);
  });

  test('no executable line in it names proceeded_at', () => {
    const code = Object.values(sources)[0]!
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).toContain('processing_date');
    expect(code).not.toContain('proceeded_at');
  });
});
