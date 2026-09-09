// ----------------------------------------------------------------------------
// acc/journal-class — the five journals (GL redesign item 7).
//
// The owner reads his books the AutoCount way: SALES / PURCHASE / BANK / CASH
// / GENERAL journals (his screenshot of the Multi-Select Journal Type dialog,
// 2026-09-05 — 我记得正常也分成几大类 transaction). Every entry ALREADY
// belongs to one by construction; this file just says it out loud, derived —
// never stored, so a rule change re-labels history for free:
//
//   SI…        → SALES        (invoices and their reversals)
//   PI…        → PURCHASE
//   CASHUP     → CASH         (the drawer count is cash by definition)
//   SETTLE…    → BANK         (acquirer money moves against transit/bank)
//   STOCKADJ…, MANUAL… → GENERAL (the JV — his accruals — and the month close)
//   SOPAY / SIPAY / PV… → by the MONEY LEG: a line on the company's CASH role
//                account makes it a CASH journal, anything else is BANK —
//                a collection can land in the drawer or the bank, and the
//                entry itself is the only honest witness.
//   anything new → GENERAL, never a guess at money it might not touch.
// ----------------------------------------------------------------------------

export type JournalClass = 'SALES' | 'PURCHASE' | 'BANK' | 'CASH' | 'GENERAL';

export const JOURNAL_CLASSES: readonly JournalClass[] = ['SALES', 'PURCHASE', 'BANK', 'CASH', 'GENERAL'];

const FIXED: Record<string, JournalClass> = {
  SI: 'SALES',
  PI: 'PURCHASE',
  API: 'PURCHASE', // the non-stock supplier bill is purchase history too

  CASHUP: 'CASH',
  SETTLE: 'BANK',
  SETTLEADJ: 'BANK',
  SETTLEBANK: 'BANK',
  STOCKADJ: 'GENERAL',
  MANUAL: 'GENERAL',
};

const MONEY_SIDE = new Set(['SOPAY', 'SIPAY', 'PV']);

export function classifyJournal(
  sourceType: string | null | undefined,
  accountCodes: readonly string[],
  cashAccountCode: string,
): JournalClass {
  // A reversal belongs to its original's journal — the contra of a sales
  // invoice is still sales history.
  const base = String(sourceType ?? '').replace(/_REVERSAL$/, '');
  const fixed = FIXED[base];
  if (fixed) return fixed;
  if (MONEY_SIDE.has(base)) {
    return accountCodes.includes(cashAccountCode) ? 'CASH' : 'BANK';
  }
  return 'GENERAL';
}
