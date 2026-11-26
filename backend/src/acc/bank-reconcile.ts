
import { fmtSen } from '../scm/shared/format';

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
  state: 'OPEN' | 'POSTED' | 'IGNORED';
  jeNo?: string | null;
  /** EVERY entry it claims — one movement can be several vouchers
      (docs/bugs/0803). jeNo stays the first of them for readers that show one. */
  jeNos?: string[];
};

export type ReconcileInput = {
  periodFrom: string;
  periodTo: string;
  statementOpeningSen: number | null;
  statementClosingSen: number | null;
  movements: StatementMovement[];
  ledger: LedgerMovement[];
  claimedElsewhere?: ReadonlySet<string>;
};

export type UnexplainedSide = {
  count: number;
  sen: number;
};

export type Reconciliation = {
  periodFrom: string;
  periodTo: string;

  openingStatementSen: number | null;
  openingLedgerSen: number;
  broughtForwardSen: number | null;

  movementsStatementSen: number;
  movementsLedgerSen: number;

  closingStatementSen: number | null;
  closingLedgerSen: number;
  differenceSen: number | null;

  bankNotInBooks: UnexplainedSide;
  booksNotOnBank: UnexplainedSide;
  unmatchedJeNos: string[];

  /** CARRIED FROM EARLIER PERIODS (owner 2026-09-11: 之前 in book 还没有 recon
      的也要带下来，因为可能下个月才过钱): entries posted BEFORE this period that
      no statement has ever claimed — an April cheque the bank shows in May is
      still waiting on May's list. They are what the difference brought forward
      is made of, so they are counted and named separately from this period's. */
  carried: UnexplainedSide;
  carriedJeNos: string[];
  clearedFromBeforeSen: number;
  broughtForwardExplained: boolean | null;

  /** THE OWNER'S FORM (2026-09-11, docs/bugs/0806): 我觉得设计应该是这样 —
      Closing — the books (−)/+ unreconciled items = Closing bank statement.
      The outstanding items are every entry in the books no statement has
      shown yet, this period's and earlier ones' alike (全部就是 outstanding
      items), split into payments the bank has not paid and receipts it has
      not credited. */
  outstandingPayments: UnexplainedSide;
  outstandingReceipts: UnexplainedSide;
  outstandingJeNos: string[];
  computedClosingSen: number;
  unexplainedSen: number | null;
  /** Does the walk reach the bank's closing? The month cannot close without
      it (当 closing bank statement amount 无法 tally 就无法 lock). */
  tallies: boolean;

  consistent: boolean;
  inconsistency: string | null;

  reconciled: boolean;
};

const sum = <T>(xs: T[], pick: (x: T) => number) => xs.reduce((s, x) => s + pick(x), 0);

const net = (m: LedgerMovement) => m.debitSen - m.creditSen;

export function reconcileBankStatement(input: ReconcileInput): Reconciliation {
  const { periodFrom, periodTo, movements, ledger } = input;

  const before = ledger.filter((l) => l.entryDate < periodFrom);
  const during = ledger.filter((l) => l.entryDate >= periodFrom && l.entryDate <= periodTo);

  const openingLedgerSen = sum(before, net);
  const movementsLedgerSen = sum(during, net);
  const closingLedgerSen = openingLedgerSen + movementsLedgerSen;

  const live = movements.filter((m) => m.state !== 'IGNORED');
  const movementsStatementSen = sum(live, (m) => m.amountSen);

  const openingStatementSen = input.statementOpeningSen;
  const closingStatementSen = input.statementClosingSen
    ?? (openingStatementSen == null ? null : openingStatementSen + movementsStatementSen);

  const broughtForwardSen = openingStatementSen == null ? null : openingStatementSen - openingLedgerSen;
  const differenceSen = closingStatementSen == null ? null : closingStatementSen - closingLedgerSen;

  const open = movements.filter((m) => m.state === 'OPEN');
  const bankNotInBooks: UnexplainedSide = { count: open.length, sen: sum(open, (m) => m.amountSen) };

  const claimed = new Set<string>();
  for (const m of movements) {
    if (m.jeNo) claimed.add(m.jeNo);
    for (const n of m.jeNos ?? []) claimed.add(n);
  }
  const unmatched = during.filter((l) => !claimed.has(l.jeNo));
  const booksNotOnBank: UnexplainedSide = { count: unmatched.length, sen: sum(unmatched, net) };

  const elsewhere = input.claimedElsewhere ?? new Set<string>();
  const carriedEntries = before.filter((l) => !claimed.has(l.jeNo) && !elsewhere.has(l.jeNo));
  const carried: UnexplainedSide = { count: carriedEntries.length, sen: sum(carriedEntries, net) };
  const clearedFromBeforeSen = sum(before.filter((l) => claimed.has(l.jeNo)), net);
  const broughtForwardExplained = broughtForwardSen == null
    ? null
    : broughtForwardSen + clearedFromBeforeSen + carried.sen === 0;

  let consistent = true;
  let inconsistency: string | null = null;
  if (differenceSen != null && broughtForwardSen != null) {
    const expected = bankNotInBooks.sen - booksNotOnBank.sen + broughtForwardSen + clearedFromBeforeSen;
    if (expected !== differenceSen) {
      consistent = false;
      inconsistency =
        `The difference of ${fmtSen(differenceSen)} does not equal what is unmatched on either side `
        + `(${fmtSen(bankNotInBooks.sen)} on the bank, ${fmtSen(booksNotOnBank.sen)} in the books, `
        + `${fmtSen(broughtForwardSen)} brought forward${clearedFromBeforeSen !== 0 ? `, ${fmtSen(clearedFromBeforeSen)} cleared from earlier months` : ''} = ${fmtSen(expected)}). `
        + 'The statement balances and the lines under them disagree — check the file before trusting either.';
    }
  }

  const outstanding = [...unmatched, ...carriedEntries];
  const pays = outstanding.filter((l) => net(l) < 0);
  const rcts = outstanding.filter((l) => net(l) > 0);
  const outstandingPayments: UnexplainedSide = { count: pays.length, sen: sum(pays, net) };
  const outstandingReceipts: UnexplainedSide = { count: rcts.length, sen: sum(rcts, net) };
  const computedClosingSen = closingLedgerSen - (booksNotOnBank.sen + carried.sen) + bankNotInBooks.sen;
  const unexplainedSen = closingStatementSen == null ? null : closingStatementSen - computedClosingSen;
  const tallies = consistent && unexplainedSen === 0;

  return {
    periodFrom, periodTo,
    openingStatementSen, openingLedgerSen, broughtForwardSen,
    movementsStatementSen, movementsLedgerSen,
    closingStatementSen, closingLedgerSen, differenceSen,
    bankNotInBooks, booksNotOnBank,
    unmatchedJeNos: unmatched.map((l) => l.jeNo),
    carried, carriedJeNos: carriedEntries.map((l) => l.jeNo), clearedFromBeforeSen, broughtForwardExplained,
    outstandingPayments, outstandingReceipts, outstandingJeNos: outstanding.map((l) => l.jeNo),
    computedClosingSen, unexplainedSen, tallies,
    consistent, inconsistency,
    reconciled: tallies && bankNotInBooks.count === 0,
  };
}
