// ----------------------------------------------------------------------------
// department-charges — what the departments pay each other (owner 2026-11-25).
// The Department P&L comes in two bases, the same arithmetic on different sales:
//   ACTUAL       — by Sales Invoice: the selling department's sales as booked;
//   PERFORMANCE  — by Sales Order: the sales orders by SO date (the Performance P&L's).
// On the selling department's sales excluding service, every month:
//   G&A                5% (「打一个5% 给 G&A」, the G&A share Finance keeps)
//   Operation          7%, of which Operation passes 3% on to Logistics
//                      (「还是这样算7% 再减3%」: its own sheet's two rates)
//   Setup & dismantle  1%, the setup and dismantle transport — a branch of
//                      Logistics (「logitisc 1% 是打给setup dismantle logitics的」),
//                      never the booth setup, which stays as booked
//   merchandise        2%, in Performance only: in place of the terminal charges
// A company pays only the departments it has: 2990 (Showroom and G&A) pays G&A.
// In Actual every expense is as booked; in Performance merchandise stands in
// for the terminal charges and the commission is its month's bills. Pure.
// ----------------------------------------------------------------------------

import { compareGroupOfItemGroup } from '../../acc/dashboard';

export type DeptBasis = 'actual' | 'performance';
export const isDeptBasis = (v: unknown): v is DeptBasis => v === 'actual' || v === 'performance';

/** The rates, in basis points of the selling department's sales excluding service. */
export type ChargeRates = { gaBp: number; operationBp: number; logisticsBp: number; setupDismantleBp: number; merchandiseBp: number };

/** What the company keeps for the charges (acc_department_settings.charges): the merchandise
    rate and the accounts it stands in for; the fair transport accounts Setup & dismantle
    carries (they leave the selling department). */
export type ChargeAccounts = { merchandiseBp: number; merchandise: string[]; setupDismantle: string[] };

const codesOf = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean))] : []);
const bpOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
};
/** The stored charge accounts, checked; anything else is none (no merchandise, no fair transport moved). */
export function parseChargeAccounts(raw: unknown): ChargeAccounts {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return { merchandiseBp: bpOf(r.merchandiseBp), merchandise: codesOf(r.merchandise), setupDismantle: codesOf(r.setupDismantle) };
}

/** The departments a company pays: those its plan has. */
export type Payees = { ga: boolean; operation: boolean; logistics: boolean; setupDismantle: boolean };

/** One month's charges, each in sen, on the month's base. */
export type MonthCharges = {
  month: string;
  /** The selling department's sales excluding service — what every rate is of. */
  baseSen: number;
  ga: number;
  operation: number;
  /** The part of Operation's 7% it passes on to Logistics. */
  logistics: number;
  setupDismantle: number;
  /** Performance only: merchandise in place of the terminal charges. */
  merchandise: number;
};

const ofBase = (baseSen: number, bp: number): number => Math.round((baseSen * bp) / 10_000);

/** Every month's charges. Logistics is paid only through Operation, so a company with
    no Operation pays it nothing. */
export function chargesOf(input: {
  months: readonly string[]; base: ReadonlyMap<string, number>; rates: ChargeRates; payees: Payees; basis: DeptBasis;
}): MonthCharges[] {
  const { rates: r, payees: p } = input;
  return input.months.map((month) => {
    const baseSen = input.base.get(month) ?? 0;
    return {
      month, baseSen,
      ga: p.ga ? ofBase(baseSen, r.gaBp) : 0,
      operation: p.operation ? ofBase(baseSen, r.operationBp) : 0,
      logistics: p.operation && p.logistics ? ofBase(baseSen, r.logisticsBp) : 0,
      setupDismantle: p.setupDismantle ? ofBase(baseSen, r.setupDismantleBp) : 0,
      merchandise: input.basis === 'performance' ? ofBase(baseSen, r.merchandiseBp) : 0,
    };
  });
}

/** What the selling department pays out in a month: G&A, Operation, Setup & dismantle. */
export const paidOut = (c: MonthCharges): number => c.ga + c.operation + c.setupDismantle;

/** The service group's sales accounts (scm.acc_item_group_accounts): what "sales excluding
    service" leaves out of the books' sales. An account another group uses too (the one
    sales-returns account every group shares) stays in. */
export function serviceAccountsOf(rows: ReadonlyArray<{ group_code?: unknown; sales_account?: unknown; sales_return_account?: unknown }>): Set<string> {
  const codes = (r: (typeof rows)[number]): string[] => [r.sales_account, r.sales_return_account].map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean);
  const isService = (r: (typeof rows)[number]): boolean => compareGroupOfItemGroup(String(r.group_code ?? '')) === 'service';
  const others = new Set(rows.filter((r) => !isService(r)).flatMap(codes));
  return new Set(rows.filter(isService).flatMap(codes).filter((c) => !others.has(c)));
}
