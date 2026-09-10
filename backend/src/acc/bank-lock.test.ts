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
  differenceSen: 0, consistent: true, complete: true, note: null,
  ...over,
});

describe('a month that reconciles and is whole', () => {
  it('closes with no ceremony', () => {
    const v = mayLockMonth(req());
    expect(v.ok).toBe(true);
    expect(v.ok && v.needsNote).toBe(false);
  });
});

describe('a month with work still in it', () => {
  /* THE ONE THAT MATTERS. An unfinished month is not a month with a problem,
     it is a month nobody has finished — so a reason must NOT buy a way past it. */
  it('is refused, and a reason does not change that', () => {
    const bare = mayLockMonth(req({ openCount: 3 }));
    expect(bare.ok).toBe(false);
    expect(!bare.ok && bare.error).toBe('still_open');
    expect(!bare.ok && bare.message).toContain('3 movement(s)');

    const excused = mayLockMonth(req({ openCount: 3, note: 'closing anyway, month end' }));
    expect(excused.ok).toBe(false);
    expect(!excused.ok && excused.error).toBe('still_open');
  });
});

/* A month with no STATEMENT cannot be closed — closing it would claim
   something no file supports. A month with a statement and no MOVEMENT is the
   ordinary quiet month (docs/bugs/0794): the bank printed a balance, the books
   hold the same, and it closes like any other. */
describe('a month with nothing in it', () => {
  it('cannot be closed when no statement was filed for it, because closing it would claim nothing', () => {
    const v = mayLockMonth(req({ lineCount: 0, statementCount: 0 }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('empty_month');
  });

  /* Checked BEFORE the open count, so an empty month is named for what it is
     rather than reported as "0 movements still undecided". */
  it('is named as having no statement even though it also has nothing open', () => {
    const v = mayLockMonth(req({ lineCount: 0, statementCount: 0, openCount: 0 }));
    expect(!v.ok && v.message).toContain('no statement');
  });

  it('closes with no ceremony when a statement covers it and the bank and the books agree', () => {
    const v = mayLockMonth(req({ lineCount: 0, statementCount: 1 }));
    expect(v.ok).toBe(true);
    expect(v.ok && v.needsNote).toBe(false);
  });

  it('still wants a reason when the quiet month does not reconcile', () => {
    const v = mayLockMonth(req({ lineCount: 0, statementCount: 1, differenceSen: 300000 }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('reason_required');
  });
});

describe('a month that is finished but not clean', () => {
  const cases: Array<[string, Partial<LockRequest>, string]> = [
    ['the bank and the books still differ', { differenceSen: 45000 }, 'still differ'],
    ['a day was never uploaded', { complete: false }, 'not covered end to end'],
    ['no file printed a closing balance', { differenceSen: null }, 'no file printed a closing balance'],
    ['the figures do not account for themselves', { consistent: false }, 'do not account for themselves'],
  ];

  for (const [name, over, expected] of cases) {
    it(`refuses without a reason when ${name}`, () => {
      const v = mayLockMonth(req(over));
      expect(v.ok).toBe(false);
      expect(!v.ok && v.error).toBe('reason_required');
      expect(!v.ok && v.message).toContain(expected);
    });

    it(`closes with a reason when ${name}`, () => {
      const v = mayLockMonth(req({ ...over, note: 'known timing difference, agreed with the bank' }));
      expect(v.ok).toBe(true);
      expect(v.ok && v.needsNote).toBe(true);
    });
  }

  it('names every doubt at once rather than one at a time', () => {
    const v = mayLockMonth(req({ differenceSen: 45000, complete: false, consistent: false }));
    expect(!v.ok && v.message).toContain('do not account for themselves');
    expect(!v.ok && v.message).toContain('not covered end to end');
    expect(!v.ok && v.message).toContain('still differ');
  });

  /* Whitespace is not a reason. */
  it('does not accept a blank reason', () => {
    const v = mayLockMonth(req({ differenceSen: 45000, note: '   ' }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toBe('reason_required');
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
