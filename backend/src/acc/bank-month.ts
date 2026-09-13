// ----------------------------------------------------------------------------
// acc/bank-month — a CALENDAR MONTH of one bank account, assembled out of
// however many files were uploaded for it.
//
// The owner, 2026-09-08, on uploading a file a day: 每天我上传bank statement 和
// merchant report 测试，但是有办法选这个是几月的？因为我发现好像没有.
//
// He was right that there was nothing. Layer 4 reconciled ONE FILE at a time,
// which is the right unit for a monthly statement and the wrong one for the way
// he actually works: Hong Leong's any-day export gives him a file per day, so
// September was thirty separate reconciliations and no answer to the only
// question a month has — did the bank and the books agree in September.
//
// So a month is assembled here, and the rules it is assembled by are the whole
// content of this file:
//
//   1. A MOVEMENT belongs to the month its own date falls in — never to the
//      file it arrived in. A file downloaded on the 2nd carrying the 31st is
//      ordinary, and a file that straddles a month end contributes to both.
//      A date cannot lie about which month it is in; a filing label can.
//
//   2. A BALANCE belongs to the month only when its file lies wholly inside
//      that month. The opening printed on a file covering 28 Aug - 3 Sep is the
//      28th of August's opening, and using it as September's would produce a
//      brought-forward figure that is off by four days of movement while
//      looking exactly as authoritative as a right one.
//
//   3. The files are CHAINED and the chain is checked. Hong Leong's export
//      prints the prior day's balance, so each file's opening should be the
//      previous file's closing. Where it is not, a day is missing between them
//      — and the break is reported with the amount, because "your month does
//      not add up" is not something anybody can act on and "RM 1,240 moved
//      between 4 Sep and 8 Sep on days you have not uploaded" is.
//
//   4. A figure a file PRINTS always wins; where no file inside the month
//      prints one, a figure somebody TYPED off the bank's own month-end
//      statement stands in (docs/bugs/0858). Maybank's Account Activity Report
//      lists movements and no balance, so without this a Maybank month could
//      never tally or close. The typed closing is this month's end; the
//      previous month's typed closing is this month's start, because a month
//      opens where the last one closed — and a typed figure is checked against
//      the movements the way the chain is, so a mistyped one, or a day missing
//      from the files, is named with the amount rather than quietly believed.
//
// Nothing here reads a database or decides what a movement means. It arranges
// what a month is made of and hands it to reconcileBankStatement, which is the
// one place that answers whether the bank and the books agree.
// ----------------------------------------------------------------------------

import type { StatementMovement } from './bank-reconcile';

/** One uploaded statement, as far as assembling a month cares. */
export type MonthStatement = {
  id: number;
  fileName: string;
  /** First and last movement date the file carried. Null when it carried none. */
  periodFrom: string | null;
  periodTo: string | null;
  /** What the FILE printed, when it printed them. */
  openingBalanceSen: number | null;
  closingBalanceSen: number | null;
};

/** A month-end figure somebody TYPED off the bank's own statement, for an
    account whose files print no balance (docs/bugs/0858). */
export type TypedBalance = {
  /** The month whose closing this is, as YYYY-MM. */
  month: string;
  closingSen: number;
  typedBy: string | null;
  typedAt: string;
  note: string | null;
};

/** The typed figures that can speak for a month: its own closing, and the
    previous month's closing, which is where this month opens. */
export type MonthBalances = {
  closing: TypedBalance | null;
  previousClosing: TypedBalance | null;
};

export const NO_TYPED_BALANCES: MonthBalances = { closing: null, previousClosing: null };

/** Two files that should have met and did not. */
export type ChainBreak = {
  beforeId: number;
  beforeFile: string;
  /** Last day the earlier file covered, and what it said the balance was. */
  beforeTo: string;
  beforeClosingSen: number;
  afterId: number;
  afterFile: string;
  /** First day the later file covered, and what it said it opened at. */
  afterFrom: string;
  afterOpeningSen: number;
  /** Later opening minus earlier closing — the movement of the missing days. */
  gapSen: number;
};

/** Where a month's opening or closing figure was taken from: the file it was
    read off, or — when no file printed one — the person who typed it. */
export type BalanceSource = {
  /** The file. Null when the figure was typed. */
  statementId: number | null;
  fileName: string | null;
  /** The day the figure stands for. */
  on: string;
  /** Present when the figure was TYPED rather than printed: the month it was
      typed as the closing of, who typed it, when, and their note. */
  typed?: { month: string; by: string | null; at: string; note: string | null };
};

export type MonthAssembly = {
  month: string;
  /** The calendar month itself. */
  monthFrom: string;
  monthTo: string;
  /** The days actually covered by uploaded files — the window the
      reconciliation runs over, so the ledger side lines up with the balances
      the files printed rather than with days nobody has a statement for. */
  periodFrom: string;
  periodTo: string;

  statementOpeningSen: number | null;
  /** Where that opening came from, so a reader can go and look at it. Null
      when no file inside this month printed one and nothing was typed. */
  openingFrom: BalanceSource | null;
  statementClosingSen: number | null;
  closingFrom: BalanceSource | null;

  /** Files whose period crosses a month edge. Their movements inside the month
      count; their balances belong to the month they start or end in. */
  spanningIds: number[];
  breaks: ChainBreak[];
  /** Plain sentences about what this month does not have. Empty means the
      files cover it end to end and their balances meet. */
  gaps: string[];
  /** Opening known, closing known (printed or typed), no break between them,
      and a typed figure agreeing with the movements. */
  complete: boolean;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** First and last day of a YYYY-MM, as ISO dates. */
export function monthWindow(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  /* Day 0 of the NEXT month is the last day of this one — the one piece of
     date arithmetic that gets February right without a table. */
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad(last)}` };
}

/** The YYYY-MM an ISO date falls in. */
export const monthOf = (iso: string): string => iso.slice(0, 7);

/** The month before a YYYY-MM, or null when it is not a month. */
export function previousMonth(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  return mon === 1 ? `${Number(m[1]) - 1}-12` : `${m[1]}-${pad(mon - 1)}`;
}

/** The month after a YYYY-MM, or null when it is not a month. */
export function nextMonth(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  return mon === 12 ? `${Number(m[1]) + 1}-01` : `${m[1]}-${pad(mon + 1)}`;
}

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Assemble one month of one account.
 *
 * `statements` is every statement of that account that has any line in the
 * month; `movements` is those lines, already filtered to the month by their own
 * date (rule 1) and already carrying the state the reconciliation reads.
 */
export function assembleMonth(
  month: string,
  statements: MonthStatement[],
  movements: StatementMovement[],
  typed: MonthBalances = NO_TYPED_BALANCES,
): MonthAssembly | null {
  const window = monthWindow(month);
  if (!window) return null;

  /* Rule 2: only a file lying wholly inside this month can speak for the
     month's balances. One that straddles the edge still contributes its
     movements — it is simply not asked what the balance was. */
  const inside = statements.filter(
    (s) => s.periodFrom != null && s.periodTo != null
      && monthOf(s.periodFrom) === month && monthOf(s.periodTo) === month,
  );
  const spanningIds = statements
    .filter((s) => !inside.some((i) => i.id === s.id))
    .map((s) => s.id);

  const ordered = [...inside].sort(
    (a, b) => String(a.periodFrom).localeCompare(String(b.periodFrom))
      || String(a.periodTo).localeCompare(String(b.periodTo)),
  );

  const first = ordered.find((s) => s.openingBalanceSen != null) ?? null;
  /* The last file that printed a closing, by the day it CLOSED — not the last
     one uploaded. He uploads out of order and overlapping (2026-09-08). */
  const withClosing = ordered.filter((s) => s.closingBalanceSen != null);
  const last = withClosing.length > 0 ? withClosing[withClosing.length - 1]! : null;

  /* Rule 4: a figure a file PRINTS always wins. Where no file inside the month
     prints one, a figure somebody TYPED off the bank's own month-end statement
     stands in — this month's typed closing at the end, and the previous
     month's typed closing at the start, because a month opens where the last
     one closed. Only the figure for exactly that month is taken: a caller
     handing over some other month's figure is ignored, not believed. */
  const prev = previousMonth(month);
  const typedOpening = typed.previousClosing != null && prev != null && typed.previousClosing.month === prev
    ? typed.previousClosing : null;
  const typedClosing = typed.closing != null && typed.closing.month === month ? typed.closing : null;
  const statementOpeningSen = first?.openingBalanceSen ?? typedOpening?.closingSen ?? null;
  const statementClosingSen = last?.closingBalanceSen ?? typedClosing?.closingSen ?? null;
  const typedSource = (t: TypedBalance, on: string): BalanceSource => ({
    statementId: null, fileName: null, on,
    typed: { month: t.month, by: t.typedBy, at: t.typedAt, note: t.note },
  });
  const openingFrom: BalanceSource | null = first != null
    ? { statementId: first.id, fileName: first.fileName, on: String(first.periodFrom) }
    : typedOpening != null && prev != null
      ? typedSource(typedOpening, monthWindow(prev)?.to ?? window.from)
      : null;
  const closingFrom: BalanceSource | null = last != null
    ? { statementId: last.id, fileName: last.fileName, on: String(last.periodTo) }
    : typedClosing != null
      ? typedSource(typedClosing, window.to)
      : null;

  /* Rule 3: walk the files in date order and check that each one opens where
     the previous one closed. Only files printing both figures can be chained;
     one that prints neither is silent rather than a break. */
  const breaks: ChainBreak[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const before = ordered[i - 1]!;
    const after = ordered[i]!;
    if (before.closingBalanceSen == null || after.openingBalanceSen == null) continue;
    /* Overlapping exports are the ordinary case, not a break: a longer file
       covering the same days opens where the shorter one opened, and its
       repeated movements arrived IGNORED. Only a file starting AFTER the
       previous one ended is claiming to continue it. */
    if (String(after.periodFrom) <= String(before.periodTo)) continue;
    const gapSen = after.openingBalanceSen - before.closingBalanceSen;
    if (gapSen === 0) continue;
    breaks.push({
      beforeId: before.id,
      beforeFile: before.fileName,
      beforeTo: String(before.periodTo),
      beforeClosingSen: before.closingBalanceSen,
      afterId: after.id,
      afterFile: after.fileName,
      afterFrom: String(after.periodFrom),
      afterOpeningSen: after.openingBalanceSen,
      gapSen,
    });
  }

  /* The window the reconciliation runs over: the days the files actually
     cover, clipped to the month. Running it over the whole calendar month when
     only the first ten days are uploaded would count thirty days of ledger
     against ten days of bank and call the difference unexplained. */
  const covered = [
    ...ordered.map((s) => String(s.periodFrom)),
    ...ordered.map((s) => String(s.periodTo)),
    ...movements.map((m) => m.bookedOn),
  ].filter((d) => d >= window.from && d <= window.to).sort();
  const periodFrom = covered[0] ?? window.from;
  const periodTo = covered[covered.length - 1] ?? window.to;

  const gaps: string[] = [];
  const noneInside = inside.length === 0;
  if (statementOpeningSen == null) {
    gaps.push(noneInside
      ? `No file uploaded for ${month} lies wholly inside it, so the month has no opening balance of its own.`
      : `None of this month's files prints an opening balance.`
        + (prev == null ? '' : ` Type the closing balance of ${prev} off the bank's month-end statement and ${month} opens there.`));
  }
  if (statementClosingSen == null) {
    gaps.push(noneInside
      ? `No file uploaded for ${month} lies wholly inside it, so the month has no closing balance of its own.`
      : `None of this month's files prints a closing balance. Type it off the bank's month-end statement and the month can tally.`);
  }
  for (const b of breaks) {
    gaps.push(
      `${b.beforeFile} closes on ${b.beforeTo} and ${b.afterFile} opens on ${b.afterFrom} at a different figure`
      + ` — ${Math.abs(b.gapSen)} sen moved on days between them that have not been uploaded.`,
    );
  }
  if (spanningIds.length > 0) {
    gaps.push(
      `${spanningIds.length} file(s) cross the edge of this month. Their movements inside ${month} are counted;`
      + ' their opening and closing balances belong to the month they start and end in.',
    );
  }

  /* A typed figure is checked the way the chain is (rule 3): the opening plus
     this month's movements must reach the closing. Where they do not, a day is
     missing from the files or the figure is mistyped — and the amount is
     named, because it is the size of what is missing. Two PRINTED figures are
     left to the reconciliation's own identity, which says the same thing in
     its own words. An IGNORED movement is out, as it is there: a repeat of one
     already recorded, or a pair the bank itself reversed. */
  let typedShortSen = 0;
  if ((openingFrom?.typed != null || closingFrom?.typed != null)
    && statementOpeningSen != null && statementClosingSen != null) {
    const moved = movements.filter((m) => m.state !== 'IGNORED').reduce((s, m) => s + m.amountSen, 0);
    typedShortSen = statementClosingSen - (statementOpeningSen + moved);
    if (typedShortSen !== 0) {
      gaps.push(
        `${month} opens at ${rm(statementOpeningSen)}${openingFrom?.typed ? ' (typed)' : ''} and closes at`
        + ` ${rm(statementClosingSen)}${closingFrom?.typed ? ' (typed)' : ''}, but the movements uploaded come to`
        + ` ${rm(moved)} — ${rm(Math.abs(typedShortSen))} is unaccounted for: a day is missing from the files,`
        + ' or a typed figure is wrong.',
      );
    }
  }

  return {
    month,
    monthFrom: window.from,
    monthTo: window.to,
    periodFrom,
    periodTo,
    statementOpeningSen,
    openingFrom,
    statementClosingSen,
    closingFrom,
    spanningIds,
    breaks,
    gaps,
    complete: statementOpeningSen != null && statementClosingSen != null && breaks.length === 0 && typedShortSen === 0,
  };
}
