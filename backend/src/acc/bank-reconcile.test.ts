// What this file pins: the reconciliation is FALSIFIABLE. Its identity —
//
//     closing(statement) − closing(ledger)
//       = (bank has, books do not) − (books have, bank does not) + brought forward
//
// is checked, not assumed, and a set of numbers that fails it is reported as
// inconsistent rather than published as a difference. A reconciliation that
// quietly shows a gap it cannot account for is worse than none: it looks like
// work has been done.
//
// Also pinned: "reconciled" needs all three conditions, because two of the
// three is halfway, and an IGNORED line is out of the difference on BOTH sides
// or the identity would not close.

import { describe, it, expect } from 'vitest';
import {
  reconcileBankStatement,
  type LedgerMovement, type StatementMovement, type ReconcileInput,
} from './bank-reconcile';

const led = (over: Partial<LedgerMovement> = {}): LedgerMovement => ({
  jeNo: 'JE-2608-0001', entryDate: '2026-08-05',
  sourceType: 'SETTLEBANK', sourceDocNo: null,
  debitSen: 100000, creditSen: 0, ...over,
});

const mov = (over: Partial<StatementMovement> = {}): StatementMovement => ({
  id: 1, bookedOn: '2026-08-05', description: 'CR/CARD SALES', reference: 'R1',
  amountSen: 100000, state: 'POSTED', jeNo: 'JE-2608-0001', ...over,
});

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  periodFrom: '2026-08-01', periodTo: '2026-08-15',
  statementOpeningSen: 5000000, statementClosingSen: 5100000,
  movements: [mov()], ledger: [led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }), led()],
  ...over,
});

describe('a statement that agrees with the books', () => {
  it('reports zero, and says reconciled', () => {
    const r = reconcileBankStatement(input());
    expect(r.openingLedgerSen).toBe(5000000);
    expect(r.closingLedgerSen).toBe(5100000);
    expect(r.closingStatementSen).toBe(5100000);
    expect(r.differenceSen).toBe(0);
    expect(r.broughtForwardSen).toBe(0);
    expect(r.reconciled).toBe(true);
    expect(r.consistent).toBe(true);
  });
});

describe('a difference the reconciliation has to explain', () => {
  /* The ordinary case: a credit is on the statement and nobody has posted it
     yet. The bank is ahead of the books by exactly that credit. */
  it('accounts for a movement nobody has posted', () => {
    const r = reconcileBankStatement(input({
      statementClosingSen: 5150000,
      movements: [mov(), mov({ id: 2, amountSen: 50000, state: 'OPEN', jeNo: null })],
    }));
    expect(r.differenceSen).toBe(50000);
    expect(r.bankNotInBooks).toEqual({ count: 1, sen: 50000 });
    expect(r.booksNotOnBank).toEqual({ count: 0, sen: 0 });
    expect(r.consistent).toBe(true);
    expect(r.reconciled).toBe(false);
  });

  /* The other side: a cheque written and posted that has not cleared. The
     books are BEHIND the bank — the difference goes the other way. */
  it('accounts for an entry the bank has not seen', () => {
    const r = reconcileBankStatement(input({
      ledger: [
        led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }),
        led(),
        led({ jeNo: 'JE-2608-0002', entryDate: '2026-08-14', debitSen: 0, creditSen: 120000 }),
      ],
    }));
    expect(r.closingLedgerSen).toBe(5100000 - 120000);
    expect(r.differenceSen).toBe(120000);
    expect(r.booksNotOnBank).toEqual({ count: 1, sen: -120000 });
    expect(r.unmatchedJeNos).toEqual(['JE-2608-0002']);
    expect(r.consistent).toBe(true);
  });

  /* Both at once, in opposite directions — the case where a naive "difference
     = unposted credits" would give the wrong sign and the wrong number. */
  it('nets the two sides against each other', () => {
    const r = reconcileBankStatement(input({
      statementClosingSen: 5150000,
      movements: [mov(), mov({ id: 2, amountSen: 50000, state: 'OPEN', jeNo: null })],
      ledger: [
        led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }),
        led(),
        led({ jeNo: 'JE-2608-0002', entryDate: '2026-08-14', debitSen: 0, creditSen: 120000 }),
      ],
    }));
    expect(r.differenceSen).toBe(5150000 - (5100000 - 120000));
    expect(r.bankNotInBooks.sen).toBe(50000);
    expect(r.booksNotOnBank.sen).toBe(-120000);
    expect(r.consistent).toBe(true);
  });

  /* A gap that predates the statement cannot be closed by this period's work,
     so it is named on its own line rather than folded into the difference. */
  it('shows a difference brought forward separately', () => {
    const r = reconcileBankStatement(input({
      statementOpeningSen: 5030000,
      statementClosingSen: 5130000,
    }));
    expect(r.broughtForwardSen).toBe(30000);
    expect(r.differenceSen).toBe(30000);
    expect(r.bankNotInBooks.count).toBe(0);
    expect(r.booksNotOnBank.count).toBe(0);
    expect(r.consistent).toBe(true);
    /* Everything on this statement is dealt with and it STILL does not
       reconcile — which is the honest answer, not a green tick. */
    expect(r.reconciled).toBe(false);
  });
});

describe('numbers that do not add up', () => {
  /* The guard that makes the whole thing worth trusting: a closing balance
     that disagrees with the lines under it. Real cause — a statement whose
     first page was pasted in twice, or a file cut short. */
  it('refuses to publish a difference it cannot account for', () => {
    const r = reconcileBankStatement(input({ statementClosingSen: 5900000 }));
    expect(r.consistent).toBe(false);
    expect(r.inconsistency).toMatch(/does not equal what is unmatched/);
    expect(r.reconciled).toBe(false);
  });

  it('cannot be reconciled while inconsistent, even with nothing outstanding', () => {
    const r = reconcileBankStatement(input({ statementClosingSen: 5900000 }));
    expect(r.bankNotInBooks.count).toBe(0);
    expect(r.booksNotOnBank.count).toBe(0);
    expect(r.reconciled).toBe(false);
  });
});

describe('a line declared none of our business', () => {
  /* IGNORED has to leave BOTH sides — the difference and what the statement
     claims to have moved — or the identity stops closing and every ignore
     would raise a false inconsistency. */
  it('is out of the difference and out of the statement movement', () => {
    const r = reconcileBankStatement(input({
      movements: [mov(), mov({ id: 2, amountSen: 50000, state: 'IGNORED', jeNo: null })],
    }));
    expect(r.movementsStatementSen).toBe(100000);
    expect(r.bankNotInBooks.count).toBe(0);
    expect(r.differenceSen).toBe(0);
    expect(r.consistent).toBe(true);
    expect(r.reconciled).toBe(true);
  });
});

describe('a statement that prints no balances at all', () => {
  /* Plenty of daily transaction reports do not. The movements still reconcile;
     what must NOT happen is a null being shown as a zero difference, which
     would read as "reconciled" when nothing was compared. */
  it('reports no difference rather than a difference of zero', () => {
    const r = reconcileBankStatement(input({ statementOpeningSen: null, statementClosingSen: null }));
    expect(r.closingStatementSen).toBeNull();
    expect(r.differenceSen).toBeNull();
    expect(r.broughtForwardSen).toBeNull();
    expect(r.consistent).toBe(true);
    /* Nothing outstanding on either side, so as far as it can tell, done. */
    expect(r.reconciled).toBe(true);
  });

  it('derives a closing from an opening when only the opening is printed', () => {
    const r = reconcileBankStatement(input({ statementClosingSen: null }));
    expect(r.closingStatementSen).toBe(5100000);
    expect(r.differenceSen).toBe(0);
  });

  it('is not reconciled while a movement is still open', () => {
    const r = reconcileBankStatement(input({
      statementOpeningSen: null, statementClosingSen: null,
      movements: [mov({ state: 'OPEN', jeNo: null })],
    }));
    expect(r.reconciled).toBe(false);
    expect(r.bankNotInBooks.count).toBe(1);
  });
});

describe('the period boundary', () => {
  /* An entry dated before the statement starts is the OPENING, not a movement
     the statement failed to show. Getting this wrong makes every reconciliation
     of a second statement look broken. */
  it('puts an earlier entry in the opening and not in the difference', () => {
    const r = reconcileBankStatement(input({
      ledger: [led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }), led()],
    }));
    expect(r.openingLedgerSen).toBe(5000000);
    expect(r.movementsLedgerSen).toBe(100000);
    expect(r.booksNotOnBank.count).toBe(0);
  });
});
