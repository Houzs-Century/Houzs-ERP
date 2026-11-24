// ----------------------------------------------------------------------------
// trade-finance-forecast — the Cash Flow's trade-finance plan (step 5 of the
// Hookka forecast port, docs/forecast-port-spec.md part 3; owner 2026-11-24
// 「开始做第 5 步」, D3: no limit, each draw repaid about two months after it —
// 「毕竟只是forecast，算2个月吧」).
//
// A facility is a liability account named TRADE FINANCE (Houzs: one, at
// Maybank). Its draws are the credits on it — manual journals, the opening
// balance among them — and its repayments the debits, payment vouchers whose
// other debit line is the interest. Repayments pay the oldest draws first;
// what is left is owed, each draw repaid a tenor after it (60 days unless
// Finance sets another; one already past due in the current month) with its
// interest — Finance's rate per draw, else the last six repayments' interest
// over their principal — on the interest account, as the vouchers book it.
//
// Planned draws: Finance names the suppliers the facility pays. Each of their
// dues — a bill the books still owe (step 4's: on its plan, due date or term,
// past due in the current month) or, from the current month on, a Forecast
// P&L supplier figure after the supplier's term — is drawn in its month
// unless unticked, and repaid a tenor later with its interest. No limit (D3).
// The drawdown sits on the facility as money in; the bills it pays stay where
// they are, so the month nets to nothing and the cash leaves at repayment.
// Pure: no reads.
// ----------------------------------------------------------------------------

import { addMonthsYm, type CashLeg } from './cashflow-pnl-forecast';

/** The facility's tenor when Finance has set none (D3: two months). */
export const DEFAULT_TENOR_DAYS = 60;
/** How many recent repayments set the default rate. */
const RATE_SAMPLE = 6;

/** A liability account named TRADE FINANCE that is not a bank account itself. */
export const isFacilityAccount = (a: { name: string; type: string | null; money: boolean }): boolean =>
  !a.money && String(a.type ?? '').toUpperCase() === 'LIABILITY' && /TRADE\s*FINANCE/i.test(a.name);

/** The lender, from the account's name: "TRADE FINANCE - MAYBANK" → "MAYBANK". */
export function lenderOf(name: string): string {
  const rest = name.replace(/^.*TRADE\s*FINANCE\s*[-–:]?\s*/i, '').trim();
  return rest || name;
}

export type FacilityLine = { date: string; debitSen: number; creditSen: number };
export type OpenDraw = { date: string; sen: number };

/** The draws still owed: the repayments pay the oldest draws first. */
export function openDraws(lines: readonly FacilityLine[]): OpenDraw[] {
  const draws = lines.filter((l) => l.creditSen > 0).map((l) => ({ date: l.date, sen: l.creditSen })).sort((a, b) => a.date.localeCompare(b.date));
  let repaid = lines.reduce((s, l) => s + Math.max(0, l.debitSen), 0);
  const out: OpenDraw[] = [];
  for (const d of draws) {
    const take = Math.min(repaid, d.sen);
    repaid -= take;
    if (d.sen - take > 0) out.push({ date: d.date, sen: d.sen - take });
  }
  return out;
}

/** Interest per draw, in basis points: the last six repayments' interest over their principal, averaged. */
export function defaultRateBp(repayments: ReadonlyArray<{ date: string; principalSen: number; interestSen: number }>): number {
  const rates = [...repayments].filter((r) => r.principalSen > 0 && r.interestSen > 0)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, RATE_SAMPLE).map((r) => (r.interestSen / r.principalSen) * 10_000);
  return rates.length > 0 ? Math.round(rates.reduce((s, r) => s + r, 0) / rates.length) : 0;
}

/** The month a draw made in `ym` is repaid: a tenor later, in whole months. */
export const repayYm = (ym: string, tenorDays: number): string => addMonthsYm(ym, Math.max(0, Math.round(tenorDays / 30)));
/** A draw's interest at `rateBp` per draw. */
export const interestOf = (principalSen: number, rateBp: number): number => Math.round((principalSen * rateBp) / 10_000);

/** What a chosen supplier is due in a month: from bills the books owe, and from the Forecast P&L. */
export type Due = { billSen: number; forecastSen: number };
/** Supplier id → month → what is due. */
export type Dues = Record<string, Record<string, Due>>;

/** The chosen suppliers' dues by month: an owed bill in its month (past due in
    the current one), a Forecast P&L figure in its month; nothing past `lastYm`. */
export function supplierDues(o: {
  currentYm: string; lastYm: string; chosen: ReadonlySet<string>;
  bills: ReadonlyArray<{ supplierId: string; ym: string; sen: number }>;
  forecast: ReadonlyArray<{ supplierId: string; ym: string; sen: number }>;
}): Dues {
  const out: Dues = {};
  const add = (id: string, ym: string, sen: number, part: keyof Due): void => {
    if (!o.chosen.has(id) || !(sen > 0)) return;
    const at = ym < o.currentYm ? o.currentYm : ym;
    if (at > o.lastYm) return;
    const cell = ((out[id] ??= {})[at] ??= { billSen: 0, forecastSen: 0 });
    cell[part] += sen;
  };
  for (const b of o.bills) add(b.supplierId, b.ym, b.sen, 'billSen');
  for (const f of o.forecast) if (f.ym >= o.currentYm) add(f.supplierId, f.ym, f.sen, 'forecastSen');
  return out;
}

/** Month → supplier ids unticked by hand. */
export type Off = Record<string, string[]>;
const ticked = (off: Off, ym: string, id: string): boolean => !(off[ym] ?? []).includes(id);

export type TfPlanInput = {
  currentYm: string;
  facility: { code: string; name: string; lender: string };
  /** Where the interest is booked; none = no interest leg. */
  interest: { code: string; name: string } | null;
  tenorDays: number;
  rateBp: number;
  /** The draws owed today. */
  open: readonly OpenDraw[];
  dues: Dues;
  off: Off;
  supplierName: (id: string) => string;
};

export type TfMonth = { ym: string; drawSen: number; repaySen: number; interestSen: number; owedSen: number };

const monthTitle = (ym: string): string => new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The facility's legs — the owed draws repaid, the planned draws and their
    repayment — and its months from the current one: drawn, repaid, the
    interest paid, what is owed at the month's end. */
export function tfPlan(input: TfPlanInput, months: readonly string[]): { legs: CashLeg[]; schedule: TfMonth[] } {
  const { currentYm, facility, interest, tenorDays, rateBp } = input;
  const legs: CashLeg[] = [];
  const repaid = new Map<string, number>();
  const charged = new Map<string, number>();
  const base = { source: 'tf' as const, ref: null, party: facility.lender };
  const repay = (ym: string, fromYm: string, sen: number, note: string): void => {
    legs.push({ ...base, ym, fromYm, flow: 'out', code: facility.code, key: facility.code, name: facility.name, sen, note });
    repaid.set(ym, (repaid.get(ym) ?? 0) + sen);
    const i = interestOf(sen, rateBp);
    if (interest && i > 0) {
      legs.push({ ...base, ym, fromYm, flow: 'out', code: interest.code, key: interest.code, name: interest.name, sen: i, note: `interest on it · ${note}` });
      charged.set(ym, (charged.get(ym) ?? 0) + i);
    }
  };
  const tenorWords = `${Math.round(tenorDays / 30)} months after`;
  for (const d of input.open) {
    const due = repayYm(d.date.slice(0, 7), tenorDays);
    repay(due < currentYm ? currentYm : due, d.date.slice(0, 7), d.sen, `drawn ${d.date}, repaid ${tenorWords}${due < currentYm ? ' (past due)' : ''}`);
  }
  const drawn = new Map<string, number>();
  for (const ym of [...new Set(Object.values(input.dues).flatMap((m) => Object.keys(m)))].sort()) {
    const ids = Object.keys(input.dues).filter((id) => {
      const cell = (input.dues as Partial<Record<string, Partial<Record<string, Due>>>>)[id]?.[ym];
      return cell != null && cell.billSen + cell.forecastSen > 0 && ticked(input.off, ym, id);
    }).sort((a, b) => input.supplierName(a).localeCompare(input.supplierName(b)));
    const sen = ids.reduce((s, id) => { const c = input.dues[id]![ym]!; return s + c.billSen + c.forecastSen; }, 0);
    if (sen <= 0) continue;
    drawn.set(ym, sen);
    legs.push({ ...base, ym, fromYm: ym, flow: 'in', code: facility.code, key: `${facility.code}:PLAN`, name: 'Drawdown — planned', sen, note: `pays ${ids.map(input.supplierName).join(', ')} · forecast only` });
    repay(repayYm(ym, tenorDays), ym, sen, `the ${monthTitle(ym)} drawdown, repaid ${tenorWords}`);
  }
  let owed = input.open.reduce((s, d) => s + d.sen, 0);
  const schedule = months.map((ym) => {
    const drawSen = drawn.get(ym) ?? 0;
    const repaySen = repaid.get(ym) ?? 0;
    owed += drawSen - repaySen;
    return { ym, drawSen, repaySen, interestSen: charged.get(ym) ?? 0, owedSen: owed };
  });
  return { legs, schedule };
}
