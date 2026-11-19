// ----------------------------------------------------------------------------
// department-rows — which department a booked amount belongs to, for the
// Department P&L (owner 2026-11-19: an Operation report = his "Operation PNL -
// Auto" sheet; a G&A report = admin, IT, legal and HQ; 「我要可以看全部的，也要可以
// 看单独部门的」). Pure: the routes read the rows, this decides.
//
// One amount lands in ONE department, decided in this order:
//   1. an account the Chart of Accounts' Logistics column puts on an expense or
//      income row is Logistics (the Logistics P&L's own accounts);
//   2. a payroll account's line goes by the team its words name — the salary
//      journal writes one line per team (OPERATION DELIVERY SALARY - SEPT'26):
//        OPERATION DELIVERY / HELPER                       → Logistics (its manpower)
//        LOGISTIC (ADMIN), WAREHOUSE OPERATIONS, OPERATION
//        STOREKEEPER, PROCUREMENT                          → Operation (warehouse manpower)
//        DIRECTOR OFFICE, FINANCE, HR, IT, MANAGEMENT, OTHER → G&A (by team)
//      a line naming no team goes where its account goes;
//   3. an Other Debtor recharge goes by its words: LOGISTICS / TRANSPORT CHARGES →
//      Logistics (the Logistics P&L counts them), OPERATION / WAREHOUSE CHARGES →
//      Operation;
//   4. otherwise the account's Department column on the Chart of Accounts: G&A, or
//      one Operation row in one region; nothing = in no department yet.
// The Department column's values are DEPARTMENT_ROWS; the migration
// 20261119T2300_acc_department_pnl.sql carries the same list in its CHECK.
// ----------------------------------------------------------------------------

import type { ChartAccount } from './logistics-cost';
import { isLogisticsRow, logisticsRowType } from './logistics-rows';

export type Department = 'ga' | 'operation' | 'logistics';
/** A column of the All view: a department, or none yet. */
export type DeptKey = Department | 'none';
export const DEPT_KEYS: readonly DeptKey[] = ['ga', 'operation', 'logistics', 'none'];
export const DEPT_LABEL: Record<DeptKey, string> = { ga: 'G&A', operation: 'Operation', logistics: 'Logistics', none: 'Not in a department' };

/** The Operation sheet's three regions: Penang, KL (Singapore goes out of KL), Sabah & Sarawak. */
export type OpRegion = 'PG' | 'KL' | 'EM';
export const OP_REGIONS: ReadonlyArray<{ code: OpRegion; name: string }> = [
  { code: 'PG', name: 'Penang' }, { code: 'KL', name: 'KL' }, { code: 'EM', name: 'SBH & SWK' },
];
export const OP_REGION_CODES: readonly OpRegion[] = OP_REGIONS.map((r) => r.code);

/** The Operation rows an account can fill, in the sheet's order and words. */
export const OP_ROWS = ['accommodation', 'rental', 'expenses', 'parttime', 'upkeep', 'insurance', 'utilities', 'telephone'] as const;
export type OpRow = (typeof OP_ROWS)[number];
export const OP_ROW_LABEL: Record<OpRow, string> = {
  accommodation: 'Accommodation Cost',
  rental: 'Rental Warehouse',
  expenses: 'Expenses of Warehouse',
  parttime: 'Part Time Worker / Wages',
  upkeep: 'Upkeep of Warehouse',
  insurance: 'Insurance Warehouse',
  utilities: 'Water & Electricity',
  telephone: 'Telephone & Internet',
};
const isOpRow = (v: string): v is OpRow => (OP_ROWS as readonly string[]).includes(v);

/** Every value of the Chart of Accounts' Department column: G&A, or an Operation row in a region. */
export const DEPARTMENT_ROWS: readonly string[] = [
  'ga',
  ...OP_ROWS.flatMap((row) => OP_REGIONS.map((r) => `op_${row}_${r.code.toLowerCase()}`)),
];
export const isDepartmentRow = (v: unknown): v is string => typeof v === 'string' && DEPARTMENT_ROWS.includes(v);

/** An Operation row of the column, or null for G&A / anything else. */
export function opRowOf(value: string | null | undefined): { row: OpRow; region: OpRegion } | null {
  const m = /^op_([a-z]+)_(pg|kl|em)$/.exec(String(value ?? ''));
  if (!m || !isOpRow(m[1]!)) return null;
  return { row: m[1] as OpRow, region: m[2]!.toUpperCase() as OpRegion };
}

/** Each value as the chart's picker names it. */
export function departmentRowLabel(value: string): string {
  if (value === 'ga') return 'G&A';
  const op = opRowOf(value);
  if (!op) return value;
  return `Operation – ${OP_REGIONS.find((r) => r.code === op.region)!.name} – ${OP_ROW_LABEL[op.row]}`;
}

/* ── Payroll lines: the team the words name ─────────────────────────────── */

export type ManpowerRow = 'manpower_logistic' | 'manpower_operation' | 'manpower_procurement' | 'manpower_storekeeper';
export const MANPOWER_LABEL: Record<ManpowerRow, string> = {
  manpower_logistic: 'Warehouse Manpower - Logistic',
  manpower_operation: 'Warehouse Manpower - Operation',
  manpower_procurement: 'Warehouse Manpower - Procurement',
  manpower_storekeeper: 'Warehouse Manpower - Storekeeper',
};
export const MANPOWER_ROWS: readonly ManpowerRow[] = ['manpower_logistic', 'manpower_operation', 'manpower_procurement', 'manpower_storekeeper'];

export type GaTeam = 'DIRECTOR OFFICE' | 'FINANCE' | 'HR' | 'IT' | 'MANAGEMENT' | 'OTHER';
/** The HQ teams the salary journal names, as the G&A report names them, in its order. */
export const GA_TEAM_LABEL: Record<GaTeam, string> = {
  'DIRECTOR OFFICE': 'Director office team', FINANCE: 'Finance team', HR: 'HR team', IT: 'IT team', MANAGEMENT: 'Management team', OTHER: 'Other staff',
};
export const GA_TEAMS = Object.keys(GA_TEAM_LABEL) as GaTeam[];

const LOGISTICS_PAY = /^\s*OPERATION\s+(DELIVERY|HELPER)\b/i;
const OPERATION_PAY: ReadonlyArray<readonly [RegExp, ManpowerRow]> = [
  [/^\s*LOGISTICS?\s*\(\s*ADMIN\s*\)/i, 'manpower_logistic'],
  [/^\s*WAREHOUSE\s+OPERATIONS?\b/i, 'manpower_operation'],
  [/^\s*(?:OPERATIONS?\s+|WAREHOUSE\s+)?PROCU?REMENT\b/i, 'manpower_procurement'],
  [/^\s*(?:OPERATIONS?\s+|WAREHOUSE\s+)?STORE\s*KEEPERS?\b/i, 'manpower_storekeeper'],
];
const GA_PAY = /^\s*(DIRECTOR\s+OFFICE|FINANCE|HR|IT|MANAGEMENT|OTHERS?)\b/i;

/** The region a line's words name — "OPERATION STOREKEEPER PG SALARY" is Penang's;
    none, or more than one, names none (the line is then shared by the DOs' value). */
export function regionNamed(text: string | null | undefined): OpRegion | null {
  const s = String(text ?? '').toUpperCase();
  const found = new Set<OpRegion>();
  if (/\b(PG|PNG|PENANG|PULAU\s+PINANG)\b/.test(s)) found.add('PG');
  if (/\b(KL|BALAKONG|BLK|KUALA\s+LUMPUR|SELANGOR)\b/.test(s)) found.add('KL');
  if (/\b(SBH|SABAH|SWK|SRW|SARAWAK|KCH|KUCHING|KOTA\s+KINABALU)\b/.test(s)) found.add('EM');
  return found.size === 1 ? [...found][0]! : null;
}

export type PayLine =
  | { dept: 'logistics' }
  | { dept: 'operation'; row: ManpowerRow; region: OpRegion | null }
  | { dept: 'ga'; team: GaTeam };

/** The team a payroll line's words name, or null when they name none. */
export function payLineOf(notes: string | null | undefined): PayLine | null {
  const text = String(notes ?? '');
  if (LOGISTICS_PAY.test(text)) return { dept: 'logistics' };
  for (const [re, row] of OPERATION_PAY) {
    const m = re.exec(text);
    if (m) return { dept: 'operation', row, region: regionNamed(text.slice(m[0].length)) };
  }
  const g = GA_PAY.exec(text);
  if (g) {
    const word = g[1]!.toUpperCase().replace(/\s+/g, ' ');
    return { dept: 'ga', team: (word.startsWith('OTHER') ? 'OTHER' : word) as GaTeam };
  }
  return null;
}

/* ── Other Debtor recharges: the words ───────────────────────────────────── */

export type OpIncome = 'warehouse' | 'charges';
/** "WAREHOUSE CHARGES - NOV'26" is Warehouse income, "OPERATION CHARGES - SEP'26"
    the operation charges; anything else is neither. */
export function opIncomeOf(text: string | null | undefined): OpIncome | null {
  const s = String(text ?? '');
  if (/^\s*WAREHOUSE\s+(CHARGES?|FEES?|INCOME|RENTAL)\b/i.test(s)) return 'warehouse';
  if (/^\s*OPERATIONS?\s+(CHARGES?|FEES?|INCOME)\b/i.test(s)) return 'charges';
  return null;
}

/** A recharge worded as transport — the Logistics P&L's own rule (logistics-pnl isRechargeWording). */
export const isTransportRecharge = (text: string | null | undefined): boolean =>
  /^\s*(LOGISTICS?|TRANSPORT(ATION)?)\s+(CHARGES?|FEES?|INCOME)\b/i.test(String(text ?? ''));

/* ── Accounts ────────────────────────────────────────────────────────────── */

export type DeptAccount = ChartAccount & { department_row?: string | null; section?: string | null };

export type AccountHome =
  | { dept: 'logistics' }
  | { dept: 'ga' }
  | { dept: 'operation'; row: OpRow; region: OpRegion }
  | { dept: 'none' };

/** Where an account's money goes when nothing on the line says otherwise. */
export function accountHome(a: DeptAccount | undefined): AccountHome {
  if (!a) return { dept: 'none' };
  const lrow = a.logistics_row;
  if (isLogisticsRow(lrow) && logisticsRowType(lrow) !== 'LIABILITY') return { dept: 'logistics' };
  if (a.department_row === 'ga') return { dept: 'ga' };
  const op = opRowOf(a.department_row);
  if (op) return { dept: 'operation', ...op };
  return { dept: 'none' };
}

/** The payroll accounts the salary journal writes its team lines on — the Logistics
    P&L's own list (logistics-pnl salaryAccounts): expense accounts named as pay, none
    the Logistics column claims. */
export function payrollAccounts(chart: readonly DeptAccount[]): Set<string> {
  return new Set(chart.filter((a) =>
    String(a.account_type ?? '').toUpperCase() === 'EXPENSE' && a.is_active !== false && !isLogisticsRow(a.logistics_row)
    && /SALAR|\bEPF\b|SOCSO|\bEIS\b|ALLOWANCE|WAGES|OVERTIME|SKBB/.test(String(a.account_name ?? '').toUpperCase()),
  ).map((a) => a.account_code));
}

export type LineHome =
  | { dept: 'logistics' }
  | { dept: 'ga'; team: GaTeam | null }
  /** `row`: the Operation row an expense fills (an account's, or a team's manpower);
      `income`: the recharge an income line is. `region` null = shared by the DOs' value. */
  | { dept: 'operation'; row: OpRow | ManpowerRow | null; region: OpRegion | null; income: OpIncome | null }
  | { dept: 'none' };

/** Where one booked line goes: rules 1–4 above. `payroll` = its account is a payroll
    account; `recharge` = its account is an income account (an Other Debtor line's). */
export function lineHome(a: DeptAccount | undefined, notes: string | null | undefined, kind: { payroll: boolean; recharge: boolean }): LineHome {
  const home = accountHome(a);
  if (home.dept === 'logistics') return home;
  if (kind.payroll) {
    const pay = payLineOf(notes);
    if (pay?.dept === 'logistics' || pay?.dept === 'ga') return pay;
    if (pay?.dept === 'operation') return { ...pay, income: null };
  }
  if (kind.recharge) {
    if (isTransportRecharge(notes)) return { dept: 'logistics' };
    const income = opIncomeOf(notes);
    if (income) return { dept: 'operation', row: null, region: regionNamed(notes), income };
  }
  if (home.dept === 'ga') return { dept: 'ga', team: null };
  if (home.dept === 'operation') return { dept: 'operation', row: home.row, region: home.region, income: null };
  return { dept: 'none' };
}
