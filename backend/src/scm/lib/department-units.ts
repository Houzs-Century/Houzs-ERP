// ----------------------------------------------------------------------------
// department-units — the departments the charges feed (owner 2026-11-25), month
// by month, each its income less its real cost:
//   LOGISTICS          the 3% Operation passes on, what Finance bills extra for
//                      transport, and the in-house setup / dismantle trips it does
//                      for Setup & dismantle — less the real delivery cost: the
//                      Logistics P&L's own expense rows (outsource, our lorries,
//                      the drivers' and helpers' pay). The Logistics P&L's own
//                      "3% of DO" and "1% of fair sales" are not used here.
//   SETUP & DISMANTLE  a branch of Logistics (「logistics report 的再分支」): the 1%
//                      from the selling department, less the fair transport as
//                      booked and the in-house trips it pays Logistics for.
//   OPERATION          the 7% from the selling department and what Finance bills
//                      for warehousing, less the warehouse (its own sheet's rows,
//                      every region added up) and the 3% it pays Logistics.
// A row is income, an expense, or what the unit pays another department ('paid'),
// as the selling department's charges are.
// Pure: the route reads, this adds up.
// ----------------------------------------------------------------------------

import type { MonthCharges } from './department-charges';

export type UnitKind = 'logistics' | 'setupDismantle' | 'operation';
/** A row of a unit's P&L: income, an expense, or what it pays another department (the 3%
    Operation passes on to Logistics), its figure per month. */
export type UnitRow = { key: string; label: string; group: 'income' | 'expense' | 'paid'; cells: Record<string, number> };
export type UnitMonth = { month: string; incomeSen: number; expenseSen: number; paidSen: number; netSen: number };
export type UnitView = { unit: UnitKind; months: string[]; rows: UnitRow[]; perMonth: UnitMonth[] };

/** The rows kept (a row that is nil every month is left out), the months added up. */
function unitView(unit: UnitKind, months: readonly string[], rows: UnitRow[]): UnitView {
  const kept = rows.filter((r) => months.some((m) => (r.cells[m] ?? 0) !== 0));
  const perMonth = months.map((month) => {
    const sum = (g: UnitRow['group']) => kept.filter((r) => r.group === g).reduce((s, r) => s + (r.cells[month] ?? 0), 0);
    const incomeSen = sum('income');
    const expenseSen = sum('expense');
    const paidSen = sum('paid');
    return { month, incomeSen, expenseSen, paidSen, netSen: incomeSen - expenseSen - paidSen };
  });
  return { unit, months: [...months], rows: kept, perMonth };
}
const byMonth = (months: readonly string[], f: (m: string) => number): Record<string, number> => Object.fromEntries(months.map((m) => [m, f(m)]));
const pct = (bp: number): string => (bp / 100).toFixed(2).replace(/\.?0+$/, '');

/** One month of the Logistics P&L, row key → its figure (every region added up). */
export type LogisticsMonthRows = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** The Logistics P&L's rows read here: what Finance billed extra, the in-house trips, the real cost. */
export const LOGISTICS_RECHARGES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'ti_houzs', label: 'Transport income billed (Houzs)' },
  { key: 'ti_conts', label: 'Transport income billed (The Conts)' },
  { key: 'ti_hookka', label: 'Transport income billed (Hookka)' },
  { key: 'ti_2990', label: 'Transport income billed (2990)' },
];
export const LOGISTICS_COSTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'outsource', label: 'Outsource (3PL)' },
  { key: 'petrol', label: 'Petrol, toll and parking' },
  { key: 'upkeep', label: 'Upkeep of lorries' },
  { key: 'instalment', label: 'Lorry instalments' },
  { key: 'roadtax', label: 'Road tax & insurance' },
  { key: 'manpower', label: "Drivers' and helpers' pay" },
  { key: 'other_lorry', label: 'Other lorry cost' },
];

/** `trips`: the in-house setup / dismantle trips count as income only where Setup & dismantle
    pays for them (a company with the branch); else nobody would. */
export function buildLogisticsUnit(input: {
  months: readonly string[]; charges: readonly MonthCharges[]; logisticsBp: number; rows: LogisticsMonthRows; trips: boolean;
}): UnitView {
  const ch = new Map(input.charges.map((c) => [c.month, c] as const));
  const row = (key: string) => (m: string) => input.rows.get(m)?.get(key) ?? 0;
  return unitView('logistics', input.months, [
    { key: 'from_operation', label: `From Operation (${pct(input.logisticsBp)}% of sales excluding service)`, group: 'income', cells: byMonth(input.months, (m) => ch.get(m)?.logistics ?? 0) },
    ...LOGISTICS_RECHARGES.map((x) => ({ key: x.key, label: x.label, group: 'income' as const, cells: byMonth(input.months, row(x.key)) })),
    ...(input.trips ? [{ key: 'sd_income', label: 'In-house setup & dismantle trips (paid by Setup & dismantle)', group: 'income' as const, cells: byMonth(input.months, row('sd_income')) }] : []),
    ...LOGISTICS_COSTS.map((x) => ({ key: x.key, label: x.label, group: 'expense' as const, cells: byMonth(input.months, row(x.key)) })),
  ]);
}

/** The fair transport as booked, by account and month. */
export type BookedByAccount = ReadonlyArray<{ code: string; name: string; cells: Readonly<Record<string, number>> }>;

export function buildSetupDismantleUnit(input: {
  months: readonly string[]; charges: readonly MonthCharges[]; setupDismantleBp: number;
  fairTransport: BookedByAccount; inHouse: ReadonlyMap<string, number>;
}): UnitView {
  const ch = new Map(input.charges.map((c) => [c.month, c] as const));
  return unitView('setupDismantle', input.months, [
    { key: 'from_selling', label: `From the selling department (${pct(input.setupDismantleBp)}% of sales excluding service)`, group: 'income', cells: byMonth(input.months, (m) => ch.get(m)?.setupDismantle ?? 0) },
    ...input.fairTransport.map((a) => ({ key: a.code, label: `${a.code} · ${a.name}`, group: 'expense' as const, cells: byMonth(input.months, (m) => a.cells[m] ?? 0) })),
    { key: 'in_house', label: 'In-house trips (paid to Logistics)', group: 'expense', cells: byMonth(input.months, (m) => input.inHouse.get(m) ?? 0) },
  ]);
}

/** The Operation sheet's rows the unit reads, every region added up, by month. */
export type OperationMonthRows = ReadonlyMap<string, ReadonlyMap<string, number>>;

export function buildOperationUnit(input: {
  months: readonly string[]; charges: readonly MonthCharges[]; operationBp: number; logisticsBp: number;
  /** The sheet's income rows (warehouse, 2990, other charges) and expense rows, with their labels. */
  income: ReadonlyArray<{ key: string; label: string }>;
  expenses: ReadonlyArray<{ key: string; label: string }>;
  rows: OperationMonthRows;
}): UnitView {
  const ch = new Map(input.charges.map((c) => [c.month, c] as const));
  const row = (key: string) => (m: string) => input.rows.get(m)?.get(key) ?? 0;
  return unitView('operation', input.months, [
    { key: 'from_selling', label: `From the selling department (${pct(input.operationBp)}% of sales excluding service)`, group: 'income', cells: byMonth(input.months, (m) => ch.get(m)?.operation ?? 0) },
    ...input.income.map((x) => ({ key: x.key, label: x.label, group: 'income' as const, cells: byMonth(input.months, row(x.key)) })),
    ...input.expenses.map((x) => ({ key: x.key, label: x.label, group: 'expense' as const, cells: byMonth(input.months, row(x.key)) })),
    { key: 'to_logistics', label: `Logistics — ${pct(input.logisticsBp)}% of sales excluding service`, group: 'paid', cells: byMonth(input.months, (m) => ch.get(m)?.logistics ?? 0) },
  ]);
}
