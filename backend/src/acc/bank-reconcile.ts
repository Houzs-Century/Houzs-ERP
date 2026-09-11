// ----------------------------------------------------------------------------
// acc/bank-reconcile — the reconciliation statement itself.
//
// Layer 4, phase 4. Everything else in this module reads a file and decides
// what its lines are; this is the part that answers the only question a
// reconciliation exists to answer: DOES THE BANK AGREE WITH THE BOOKS, and if
// not, exactly what is the difference made of.
//
// The whole thing rests on one identity, and it is stated here rather than
// implied because a reconciliation that cannot be falsified is decoration:
//
//     closing(statement) − closing(ledger)
//       =  (what the bank has and the books do not)
//        − (what the books have and the bank does not)
//        +  (the difference brought forward)
//
// Every term is computed independently — one from the file, one from the
// ledger, two from what is still unmatched — and then the identity is CHECKED.
// If it does not hold, the data is wrong somewhere and `consistent` is false,
// which the screen must say out loud. A reconciliation that quietly reports a
// difference it cannot account for is worse than no reconciliation: it looks
// like work has been done.
//
// No caches, no stored balances (§2.3). The ledger side is recomputed from
// posted entries every time this is asked for, which is why the answer cannot
// drift from the general ledger the way a "last reconciled balance" column
// would.
// ----------------------------------------------------------------------------

/** One posted ledger movement on the bank account, as scm.v_gl_entries gives
    it. Debit is money INTO a bank account, credit is money out. */
export type LedgerMovement = {
  jeNo: string;
  entryDate: string;
  sourceType: string | null;
  sourceDocNo: string | null;
  debitSen: number;
  creditSen: number;
  notes?: string | null;
  /** Who was paid or who paid — the payee off a voucher, the payer off a
      receipt (owner 2026-09-11: 我要看到 payment detail, 例如 pay to who). */
  partyName?: string | null;
};

/** One movement off the statement, as far as reconciliation cares. */
export type StatementMovement = {
  id: number;
  bookedOn: string;
  description: string;
  reference: string | null;
  amountSen: number;
  /** OPEN = nobody has decided; POSTED = its entry exists; IGNORED = declared
      none of our business, and therefore NOT part of the difference. */
  state: 'OPEN' | 'POSTED' | 'IGNORED';
  /** The je_no it claims, when it claims one. */
  jeNo?: string | null;
};

export type ReconcileInput = {
  periodFrom: string;
  periodTo: string;
  /** What the FILE says. Null when the statement does not print balances —
      plenty of daily transaction reports do not, and the reconciliation still
      works on movements alone. */
  statementOpeningSen: number | null;
  statementClosingSen: number | null;
  movements: StatementMovement[];
  /** Every posted movement on this account UP TO periodTo — the opening is
      derived from the ones before periodFrom, so one read serves both ends. */
  ledger: LedgerMovement[];
  /** je_nos claimed by movements on OTHER statements of this account, and
      everything older than the first statement ever filed for it. An earlier
      entry is CARRIED only when nobody has ever claimed it — an April cheque
      matched on April's statement is not waiting on May's. */
  claimedElsewhere?: ReadonlySet<string>;
};

export type UnexplainedSide = {
  count: number;
  sen: number;
};

export type Reconciliation = {
  periodFrom: string;
  periodTo: string;

  /** Balance at the START of the period. */
  openingStatementSen: number | null;
  openingLedgerSen: number;
  /** Statement minus ledger at the start. Anything other than zero is a
      difference that predates this statement, and it is shown separately
      because a period's own work cannot fix it. */
  broughtForwardSen: number | null;

  movementsStatementSen: number;
  movementsLedgerSen: number;

  closingStatementSen: number | null;
  closingLedgerSen: number;
  /** Statement minus ledger at the end. Zero is reconciled. */
  differenceSen: number | null;

  /** On the bank, not in the books: movements still OPEN. */
  bankNotInBooks: UnexplainedSide;
  /** In the books, not on the bank: posted entries in the period that no
      movement claims. */
  booksNotOnBank: UnexplainedSide;
  /** The je_nos of those entries, so the screen can list them rather than
      report a number nobody can chase. */
  unmatchedJeNos: string[];

  /** CARRIED FROM EARLIER PERIODS (owner 2026-09-11: 之前 in book 还没有 recon
      的也要带下来，因为可能下个月才过钱): entries posted BEFORE this period that
      no statement has ever claimed — an April cheque the bank shows in May is
      still waiting on May's list. They are what the difference brought forward
      is made of, so they are counted and named separately from this period's. */
  carried: UnexplainedSide;
  carriedJeNos: string[];
  /** Entries from before the period that a movement ON THIS STATEMENT claims
      — the cheque that cleared this month. Part of the identity: the bank
      moved by it this period, the books did not. */
  clearedFromBeforeSen: number;
  /** Is the difference brought forward exactly the earlier entries — those
      still carried plus those cleared here? Null when no file printed an
      opening balance. True means the opening gap is fully accounted for. */
  broughtForwardExplained: boolean | null;

  /** Did the identity hold? False means the inputs disagree with themselves
      and the difference above cannot be trusted. */
  consistent: boolean;
  /** Set only when consistent is false: the two sides that did not agree. */
  inconsistency: string | null;

  /** Nothing open, nothing unmatched, and the two closings equal. */
  reconciled: boolean;
};

const sum = <T>(xs: T[], pick: (x: T) => number) => xs.reduce((s, x) => s + pick(x), 0);

/** Money into the account minus money out — the same sign convention the
    statement uses, so the two sides can be compared without a translation
    step that could itself be wrong. */
const net = (m: LedgerMovement) => m.debitSen - m.creditSen;

export function reconcileBankStatement(input: ReconcileInput): Reconciliation {
  const { periodFrom, periodTo, movements, ledger } = input;

  /* The ledger is given up to periodTo; everything dated before the period
     starts is the opening, the rest is the period's movement. */
  const before = ledger.filter((l) => l.entryDate < periodFrom);
  const during = ledger.filter((l) => l.entryDate >= periodFrom && l.entryDate <= periodTo);

  const openingLedgerSen = sum(before, net);
  const movementsLedgerSen = sum(during, net);
  const closingLedgerSen = openingLedgerSen + movementsLedgerSen;

  /* An IGNORED movement is one a person has declared none of our business —
     a transfer between our own accounts already booked from the other side,
     say. It is not part of the difference, and it is not part of what the
     statement claims to have moved either, or the identity would not close. */
  const live = movements.filter((m) => m.state !== 'IGNORED');
  const movementsStatementSen = sum(live, (m) => m.amountSen);

  const openingStatementSen = input.statementOpeningSen;
  /* Prefer what the file says it closed at. Where it prints no balances, the
     opening plus the movements is the same number by definition — and where it
     prints neither, there is no statement side and the difference is null
     rather than a zero that would read as "reconciled". */
  const closingStatementSen = input.statementClosingSen
    ?? (openingStatementSen == null ? null : openingStatementSen + movementsStatementSen);

  const broughtForwardSen = openingStatementSen == null ? null : openingStatementSen - openingLedgerSen;
  const differenceSen = closingStatementSen == null ? null : closingStatementSen - closingLedgerSen;

  const open = movements.filter((m) => m.state === 'OPEN');
  const bankNotInBooks: UnexplainedSide = { count: open.length, sen: sum(open, (m) => m.amountSen) };

  /* An entry is accounted for when a movement of this statement claims its
     number. Everything else posted in the period is in the books and not on
     the bank — an uncleared cheque, a deposit that has not landed, or simply
     an entry belonging to a statement not uploaded yet. */
  const claimed = new Set(movements.map((m) => m.jeNo).filter((n): n is string => !!n));
  const unmatched = during.filter((l) => !claimed.has(l.jeNo));
  const booksNotOnBank: UnexplainedSide = { count: unmatched.length, sen: sum(unmatched, net) };

  /* Entries from BEFORE the period: still waiting (carried), or claimed by a
     movement on this statement (cleared here). Both are the brought-forward's
     substance; only the second is part of this period's arithmetic. */
  const elsewhere = input.claimedElsewhere ?? new Set<string>();
  const carriedEntries = before.filter((l) => !claimed.has(l.jeNo) && !elsewhere.has(l.jeNo));
  const carried: UnexplainedSide = { count: carriedEntries.length, sen: sum(carriedEntries, net) };
  const clearedFromBeforeSen = sum(before.filter((l) => claimed.has(l.jeNo)), net);
  const broughtForwardExplained = broughtForwardSen == null
    ? null
    : broughtForwardSen + clearedFromBeforeSen + carried.sen === 0;

  /* THE CHECK. Four numbers arrived at four different ways; if they do not
     satisfy the identity, say so instead of publishing the difference. The
     bank moves by an earlier entry the period it clears; the books moved when
     it was posted — so what cleared from before the period is a term of its
     own, not part of either unmatched side. */
  let consistent = true;
  let inconsistency: string | null = null;
  if (differenceSen != null && broughtForwardSen != null) {
    const expected = bankNotInBooks.sen - booksNotOnBank.sen + broughtForwardSen + clearedFromBeforeSen;
    if (expected !== differenceSen) {
      consistent = false;
      inconsistency =
        `The difference of ${differenceSen} sen does not equal what is unmatched on either side `
        + `(${bankNotInBooks.sen} on the bank, ${booksNotOnBank.sen} in the books, `
        + `${broughtForwardSen} brought forward${clearedFromBeforeSen !== 0 ? `, ${clearedFromBeforeSen} cleared from earlier months` : ''} = ${expected}). `
        + 'The statement balances and the lines under them disagree — check the file before trusting either.';
    }
  }

  return {
    periodFrom, periodTo,
    openingStatementSen, openingLedgerSen, broughtForwardSen,
    movementsStatementSen, movementsLedgerSen,
    closingStatementSen, closingLedgerSen, differenceSen,
    bankNotInBooks, booksNotOnBank,
    unmatchedJeNos: unmatched.map((l) => l.jeNo),
    carried, carriedJeNos: carriedEntries.map((l) => l.jeNo), clearedFromBeforeSen, broughtForwardExplained,
    consistent, inconsistency,
    /* Reconciled means all three: nothing waiting on either side, and the two
       closings equal. Two of the three is not reconciled, it is halfway. */
    reconciled: consistent
      && bankNotInBooks.count === 0
      && booksNotOnBank.count === 0
      && (differenceSen == null || differenceSen === 0),
  };
}
