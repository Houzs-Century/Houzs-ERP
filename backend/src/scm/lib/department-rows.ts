// ----------------------------------------------------------------------------
// department-rows — which department a booked amount belongs to, for the
// Department P&L (owner 2026-11-19: an Operation report = his "Operation PNL -
// Auto" sheet; a G&A report = admin, IT, legal and HQ; an Exhibition P&L;
// 「我要可以看全部的，也要可以看单独部门的」, and nothing in no department). Pure:
// the routes read the rows, this decides.
//
// Each amount first gets its NATURE (G&A, Exhibition, Showroom, Operation,
// Logistics, or Sales = the company's selling department), in this order:
//   1. an account the Chart of Accounts' Logistics column puts on an expense or
//      income row is Logistics (the Logistics P&L's own accounts);
//   2. a payroll account's line goes by the team its words name — the salary
//      journal writes one line per team (OPERATION DELIVERY SALARY - SEPT'26):
//        OPERATION DELIVERY / HELPER                       → Logistics (its manpower)
//        LOGISTIC (ADMIN), WAREHOUSE OPERATIONS, OPERATION
//        STOREKEEPER, PROCUREMENT                          → Operation (warehouse manpower)
//        DIRECTOR OFFICE, FINANCE, HR, IT, MANAGEMENT, OTHER → G&A (by team)
//        SHOWROOM → Showroom, SALES → Sales
//      a line naming no team goes where its account goes, else to Sales (2990's
//      "GROSS SALARY" lines are its showroom staff — owner 2026-11-19);
//   3. a recruitment-ads account's line (Department column "Recruitment") goes by the
//      position it names: driver / helper → Logistics; warehouse, logistic admin,
//      storekeeper, procurement → Operation (owner 2026-11-19: 这两个是operation吧);
//      sales, salesperson, promoter → Sales; showroom → Showroom; anything else G&A;
//   4. an Other Debtor recharge goes by its words: LOGISTICS / TRANSPORT CHARGES →
//      Logistics (the Logistics P&L counts them), OPERATION / WAREHOUSE CHARGES →
//      Operation;
//   5. otherwise the account's Department column; an expense account with none is
//      in no department yet (the report says so, line by line).
// Then the COMPANY'S PLAN turns the nature into one of its departments
// (scm.acc_department_settings.plan): Houzs has G&A, Exhibition, Operation and
// Logistics and its showroom counts in G&A; 2990 has Showroom and G&A, and its
// exhibition, operation and logistics count in Showroom (「2990只会有showroom和office」).
// The Department column's values are DEPARTMENT_ROWS; the newest migration that
// sets the department_row CHECK carries the same list (tests/departmentRowConstraint).
// ----------------------------------------------------------------------------

import type { ChartAccount } from './logistics-cost';
import { isLogisticsRow, logisticsRowType } from './logistics-rows';

/** A department a company can have. */
export type Department = 'ga' | 'exhibition' | 'showroom' | 'operation' | 'logistics';
export const DEPARTMENTS: readonly Department[] = ['ga', 'exhibition', 'showroom', 'operation', 'logistics'];
export const DEPARTMENT_LABEL: Record<Department, string> = {
  ga: 'G&A', exhibition: 'Exhibition', showroom: 'Showroom', operation: 'Operation', logistics: 'Logistics',
};
const isDepartment = (v: unknown): v is Department => typeof v === 'string' && (DEPARTMENTS as readonly string[]).includes(v);

/** An amount's nature: a department, or Sales — the company's selling department. */
export type Nature = Department | 'sales';
/** A column of the All view: a department, or — an expense account no column claims — none yet. */
export type DeptKey = Department | 'none';
export const NONE_LABEL = 'No department yet';


export type DepartmentPlan = {
  departments: Department[];
  selling: Department;
  folds: Partial<Record<Department, Department>>;
};
/** A company with no plan of its own: every department, Exhibition selling. */
export const DEFAULT_PLAN: DepartmentPlan = { departments: [...DEPARTMENTS], selling: 'exhibition', folds: {} };

/** The stored plan, checked: unknown or missing parts read as the default's. */
export function parsePlan(raw: unknown): DepartmentPlan {
  const p = (raw && typeof raw === 'object' ? raw : {}) as { departments?: unknown; selling?: unknown; folds?: unknown };
  const departments = Array.isArray(p.departments) ? [...new Set(p.departments.filter(isDepartment))] : [];
  if (departments.length === 0) return DEFAULT_PLAN;
  const selling = isDepartment(p.selling) && departments.includes(p.selling) ? p.selling : departments[0]!;
  const folds: Partial<Record<Department, Department>> = {};
  if (p.folds && typeof p.folds === 'object') {
    for (const [from, to] of Object.entries(p.folds as Record<string, unknown>)) {
      if (isDepartment(from) && isDepartment(to) && departments.includes(to)) folds[from] = to;
    }
  }
  return { departments, selling, folds };
}

/** The department an amount of this nature counts in, for this company. A nature it
    has no department for and no fold counts in G&A (or its first department). */
export function resolveDept(nature: Nature | 'none', plan: DepartmentPlan): DeptKey {
  if (nature === 'none') return 'none';
  const d = nature === 'sales' ? plan.selling : nature;
  if (plan.departments.includes(d)) return d;
  const folded = plan.folds[d];
  if (folded && plan.departments.includes(folded)) return folded;
  return plan.departments.includes('ga') ? 'ga' : plan.departments[0]!;
}


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
/** The sheet's own row for job ads of warehouse posts (not an account's row). */
export const RECRUITMENT_LABEL = 'Recruitment (job ads)';


const PLAIN_ROWS = ['ga', 'exhibition', 'showroom', 'logistics', 'operation', 'sales', 'hire'] as const;
type PlainRow = (typeof PLAIN_ROWS)[number];
const PLAIN_LABEL: Record<PlainRow, string> = {
  ga: 'G&A', exhibition: 'Exhibition', showroom: 'Showroom', logistics: 'Logistics', operation: 'Operation (no particular row)',
  sales: 'Sales — the company\'s selling department', hire: 'Recruitment — by the position its line names',
};

/** Every value of the column: a plain nature, Recruitment, or an Operation row in a region. */
export const DEPARTMENT_ROWS: readonly string[] = [
  'ga',
  ...OP_ROWS.flatMap((row) => OP_REGIONS.map((r) => `op_${row}_${r.code.toLowerCase()}`)),
  ...PLAIN_ROWS.filter((v) => v !== 'ga'),
];
export const isDepartmentRow = (v: unknown): v is string => typeof v === 'string' && DEPARTMENT_ROWS.includes(v);

/** An Operation row of the column, or null for any other value. */
export function opRowOf(value: string | null | undefined): { row: OpRow; region: OpRegion } | null {
  const m = /^op_([a-z]+)_(pg|kl|em)$/.exec(String(value ?? ''));
  if (!m || !isOpRow(m[1]!)) return null;
  return { row: m[1] as OpRow, region: m[2]!.toUpperCase() as OpRegion };
}

/** Each value as the chart's picker names it. */
export function departmentRowLabel(value: string): string {
  if ((PLAIN_ROWS as readonly string[]).includes(value)) return PLAIN_LABEL[value as PlainRow];
  const op = opRowOf(value);
  if (!op) return value;
  return `Operation – ${OP_REGIONS.find((r) => r.code === op.region)!.name} – ${OP_ROW_LABEL[op.row]}`;
}


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
const SHOWROOM_PAY = /^\s*SHOWROOM\b/i;
const SALES_PAY = /^\s*SALES\b/i;

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
  | { dept: 'ga'; team: GaTeam }
  | { dept: 'showroom' }
  | { dept: 'sales' };

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
  if (SHOWROOM_PAY.test(text)) return { dept: 'showroom' };
  if (SALES_PAY.test(text)) return { dept: 'sales' };
  return null;
}

/** A job ad's nature by the position its words name (owner 2026-11-19: Logistic admin
    and Warehouse assistant are Operation's). */
export function hireLineOf(notes: string | null | undefined): Nature {
  const s = String(notes ?? '').toUpperCase();
  if (/\b(WAREHOUSE|LOGISTICS?|STORE\s*KEEPERS?|PROCU?REMENT)\b/.test(s)) return 'operation';
  if (/\b(DRIVERS?|HELPERS?|LORRY|LORI)\b/.test(s)) return 'logistics';
  if (/\bSHOWROOM\b/.test(s)) return 'showroom';
  if (/\b(SALES|SALESMAN|SALESPERSON|PROMOTERS?)\b/.test(s)) return 'sales';
  return 'ga';
}


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


export type DeptAccount = ChartAccount & { department_row?: string | null; section?: string | null };

export type AccountHome =
  | { dept: 'logistics' | 'ga' | 'exhibition' | 'showroom' | 'sales' }
  | { dept: 'operation'; row: OpRow | null; region: OpRegion }
  | { dept: 'hire' }
  | { dept: 'none' };

/** Where an account's money goes when nothing on the line says otherwise. */
export function accountHome(a: DeptAccount | undefined): AccountHome {
  if (!a) return { dept: 'none' };
  const lrow = a.logistics_row;
  if (isLogisticsRow(lrow) && logisticsRowType(lrow) !== 'LIABILITY') return { dept: 'logistics' };
  const v = a.department_row;
  const op = opRowOf(v);
  if (op) return { dept: 'operation', ...op };
  if (v === 'operation') return { dept: 'operation', row: 'expenses', region: 'KL' };
  if (v === 'ga' || v === 'exhibition' || v === 'showroom' || v === 'logistics' || v === 'sales' || v === 'hire') return { dept: v };
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

/** An Operation sheet row a line fills: an account's row, a team's manpower, or the job ads. */
export type OpSheetRow = OpRow | ManpowerRow | 'recruitment';

export type LineHome =
  | { dept: 'logistics' | 'exhibition' | 'showroom' | 'sales' }
  | { dept: 'ga'; team: GaTeam | null }
  | { dept: 'operation'; row: OpSheetRow | null; region: OpRegion | null; income: OpIncome | null }
  | { dept: 'none' };

/** Where one booked line goes by nature: rules 1–5 above. `payroll` = its account is a
    payroll account; `recharge` = its account is an income account (an Other Debtor line's). */
export function lineHome(a: DeptAccount | undefined, notes: string | null | undefined, kind: { payroll: boolean; recharge: boolean }): LineHome {
  const home = accountHome(a);
  if (home.dept === 'logistics') return { dept: 'logistics' };
  if (kind.payroll) {
    const pay = payLineOf(notes);
    if (pay?.dept === 'operation') return { ...pay, income: null };
    if (pay) return pay;
    if (home.dept === 'none' || home.dept === 'hire') return { dept: 'sales' };
  }
  if (home.dept === 'hire') {
    const n = hireLineOf(notes);
    if (n === 'operation') return { dept: 'operation', row: 'recruitment', region: regionNamed(notes), income: null };
    return n === 'ga' ? { dept: 'ga', team: null } : { dept: n };
  }
  if (kind.recharge) {
    if (isTransportRecharge(notes)) return { dept: 'logistics' };
    const income = opIncomeOf(notes);
    if (income) return { dept: 'operation', row: null, region: regionNamed(notes), income };
  }
  if (home.dept === 'ga') return { dept: 'ga', team: null };
  if (home.dept === 'operation') return { dept: 'operation', row: home.row, region: home.region, income: null };
  if (home.dept === 'exhibition' || home.dept === 'showroom' || home.dept === 'sales') return { dept: home.dept };
  return { dept: 'none' };
}

/** Whether an account's money must be read line by line (its lines go to different departments). */
export const isMixedAccount = (a: DeptAccount | undefined, payroll: ReadonlySet<string>): boolean =>
  !!a && (payroll.has(a.account_code) || accountHome(a).dept === 'hire');
