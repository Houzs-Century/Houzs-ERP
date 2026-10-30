// ----------------------------------------------------------------------------
// logistics-rows — which row of the Logistics P&L an account's money fills,
// chosen on the Chart of Accounts like the PMS row (owner 2026-10-29: the
// own-lorry tick list 「这样显示很丑，就不能在coa 那边tick？」 → one dropdown per
// account —「可以」). One value per account, so one amount can never land in two
// rows. The chart's picker, its save door and the P&L all read THIS list; the
// migration 20261029T2200_acc_account_logistics_row.sql carries the same values
// in its CHECK.
// ----------------------------------------------------------------------------

import { REGIONS, type ChartAccount, type RegionCode } from './logistics-cost';

export const LOGISTICS_ROWS = [
  'outsource_pg', 'outsource_kl', 'outsource_em', 'outsource_sg',
  'petrol', 'upkeep', 'other_lorry', 'instalment', 'roadtax',
  'income_pg', 'income_kl', 'income_em', 'income_sg',
] as const;
export type LogisticsRow = (typeof LOGISTICS_ROWS)[number];
export const isLogisticsRow = (v: unknown): v is LogisticsRow => typeof v === 'string' && (LOGISTICS_ROWS as readonly string[]).includes(v);

/** The region an outsource or income row is for; null for the in-house rows (the KL column). */
export function regionOfRow(row: LogisticsRow): RegionCode | null {
  const m = /^(?:outsource|income)_(pg|kl|em|sg)$/.exec(row);
  return m ? (m[1]!.toUpperCase() as RegionCode) : null;
}

const regionName = (code: RegionCode): string => REGIONS.find((r) => r.code === code)!.name;

/** Each row as the chart's picker names it. */
export function logisticsRowLabel(row: LogisticsRow): string {
  const region = regionOfRow(row);
  if (region) return `${row.startsWith('income_') ? 'Transport Income' : 'Outsource'} – ${regionName(region)}`;
  switch (row) {
    case 'petrol': return 'Petrol';
    case 'upkeep': return 'Upkeep';
    case 'other_lorry': return 'Other lorry cost';
    case 'instalment': return 'Lorry Installment';
    default: return 'RoadTax & Insurance';
  }
}

/** The account type a row reads: costs from expense accounts, the instalment from
    the HP creditor (what was paid off it), transport income from income accounts. */
export function logisticsRowType(row: LogisticsRow): 'EXPENSE' | 'LIABILITY' | 'INCOME' {
  if (row.startsWith('income_')) return 'INCOME';
  return row === 'instalment' ? 'LIABILITY' : 'EXPENSE';
}

/** The rows our own lorries' cost is made of — the Logistics cost report divides it by our trips. */
const OWN_LORRY: ReadonlySet<string> = new Set<LogisticsRow>(['petrol', 'upkeep', 'other_lorry']);
export const ownLorryAccounts = (chart: readonly ChartAccount[]): string[] =>
  chart.filter((a) => OWN_LORRY.has(String(a.logistics_row ?? ''))).map((a) => a.account_code).sort();
