
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
  /* The opening deposit was reconciled on an earlier statement — what the
     routes say through claimedSetFor. Without it, it would be an outstanding
     receipt of RM 50,000 (docs/bugs/0806). */
  claimedElsewhere: new Set(['JE-2607-9']),
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
    expect(r.reconciled).toBe(false);
  });
});

/* Owner, 2026-09-11: 之前 in book 还没有 recon 的也要带下来，因为可能下个月才
   过钱. A payment posted in April that the bank shows in May is, on April's
   reconciliation, "in the books, not on the bank" — and on May's it is STILL
   in the books and not yet claimed, so it must be carried into May's list
   rather than vanish into the opening balance. It is exactly what the
   difference brought forward is made of, and the reconciliation says so. */
describe('entries carried from earlier periods', () => {
  const input2 = (over: Partial<ReconcileInput> = {}) => input({ claimedElsewhere: new Set(['JE-2607-9']), ...over });
  const carriedLedger = () => [
    led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }),
    led({ jeNo: 'JE-2607-0031', entryDate: '2026-07-28', debitSen: 0, creditSen: 45000, partyName: 'TENAGA NASIONAL BERHAD' }),
    led(),
  ];

  it('lists them separately from this period\'s, and counts them', () => {
    const r = reconcileBankStatement(input2({
      statementOpeningSen: 5000000, statementClosingSen: 5100000,
      ledger: carriedLedger(),
    }));
    expect(r.carried).toEqual({ count: 1, sen: -45000 });
    expect(r.carriedJeNos).toEqual(['JE-2607-0031']);
    expect(r.booksNotOnBank).toEqual({ count: 0, sen: 0 });
    expect(r.unmatchedJeNos).toEqual([]);
    expect(r.consistent).toBe(true);
  });

  it('says when the difference brought forward is exactly those entries', () => {
    const r = reconcileBankStatement(input2({
      statementOpeningSen: 5000000, statementClosingSen: 5100000,
      ledger: carriedLedger(),
    }));
    expect(r.broughtForwardSen).toBe(45000);
    expect(r.broughtForwardExplained).toBe(true);
  });

  it('and when it is not', () => {
    const r = reconcileBankStatement(input2({
      statementOpeningSen: 4985000, statementClosingSen: 5085000,
      ledger: carriedLedger(),
    }));
    expect(r.broughtForwardSen).toBe(30000);
    expect(r.broughtForwardExplained).toBe(false);
  });

  it('is null when no file printed an opening balance', () => {
    const r = reconcileBankStatement(input2({ statementOpeningSen: null, statementClosingSen: null, ledger: carriedLedger() }));
    expect(r.broughtForwardExplained).toBeNull();
    expect(r.carried.count).toBe(1);
  });

  it('does not carry an entry a movement on this statement claims', () => {
    const r = reconcileBankStatement(input2({
      statementOpeningSen: 5000000, statementClosingSen: 5055000,
      movements: [mov(), mov({ id: 2, bookedOn: '2026-08-06', amountSen: -45000, state: 'POSTED', jeNo: 'JE-2607-0031' })],
      ledger: carriedLedger(),
    }));
    expect(r.carried).toEqual({ count: 0, sen: 0 });
    expect(r.clearedFromBeforeSen).toBe(-45000);
    expect(r.differenceSen).toBe(0);
    expect(r.consistent).toBe(true);
    expect(r.broughtForwardExplained).toBe(true);
  });

  it('does not carry an entry another statement already claimed', () => {
    const r = reconcileBankStatement(input({
      statementOpeningSen: 4955000, statementClosingSen: 5055000,
      ledger: carriedLedger(),
      claimedElsewhere: new Set(['JE-2607-9', 'JE-2607-0031']),
    }));
    expect(r.carried).toEqual({ count: 0, sen: 0 });
    expect(r.broughtForwardSen).toBe(0);
    expect(r.broughtForwardExplained).toBe(true);
  });
});

/* Owner, 2026-09-11: one transfer paid two vouchers; two transfers paid one
   receipt (OR-2604-001 = RM 29,000 + RM 10,000). A movement claims EVERY entry
   it was matched to, and every one of them leaves the "books, not on bank"
   list (docs/bugs/0803). */
describe('a movement matched to several entries', () => {
  it('claims all of them, and the identity holds', () => {
    const r = reconcileBankStatement(input({
      statementClosingSen: 5100000,
      movements: [mov({ jeNo: 'JE-2608-0001', jeNos: ['JE-2608-0001', 'JE-2608-0002'] })],
      ledger: [
        led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }),
        led({ debitSen: 60000 }),
        led({ jeNo: 'JE-2608-0002', debitSen: 40000 }),
      ],
      claimedElsewhere: new Set(['JE-2607-9']),
    }));
    expect(r.booksNotOnBank).toEqual({ count: 0, sen: 0 });
    expect(r.unmatchedJeNos).toEqual([]);
    expect(r.differenceSen).toBe(0);
    expect(r.consistent).toBe(true);
    expect(r.reconciled).toBe(true);
  });
});

/* ── The owner's form (2026-09-11) ─────────────────────────────────────────
   我觉得设计应该是这样: Closing — the books (−)/+ unreconciled items = Closing
   bank statement. 每当我一 match, closing 就一直变; 当 closing bank statement
   amount 无法 tally 就无法 lock. So the reconciliation says what the books come
   to once the outstanding items are allowed for, whether that TALLIES with the
   bank's printed closing, and — the April case — a month whose only difference
   is an unpresented payment is reconciled, not "differing" (docs/bugs/0806). */
describe('the statement form — books, outstanding items, bank', () => {
  const april = (over: Partial<ReconcileInput> = {}) => input({
    periodFrom: '2026-04-30', periodTo: '2026-04-30',
    statementOpeningSen: 300000, statementClosingSen: 4183900,
    movements: [
      mov({ id: 1, bookedOn: '2026-04-30', amountSen: -16100, jeNo: 'PV5' }),
      mov({ id: 2, bookedOn: '2026-04-30', amountSen: 3900000, jeNo: 'OR1' }),
    ],
    ledger: [
      led({ jeNo: 'OPEN', entryDate: '2026-02-07', debitSen: 300000 }),
      led({ jeNo: 'PV5', entryDate: '2026-04-28', debitSen: 0, creditSen: 16100, partyName: 'TENAGA NASIONAL BERHAD' }),
      led({ jeNo: 'OR1', entryDate: '2026-04-30', debitSen: 3900000 }),
      led({ jeNo: 'PV7', entryDate: '2026-04-30', debitSen: 0, creditSen: 310168, partyName: 'HOUZS VENTURE HOLDING SDN BHD' }),
    ],
    claimedElsewhere: new Set(['OPEN']),
    ...over,
  });

  it('allows for the unpresented payment and arrives at the bank\'s closing — tallies, reconciled', () => {
    const r = reconcileBankStatement(april());
    expect(r.closingLedgerSen).toBe(3873732);
    expect(r.outstandingPayments).toEqual({ count: 1, sen: -310168 });
    expect(r.outstandingReceipts).toEqual({ count: 0, sen: 0 });
    expect(r.computedClosingSen).toBe(4183900);
    expect(r.closingStatementSen).toBe(4183900);
    expect(r.unexplainedSen).toBe(0);
    expect(r.tallies).toBe(true);
    expect(r.reconciled).toBe(true);
    expect(r.consistent).toBe(true);
  });

  it('an entry the bank has not credited yet is a receipt line, and the arithmetic still tallies', () => {
    const r = reconcileBankStatement(april({
      ledger: [
        led({ jeNo: 'OPEN', entryDate: '2026-02-07', debitSen: 300000 }),
        led({ jeNo: 'PV5', entryDate: '2026-04-28', debitSen: 0, creditSen: 16100 }),
        led({ jeNo: 'OR1', entryDate: '2026-04-30', debitSen: 3900000 }),
        led({ jeNo: 'PV7', entryDate: '2026-04-30', debitSen: 0, creditSen: 310168 }),
        led({ jeNo: 'OR2', entryDate: '2026-04-30', debitSen: 50000 }),
      ],
    }));
    expect(r.outstandingReceipts).toEqual({ count: 1, sen: 50000 });
    expect(r.computedClosingSen).toBe(4183900);
    expect(r.tallies).toBe(true);
  });

  it('counts an earlier period\'s unclaimed entry among the outstanding items', () => {
    const r = reconcileBankStatement(april({
      ledger: [
        led({ jeNo: 'OPEN', entryDate: '2026-02-07', debitSen: 300000 }),
        led({ jeNo: 'PVMAR', entryDate: '2026-03-20', debitSen: 0, creditSen: 4500 }),
        led({ jeNo: 'PV5', entryDate: '2026-04-28', debitSen: 0, creditSen: 16100 }),
        led({ jeNo: 'OR1', entryDate: '2026-04-30', debitSen: 3900000 }),
        led({ jeNo: 'PV7', entryDate: '2026-04-30', debitSen: 0, creditSen: 310168 }),
      ],
    }));
    expect(r.outstandingPayments).toEqual({ count: 2, sen: -314668 });
    expect(r.outstandingJeNos.sort()).toEqual(['PV7', 'PVMAR']);
    expect(r.computedClosingSen).toBe(4183900);
    expect(r.tallies).toBe(true);
  });

  it('a movement still to decide keeps the arithmetic tallying but the month is not reconciled', () => {
    const r = reconcileBankStatement(april({
      statementClosingSen: 4183900 + 5000,
      movements: [
        mov({ id: 1, bookedOn: '2026-04-30', amountSen: -16100, jeNo: 'PV5' }),
        mov({ id: 2, bookedOn: '2026-04-30', amountSen: 3900000, jeNo: 'OR1' }),
        mov({ id: 3, bookedOn: '2026-04-30', amountSen: 5000, state: 'OPEN', jeNo: null }),
      ],
    }));
    expect(r.bankNotInBooks).toEqual({ count: 1, sen: 5000 });
    expect(r.computedClosingSen).toBe(4188900);
    expect(r.tallies).toBe(true);
    expect(r.reconciled).toBe(false);
  });

  it('does not tally when the bank\'s closing is not what the books and the outstanding items reach', () => {
    const r = reconcileBankStatement(april({ statementClosingSen: 4183900 + 777 }));
    expect(r.unexplainedSen).toBe(777);
    expect(r.tallies).toBe(false);
    expect(r.reconciled).toBe(false);
  });

  it('cannot tally when no file printed a closing balance', () => {
    const r = reconcileBankStatement(april({ statementOpeningSen: null, statementClosingSen: null }));
    expect(r.unexplainedSen).toBeNull();
    expect(r.tallies).toBe(false);
  });
});

describe('numbers that do not add up', () => {
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
  it('reports no difference rather than a difference of zero', () => {
    const r = reconcileBankStatement(input({ statementOpeningSen: null, statementClosingSen: null }));
    expect(r.closingStatementSen).toBeNull();
    expect(r.differenceSen).toBeNull();
    expect(r.broughtForwardSen).toBeNull();
    expect(r.consistent).toBe(true);
    /* Nothing outstanding on either side — but with no bank figure there is
       nothing to tally against, and a month cannot be called reconciled on
       what it cannot check (docs/bugs/0806). */
    expect(r.unexplainedSen).toBeNull();
    expect(r.tallies).toBe(false);
    expect(r.reconciled).toBe(false);
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
  it('puts an earlier entry in the opening and not in the difference', () => {
    const r = reconcileBankStatement(input({
      ledger: [led({ entryDate: '2026-07-20', jeNo: 'JE-2607-9', debitSen: 5000000 }), led()],
    }));
    expect(r.openingLedgerSen).toBe(5000000);
    expect(r.movementsLedgerSen).toBe(100000);
    expect(r.booksNotOnBank.count).toBe(0);
  });
});
