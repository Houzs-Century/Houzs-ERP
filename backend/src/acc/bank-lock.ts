// ----------------------------------------------------------------------------
// acc/bank-lock — closing a reconciled month, and what a closed month refuses.
//
// Owner, 2026-09-08, third of the three things he asked for that day: 还有lock
// 起来不可以随便碰.
//
// He is right that it was missing and right that it matters. Until now every
// bank movement could be booked, ignored or UNDONE at any time, for ever. That
// is correct while a month is being worked and wrong the moment it has been
// reconciled and its statement printed: a reconciliation somebody filed is a
// CLAIM about a month, and a month that can still move behind the paper makes
// the paper a lie.
//
// Two rules, and they are the whole file.
//
// MAY THIS MONTH BE CLOSED?
//   • Not while movements are still undecided. A month with open lines is not a
//     reconciled month, it is an unfinished one, and closing it would freeze a
//     figure nobody has agreed to. Refused outright — a note cannot make an
//     unfinished month finished.
//   • A month that reconciles and is covered end to end closes with no
//     ceremony. That is the ordinary case and it should feel like one.
//   • A month with a real difference, or missing a day, closes only WITH A
//     REASON. Businesses do close months over known differences; what must not
//     happen is closing one silently. The sentence is the whole record of that
//     decision, so it is required, and it is kept on the lock for ever.
//
// WHAT A CLOSED MONTH REFUSES: every write that would change what it says —
// booking a credit, matching, ignoring, undoing, and uploading a file whose
// movements land inside it. The refusal names the month, who closed it and
// when, because "locked" on its own tells an operator nothing about what to do
// next.
//
// WHAT IT DOES NOT DO, stated so nobody reads it as a promise it does not make:
// this is not a general-ledger period close. It stops the bank reconciliation
// screens from changing a closed month. It does not stop a journal entry being
// posted into those dates from anywhere else in the system.
// ----------------------------------------------------------------------------

/** A lock as it is stored, as far as deciding anything cares. */
export type MonthLock = {
  accountCode: string;
  /** The month, as YYYY-MM. */
  month: string;
  lockedBy: string | null;
  lockedAt: string;
  lockNote: string | null;
  closingStatementSen: number | null;
  closingLedgerSen: number | null;
  differenceSen: number | null;
  statementCount: number;
  wasComplete: boolean;
};

/** What the month looks like at the moment somebody asks to close it. */
export type LockRequest = {
  accountCode: string;
  month: string;
  /** Movements still undecided. Anything above zero refuses. */
  openCount: number;
  /** Movements the month has at all. Zero is the ordinary quiet month, not a
      refusal (docs/bugs/0794) — what a close needs is a STATEMENT. */
  lineCount: number;
  /** Files filed for the month. Closing a month no file speaks for is closing
      nothing, and is refused so an empty month cannot be used to make a
      claim. */
  statementCount: number;
  /** Statement minus ledger. Null when no file printed a closing balance. */
  differenceSen: number | null;
  /** Did the server's own identity check hold? */
  consistent: boolean;
  /** Covered end to end by the files uploaded? */
  complete: boolean;
  /** The reason given, if any. */
  note: string | null;
};

export type LockVerdict =
  | { ok: true; needsNote: false }
  /** Allowed, and the note supplied is what makes it allowed. */
  | { ok: true; needsNote: true }
  | { ok: false; error: string; message: string };

/**
 * May this month be closed?
 *
 * Pure, and the only place the question is answered — the route asks this and
 * writes, so a rule cannot exist in two spellings.
 */
export function mayLockMonth(req: LockRequest): LockVerdict {
  const where = `${req.accountCode} ${req.month}`;

  if (req.statementCount === 0) {
    return {
      ok: false,
      error: 'empty_month',
      message: `${where} has no statement filed, so there is nothing to close.`
        + ' Upload the bank statement for this month first — one with no transactions in it still counts,'
        + ' filed under the month it is for.',
    };
  }

  if (req.openCount > 0) {
    return {
      ok: false,
      error: 'still_open',
      message: `${req.openCount} movement(s) in ${where} are still undecided.`
        + ' Finish reconciling the month before closing it — closing now would freeze a figure'
        + ' nobody has agreed to.',
    };
  }

  /* The three things that make a month less than clean. Each is a real reason a
     business still closes; none of them is a reason to close SILENTLY. */
  const doubts: string[] = [];
  if (!req.consistent) doubts.push('its figures do not account for themselves');
  if (!req.complete) doubts.push('it is not covered end to end by the files uploaded');
  if (req.differenceSen == null) doubts.push('no file printed a closing balance to compare against');
  else if (req.differenceSen !== 0) doubts.push('the bank and the books still differ');

  if (doubts.length === 0) return { ok: true, needsNote: false };

  if (!req.note || req.note.trim().length === 0) {
    return {
      ok: false,
      error: 'reason_required',
      message: `${where} can be closed, but ${doubts.join(', and ')}.`
        + ' Give the reason for closing it anyway — that sentence is the only record of this'
        + ' decision anyone will have later.',
    };
  }

  return { ok: true, needsNote: true };
}

/**
 * The refusal a guarded write returns. One sentence, naming the month, who
 * closed it and when — "locked" on its own tells an operator nothing about what
 * to do next.
 */
export function lockedRefusal(lock: MonthLock, what: string): { error: string; message: string } {
  const who = lock.lockedBy ?? 'somebody';
  const when = lock.lockedAt.slice(0, 10);
  return {
    error: 'month_locked',
    message: `${lock.accountCode} ${lock.month} was closed by ${who} on ${when}, so ${what} would change`
      + ' a month that has already been reconciled and reported.'
      + ' Reopen the month first if it genuinely has to change.',
  };
}

/** The month a date falls in, as the lock table keys it. */
export const lockMonthOf = (iso: string): string => iso.slice(0, 7);

/** A YYYY-MM as the DATE the table stores (its first day). */
export const monthAsDate = (month: string): string => `${month}-01`;

/** And back again, from whatever shape the column returns. */
export const monthFromDate = (value: string): string => value.slice(0, 7);
