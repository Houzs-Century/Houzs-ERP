/* Which department a booked amount belongs to (owner 2026-11-19: the Operation
   report is his "Operation PNL - Auto" sheet; G&A is admin, IT, legal and HQ).
   The salary journal's own wording decides the payroll lines; the Chart of
   Accounts' Logistics and Department columns decide the rest. Figures are made up. */

import { describe, expect, test } from 'vitest';
import {
  DEPARTMENT_ROWS, accountHome, departmentRowLabel, isDepartmentRow, isTransportRecharge, lineHome, opIncomeOf, opRowOf,
  payLineOf, payrollAccounts, regionNamed, type DeptAccount,
} from './department-rows';
import { salaryAccounts } from './logistics-pnl';

const acc = (account_code: string, account_name: string, extra: Partial<DeptAccount> = {}): DeptAccount =>
  ({ account_code, account_name, account_type: 'EXPENSE', is_active: true, logistics_row: null, department_row: null, ...extra });

describe('the salary journal: one line per team', () => {
  test('drivers and helpers are Logistics, as the Logistics P&L counts them', () => {
    expect(payLineOf("OPERATION DELIVERY SALARY - SEPT'26")).toEqual({ dept: 'logistics' });
    expect(payLineOf("OPERATION HELPER EPF - OCT'26")).toEqual({ dept: 'logistics' });
  });

  test("the warehouse teams are Operation's manpower rows", () => {
    expect(payLineOf("LOGISTIC (ADMIN) SALARY - SEPT'26")).toEqual({ dept: 'operation', row: 'manpower_logistic', region: null });
    expect(payLineOf("WAREHOUSE OPERATIONS EPF - OCT'26")).toEqual({ dept: 'operation', row: 'manpower_operation', region: null });
    expect(payLineOf("WAREHOUSE OPERATION SOCSO - OCT'26")).toEqual({ dept: 'operation', row: 'manpower_operation', region: null });
    expect(payLineOf("OPERATION STOREKEEPER SALARY - SEPT'26")).toEqual({ dept: 'operation', row: 'manpower_storekeeper', region: null });
    expect(payLineOf('PROCUREMENT SALARY - DEC 2026')).toEqual({ dept: 'operation', row: 'manpower_procurement', region: null });
  });

  test('a line naming its region is that region\'s; none or two names none (shared by the DOs\' value)', () => {
    expect(payLineOf("OPERATION STOREKEEPER PG SALARY - NOV'26")).toEqual({ dept: 'operation', row: 'manpower_storekeeper', region: 'PG' });
    expect(payLineOf("OPERATION STOREKEEPER - BALAKONG - NOV'26")).toMatchObject({ region: 'KL' });
    expect(payLineOf("OPERATION STOREKEEPER KCH SALARY - NOV'26")).toMatchObject({ region: 'EM' });
    expect(regionNamed('PENANG AND KL')).toBeNull();
    expect(regionNamed("SALARY - SEPT'26")).toBeNull();
  });

  test('the HQ teams are G&A, each by its team', () => {
    expect(payLineOf("DIRECTOR OFFICE - SALARY - SEP'26")).toEqual({ dept: 'ga', team: 'DIRECTOR OFFICE' });
    expect(payLineOf('FINANCE - EPF - OCT2026')).toEqual({ dept: 'ga', team: 'FINANCE' });
    expect(payLineOf("HR SALARY ADJUSTMENT - AUG'26")).toEqual({ dept: 'ga', team: 'HR' });
    expect(payLineOf("HR - SALARY - SEP'26")).toEqual({ dept: 'ga', team: 'HR' });
    expect(payLineOf("IT SALARY - OCT'26")).toEqual({ dept: 'ga', team: 'IT' });
    expect(payLineOf("MANAGEMENT SOCSO - SEPT'26")).toEqual({ dept: 'ga', team: 'MANAGEMENT' });
    expect(payLineOf("OTHERS EPF - SEPT'26")).toEqual({ dept: 'ga', team: 'OTHER' });
    expect(payLineOf("OTHER SALARY - OCT'26")).toEqual({ dept: 'ga', team: 'OTHER' });
  });

  test("a line naming no team is no team's: 2990's showroom staff, a director's own line", () => {
    expect(payLineOf("GROSS SALARY - SEP'26")).toBeNull();
    expect(payLineOf("EMPLOYER EPF - SEP'26")).toBeNull();
    expect(payLineOf("SALARY - SEP'26")).toBeNull();
    expect(payLineOf('ITEMISED CLAIM')).toBeNull();
    expect(payLineOf(null)).toBeNull();
  });
});

describe('recharges billed on Other Debtor bills', () => {
  test('OPERATION CHARGES and WAREHOUSE CHARGES are Operation income; transport recharges are Logistics', () => {
    expect(opIncomeOf("OPERATION CHARGES - SEP'26")).toBe('charges');
    expect(opIncomeOf("WAREHOUSE CHARGES - NOV'26")).toBe('warehouse');
    expect(opIncomeOf("LOGISTICS CHARGES - SEP'26")).toBeNull();
    expect(opIncomeOf('RENTAL FOR KELANA JAYA')).toBeNull();
    expect(isTransportRecharge("LOGISTICS CHARGES - SEP'26")).toBe(true);
    expect(isTransportRecharge("OPERATION CHARGES - SEP'26")).toBe(false);
  });
});

describe("the Chart of Accounts' Department column", () => {
  test('G&A, or one Operation row in one region — the values and how the picker names them', () => {
    expect(DEPARTMENT_ROWS).toHaveLength(25);
    expect(DEPARTMENT_ROWS[0]).toBe('ga');
    expect(isDepartmentRow('op_rental_pg')).toBe(true);
    expect(isDepartmentRow('op_rental_sg')).toBe(false);
    expect(isDepartmentRow('sales')).toBe(false);
    expect(opRowOf('op_utilities_em')).toEqual({ row: 'utilities', region: 'EM' });
    expect(opRowOf('ga')).toBeNull();
    expect(departmentRowLabel('ga')).toBe('G&A');
    expect(departmentRowLabel('op_rental_kl')).toBe('Operation – KL – Rental Warehouse');
    expect(departmentRowLabel('op_insurance_em')).toBe('Operation – SBH & SWK – Insurance Warehouse');
  });
});

describe('where an amount goes', () => {
  const rent = acc('900-R004', 'WAREHOUSE - (PENANG)', { department_row: 'op_rental_pg' });
  const office = acc('900-P001', 'PRINTING & STATIONERY', { department_row: 'ga' });
  const lorryPetrol = acc('900-P006', 'PETROL, TOL AND PARKING - LORI', { logistics_row: 'petrol', department_row: 'ga' });
  const hp = acc('450-H002', 'HP CREDITOR', { account_type: 'LIABILITY', logistics_row: 'instalment' });
  const staff = acc('900-S100', 'STAFF SALARIES & OVERTIME');
  const directorEpf = acc('900-D200', 'DIRECTOR EPF', { department_row: 'ga' });

  test("an account's own home: the Logistics column first, then the Department column", () => {
    expect(accountHome(rent)).toEqual({ dept: 'operation', row: 'rental', region: 'PG' });
    expect(accountHome(office)).toEqual({ dept: 'ga' });
    expect(accountHome(lorryPetrol)).toEqual({ dept: 'logistics' });
    expect(accountHome(hp)).toEqual({ dept: 'none' });
    expect(accountHome(staff)).toEqual({ dept: 'none' });
    expect(accountHome(undefined)).toEqual({ dept: 'none' });
  });

  test("a payroll line goes by its team, else where its account goes", () => {
    const pay = { payroll: true, recharge: false };
    expect(lineHome(staff, "FINANCE - SALARY - OCT2026", pay)).toEqual({ dept: 'ga', team: 'FINANCE' });
    expect(lineHome(staff, "OPERATION HELPER SALARY - OCT'26", pay)).toEqual({ dept: 'logistics' });
    expect(lineHome(staff, "OPERATION STOREKEEPER PG SALARY - NOV'26", pay)).toEqual({ dept: 'operation', row: 'manpower_storekeeper', region: 'PG', income: null });
    expect(lineHome(staff, "GROSS SALARY - SEP'26", pay)).toEqual({ dept: 'none' });
    expect(lineHome(directorEpf, "EPF - SEP'26", pay)).toEqual({ dept: 'ga', team: null });
    /* Not a payroll account: its words decide nothing. */
    expect(lineHome(office, 'FINANCE - PRINTER INK', { payroll: false, recharge: false })).toEqual({ dept: 'ga', team: null });
  });

  test('an income line goes by its recharge words', () => {
    const inc = acc('599-0000', 'ADDITIONAL INCOME', { account_type: 'INCOME' });
    const rc = { payroll: false, recharge: true };
    expect(lineHome(inc, "OPERATION CHARGES - SEP'26", rc)).toEqual({ dept: 'operation', row: null, region: null, income: 'charges' });
    expect(lineHome(inc, "LOGISTICS CHARGES - SEP'26", rc)).toEqual({ dept: 'logistics' });
    expect(lineHome(inc, 'SUNDRY INCOME', rc)).toEqual({ dept: 'none' });
    expect(lineHome(acc('590-0001', 'TRANSPORT INCOME (PNG)', { account_type: 'INCOME', logistics_row: 'income_pg' }), 'ANYTHING', rc)).toEqual({ dept: 'logistics' });
  });

  test("the payroll accounts are the Logistics P&L's own list", () => {
    const chart = [
      staff, directorEpf, acc('900-S200', "E'YER EPF"), acc('900-S011', 'S)- PART TIME WORKER / WAGES'), office, lorryPetrol,
      acc('900-D100', 'DIRECTOR REMUNERATION', { department_row: 'ga' }),
      acc('900-S500', 'STAFF ALLOWANCE', { logistics_row: 'other_lorry' }),
    ];
    const placed = new Set(chart.filter((a) => a.logistics_row).map((a) => a.account_code));
    expect([...payrollAccounts(chart)].sort()).toEqual(salaryAccounts(chart).filter((c) => !placed.has(c)));
    expect(payrollAccounts(chart).has('900-D100')).toBe(false);
  });
});
