// What this file pins: assembling a month out of daily files cannot invent a
// balance it does not have.
//
// The two ways this could produce a clean-looking wrong answer, and the two
// rules that stop it:
//
//   • taking a balance off a file that straddles the month edge — the opening
//     printed on a 28 Aug - 3 Sep file is August's, and using it as September's
//     is wrong by four days of movement while looking authoritative;
//
//   • not noticing a missing day — if he uploads the 1st to the 4th and then
//     the 8th, the month is short four days of movement, and a reconciliation
//     that reports the resulting difference as "unexplained" has told him
//     nothing he can act on.
//
// Also pinned: a longer export overlapping a shorter one is NOT a break (it is
// how he works), and the reconciliation window follows the days actually
// uploaded rather than the calendar.

import { describe, it, expect } from 'vitest';
import { assembleMonth, monthWindow, monthOf, type MonthStatement } from './bank-month';
import type { StatementMovement } from './bank-reconcile';

const stmt = (over: Partial<MonthStatement> = {}): MonthStatement => ({
  id: 1,
  fileName: 'Transaction_Statement_1.csv',
  periodFrom: '2026-09-01',
  periodTo: '2026-09-01',
  openingBalanceSen: 1000000,
  closingBalanceSen: 1050000,
  ...over,
});

const mov = (over: Partial<StatementMovement> = {}): StatementMovement => ({
  id: 1,
  bookedOn: '2026-09-01',
  description: 'FUND TRANSFER',
  reference: null,
  amountSen: 50000,
  state: 'OPEN',
  ...over,
});

describe('the month window', () => {
  it('ends on the real last day of the month', () => {
    expect(monthWindow('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthWindow('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    /* A leap February is the case a hand-written table gets wrong. */
    expect(monthWindow('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthWindow('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('refuses anything that is not a month', () => {
    expect(monthWindow('2026-13')).toBeNull();
    expect(monthWindow('2026-00')).toBeNull();
    expect(monthWindow('2026-9')).toBeNull();
    expect(monthWindow('September')).toBeNull();
  });

  it('reads the month off a date', () => {
    expect(monthOf('2026-09-30')).toBe('2026-09');
  });
});

describe('a month covered end to end by daily files', () => {
  const files = [
    stmt({ id: 1, fileName: 'd01.csv', periodFrom: '2026-09-01', periodTo: '2026-09-01', openingBalanceSen: 1000000, closingBalanceSen: 1050000 }),
    stmt({ id: 2, fileName: 'd02.csv', periodFrom: '2026-09-02', periodTo: '2026-09-02', openingBalanceSen: 1050000, closingBalanceSen: 1020000 }),
    stmt({ id: 3, fileName: 'd03.csv', periodFrom: '2026-09-03', periodTo: '2026-09-03', openingBalanceSen: 1020000, closingBalanceSen: 1090000 }),
  ];
  const moves = [
    mov({ id: 1, bookedOn: '2026-09-01', amountSen: 50000 }),
    mov({ id: 2, bookedOn: '2026-09-02', amountSen: -30000 }),
    mov({ id: 3, bookedOn: '2026-09-03', amountSen: 70000 }),
  ];

  it('opens where the first file opened and closes where the last one closed', () => {
    const a = assembleMonth('2026-09', files, moves)!;
    expect(a.statementOpeningSen).toBe(1000000);
    expect(a.openingFrom).toEqual({ statementId: 1, fileName: 'd01.csv', on: '2026-09-01' });
    expect(a.statementClosingSen).toBe(1090000);
    expect(a.closingFrom).toEqual({ statementId: 3, fileName: 'd03.csv', on: '2026-09-03' });
  });

  it('says nothing is missing, and the figures carry the movements', () => {
    const a = assembleMonth('2026-09', files, moves)!;
    expect(a.breaks).toEqual([]);
    expect(a.gaps).toEqual([]);
    expect(a.complete).toBe(true);
    /* The identity the reconciliation will check: opening + movements = closing. */
    const sum = moves.reduce((s, m) => s + m.amountSen, 0);
    expect(a.statementOpeningSen! + sum).toBe(a.statementClosingSen);
  });

  it('runs over the days uploaded, not the whole calendar month', () => {
    const a = assembleMonth('2026-09', files, moves)!;
    expect(a.monthFrom).toBe('2026-09-01');
    expect(a.monthTo).toBe('2026-09-30');
    /* Nine-tenths of September has no file. Reconciling to the 30th would put
       three weeks of ledger against three days of bank. */
    expect(a.periodFrom).toBe('2026-09-01');
    expect(a.periodTo).toBe('2026-09-03');
  });

  it('finds its files whatever order they were uploaded in', () => {
    const shuffled = [files[2]!, files[0]!, files[1]!];
    const a = assembleMonth('2026-09', shuffled, moves)!;
    expect(a.statementOpeningSen).toBe(1000000);
    expect(a.statementClosingSen).toBe(1090000);
    expect(a.breaks).toEqual([]);
  });
});

describe('a day he has not uploaded', () => {
  /* The 5th to the 7th are missing, and RM 200.00 moved on them. */
  const files = [
    stmt({ id: 1, fileName: 'd04.csv', periodFrom: '2026-09-04', periodTo: '2026-09-04', openingBalanceSen: 1000000, closingBalanceSen: 1050000 }),
    stmt({ id: 2, fileName: 'd08.csv', periodFrom: '2026-09-08', periodTo: '2026-09-08', openingBalanceSen: 1070000, closingBalanceSen: 1090000 }),
  ];

  it('names both files, the days, and how much moved between them', () => {
    const a = assembleMonth('2026-09', files, [])!;
    expect(a.breaks).toHaveLength(1);
    expect(a.breaks[0]).toMatchObject({
      beforeFile: 'd04.csv', beforeTo: '2026-09-04', beforeClosingSen: 1050000,
      afterFile: 'd08.csv', afterFrom: '2026-09-08', afterOpeningSen: 1070000,
      gapSen: 20000,
    });
    expect(a.complete).toBe(false);
    expect(a.gaps.join(' ')).toContain('2026-09-04');
    expect(a.gaps.join(' ')).toContain('2026-09-08');
  });
});

describe('a longer export overlapping a shorter one', () => {
  /* How he actually works: a file a day, and the monthly statement on top of
     the same days. The repeats arrive IGNORED; the balances agree at the
     start, so this must not read as a missing day. */
  it('is not a break', () => {
    const a = assembleMonth('2026-09', [
      stmt({ id: 1, fileName: 'd01.csv', periodFrom: '2026-09-01', periodTo: '2026-09-01', openingBalanceSen: 1000000, closingBalanceSen: 1050000 }),
      stmt({ id: 2, fileName: 'acs_month.csv', periodFrom: '2026-09-01', periodTo: '2026-09-30', openingBalanceSen: 1000000, closingBalanceSen: 1400000 }),
    ], [])!;
    expect(a.breaks).toEqual([]);
    expect(a.complete).toBe(true);
    /* And the month closes where the LONGER file closes, because it closes last. */
    expect(a.statementClosingSen).toBe(1400000);
    expect(a.closingFrom!.fileName).toBe('acs_month.csv');
  });
});

describe('a file that straddles the month end', () => {
  const spanning = stmt({
    id: 9, fileName: 'aug28-sep03.csv',
    periodFrom: '2026-08-28', periodTo: '2026-09-03',
    openingBalanceSen: 777777, closingBalanceSen: 888888,
  });

  it('never speaks for the balances of September', () => {
    const a = assembleMonth('2026-09', [spanning], [mov({ bookedOn: '2026-09-02' })])!;
    expect(a.statementOpeningSen).toBeNull();
    expect(a.statementClosingSen).toBeNull();
    expect(a.spanningIds).toEqual([9]);
    expect(a.complete).toBe(false);
    expect(a.gaps.join(' ')).toContain('cross the edge');
  });

  it('but its movements inside September still count', () => {
    const a = assembleMonth('2026-09', [spanning], [
      mov({ id: 1, bookedOn: '2026-09-02' }),
      mov({ id: 2, bookedOn: '2026-09-03' }),
    ])!;
    /* The window follows the movements, not the file: 28-31 August is not
       September's business. */
    expect(a.periodFrom).toBe('2026-09-02');
    expect(a.periodTo).toBe('2026-09-03');
  });

  it('does not stop a file inside the month from speaking', () => {
    const a = assembleMonth('2026-09', [
      spanning,
      stmt({ id: 10, fileName: 'd05.csv', periodFrom: '2026-09-05', periodTo: '2026-09-05', openingBalanceSen: 888888, closingBalanceSen: 900000 }),
    ], [])!;
    expect(a.statementOpeningSen).toBe(888888);
    expect(a.openingFrom!.fileName).toBe('d05.csv');
    expect(a.spanningIds).toEqual([9]);
  });
});

describe('files that print no balances at all', () => {
  /* Plenty of daily transaction reports do not. The month then has movements
     and no balance to check them against — which is a missing figure, not a
     break, and must not be reported as one. */
  it('reports the missing figures and finds no break', () => {
    const a = assembleMonth('2026-09', [
      stmt({ id: 1, periodFrom: '2026-09-01', periodTo: '2026-09-01', openingBalanceSen: null, closingBalanceSen: null }),
      stmt({ id: 2, periodFrom: '2026-09-05', periodTo: '2026-09-05', openingBalanceSen: null, closingBalanceSen: null }),
    ], [mov()])!;
    expect(a.statementOpeningSen).toBeNull();
    expect(a.statementClosingSen).toBeNull();
    expect(a.breaks).toEqual([]);
    expect(a.complete).toBe(false);
    expect(a.gaps).toHaveLength(2);
  });
});

describe('a month with nothing in it', () => {
  /* docs/bugs/0794: an empty statement filed under the month speaks for both
     its balances — the file lies wholly inside the month by construction. */
  it('is complete when an empty statement filed under it prints its balance', () => {
    const a = assembleMonth('2026-03', [stmt({
      id: 7, fileName: 'acs_23600600000_31032026.csv',
      periodFrom: '2026-03-01', periodTo: '2026-03-31', openingBalanceSen: 300000, closingBalanceSen: 300000,
    })], [])!;
    expect(a.complete).toBe(true);
    expect(a.statementOpeningSen).toBe(300000);
    expect(a.statementClosingSen).toBe(300000);
    expect(a.periodFrom).toBe('2026-03-01');
    expect(a.periodTo).toBe('2026-03-31');
    expect(a.gaps).toEqual([]);
  });

  it('is the calendar month and says what it lacks', () => {
    const a = assembleMonth('2026-09', [], [])!;
    expect(a.periodFrom).toBe('2026-09-01');
    expect(a.periodTo).toBe('2026-09-30');
    expect(a.complete).toBe(false);
    expect(a.gaps.join(' ')).toContain('lies wholly inside it');
  });

  it('refuses a month that is not one', () => {
    expect(assembleMonth('2026-13', [], [])).toBeNull();
  });
});
