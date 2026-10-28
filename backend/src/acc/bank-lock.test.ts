// What this file pins: a month cannot be closed over work nobody has done, and
// cannot be closed over a known problem SILENTLY.
//
// The two failures that matter are opposites, and both produce a document
// somebody files:
//
//   • closing a month with movements still undecided freezes a figure nobody
//     agreed to — no note can make an unfinished month finished, so this is
//     refused outright rather than made noteable;
//   • closing a month that does not reconcile is a real thing businesses do,
//     and doing it without recording WHY leaves the next person with a closed
//     month and no account of the difference inside it.
//
// Also pinned: the refusal a closed month gives names the month, who closed it
// and when. "Locked" on its own tells an operator nothing about what to do.

import { describe, it, expect } from 'vitest';
import {
  mayLockMonth, lockedRefusal, lockMonthOf, monthAsDate, monthFromDate,
  type LockRequest, type MonthLock,
} from './bank-lock';

const req = (over: Partial<LockRequest> = {}): LockRequest => ({
  accountCode: '310-0020', month: '2026-09',
  openCount: 0, lineCount: 42, statementCount: 3,
  computedClosingSen: 1090000, closingStatementSen: 1090000, unexplainedSen: 0, tallies: true,
  consistent: true, complete: true,
  ...over,
});

/* Owner, 2026-09-11: 当 closing bank statement amount 无法 tally 就无法 lock —
   and, asked whether a bank error should ever be closed over with a reason:
   应该不会有银行错吧，毕竟怎样都要 tally bank statement. So a month closes when
   it tallies and is whole, and otherwise cannot close at all; there is no
   reason that buys a way past (docs/bugs/0806). */
describe('a month that tallies and is whole', () => {
  it('closes with no ceremony', () => {
    expect(mayLockMonth(req())).toEqual({ ok: true });
  });

  /* An unpresented payment is an outstanding item, not a difference: the
     books allowing for it reach the bank's closing, and that is what tallies. */
  it('closes with outstanding items in the books, as long as it tallies', () => {
    expect(mayLockMonth(req({ computedClosingSen: 93837, closingStatementSen: 93837 }))).toEqual({ ok: true });
  });
});

describe('a month with work still in it', () => {
  it('is refused', () => {
    const v = mayLockMonth(req({ openCount: 3 }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('still_open');
    expect(!v.ok && v.message).toContain('3 movement(s)');
  });
});

/* A month with no STATEMENT cannot be closed — closing it would claim
   something no file supports. A month with a statement and no MOVEMENT is the
   ordinary quiet month (docs/bugs/0794). */
describe('a month with nothing in it', () => {
  it('cannot be closed when no statement was filed for it', () => {
    const v = mayLockMonth(req({ lineCount: 0, statementCount: 0 }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('empty_month');
    expect(!v.ok && v.message).toContain('no statement');
  });

  it('closes when a statement covers it and it tallies', () => {
    expect(mayLockMonth(req({ lineCount: 0, statementCount: 1 }))).toEqual({ ok: true });
  });
});

describe('a month that does not tally', () => {
  it('cannot be closed, and the refusal names both figures and the gap', () => {
    const v = mayLockMonth(req({ computedClosingSen: 3601503, closingStatementSen: 93837, unexplainedSen: -3507666, tallies: false }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('not_tallied');
    expect(!v.ok && v.message).toContain('RM 36,015.03');
    expect(!v.ok && v.message).toContain('RM 938.37');
    expect(!v.ok && v.message).toContain('RM 35,076.66');
  });

  it('cannot be closed when no file printed a closing balance', () => {
    const v = mayLockMonth(req({ closingStatementSen: null, unexplainedSen: null, tallies: false }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('no_closing');
  });

  it('cannot be closed when it is not covered end to end', () => {
    const v = mayLockMonth(req({ complete: false }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('not_covered');
  });

  it('cannot be closed when the figures do not account for themselves', () => {
    const v = mayLockMonth(req({ consistent: false, tallies: false }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('inconsistent');
  });

  /* No sentence buys a way past a month that does not tally. */
  it('has no reason escape', () => {
    const v = mayLockMonth({ ...req({ tallies: false, unexplainedSen: 100 }), note: 'known difference' } as LockRequest);
    expect(v.ok).toBe(false);
  });
});

describe('what a closed month says when something tries to change it', () => {
  const lock: MonthLock = {
    accountCode: '310-0020', month: '2026-09',
    lockedBy: 'Chew', lockedAt: '2026-10-02T03:14:00Z', lockNote: null,
    closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0,
    statementCount: 12, wasComplete: true,
  };

  it('names the month, who closed it, when, and what to do next', () => {
    const r = lockedRefusal(lock, 'booking this credit');
    expect(r.error).toBe('month_locked');
    expect(r.message).toContain('310-0020 2026-09');
    expect(r.message).toContain('Chew');
    expect(r.message).toContain('2026-10-02');
    expect(r.message).toContain('booking this credit');
    expect(r.message).toContain('Reopen the month');
  });

  it('still says something useful when nobody was recorded', () => {
    const r = lockedRefusal({ ...lock, lockedBy: null }, 'undoing this movement');
    expect(r.message).toContain('somebody');
    expect(r.message).toContain('undoing this movement');
  });
});

describe('the month a date belongs to', () => {
  it('round-trips through the shape the table stores', () => {
    expect(lockMonthOf('2026-09-30')).toBe('2026-09');
    expect(monthAsDate('2026-09')).toBe('2026-09-01');
    expect(monthFromDate('2026-09-01')).toBe('2026-09');
    /* Postgres hands a DATE back with a time on some drivers; the reader must
       not care. */
    expect(monthFromDate('2026-09-01T00:00:00+00:00')).toBe('2026-09');
  });
});
