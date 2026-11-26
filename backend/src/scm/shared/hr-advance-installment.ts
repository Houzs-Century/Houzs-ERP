// How much of an employee advance comes off one payroll month (HC-0125).
//
// An advance (cash given ahead of payday) is either a LUMP SUM — the whole
// amount is deducted from the slip of the month it was given (installmentSen
// null, today's behaviour) — or repaid in equal monthly installments of
// installmentSen, starting that same month, until the amount is cleared (the
// last month takes whatever is left, which is <= installmentSen).
//
// Deterministic and keyed only on the two months, the full amount and the
// per-month installment: payroll recomputes any month's deduction from these
// alone, so no per-month repayment state is ever stored. Both input modes the
// owner asked for ("split into N months" and "fixed RM/month") collapse to the
// single installmentSen the caller computes, so this one function serves both.

function monthIndex(ym: string): number {
  const [year, month] = ym.split("-").map(Number);
  return year * 12 + (month - 1);
}

/**
 * The advance's deduction on `payrollMonth`'s slip, in sen.
 *   - payrollMonth before advanceMonth -> 0 (not started).
 *   - installmentSen null -> the whole amount in advanceMonth, else 0 (lump sum).
 *   - otherwise the installment, capped at whatever is still owed (0 once repaid).
 */
export function advanceInstallmentForMonth(
  advanceMonth: string,
  installmentSen: number | null,
  amountSen: number,
  payrollMonth: string,
): number {
  const monthsElapsed = monthIndex(payrollMonth) - monthIndex(advanceMonth);
  if (monthsElapsed < 0) return 0;
  if (installmentSen == null) return monthsElapsed === 0 ? amountSen : 0;
  const cumulativeBefore = monthsElapsed * installmentSen;
  const remaining = Math.max(0, amountSen - cumulativeBefore);
  return Math.min(installmentSen, remaining);
}

/**
 * What is still owed on the advance AFTER `payrollMonth`'s deduction, in sen —
 * the outstanding balance the page shows going forward. 0 once fully repaid.
 */
export function advanceRemainingAfterMonth(
  advanceMonth: string,
  installmentSen: number | null,
  amountSen: number,
  payrollMonth: string,
): number {
  const monthsElapsed = monthIndex(payrollMonth) - monthIndex(advanceMonth);
  if (monthsElapsed < 0) return amountSen;
  if (installmentSen == null) return 0;
  const cumulativeThrough = (monthsElapsed + 1) * installmentSen;
  return Math.max(0, amountSen - cumulativeThrough);
}
