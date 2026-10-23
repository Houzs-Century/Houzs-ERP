/* One payslip from one employee's month (HC-0125 phase 4), pure: the
 * pipeline of Hookka's POST /api/payslips for a single worker, minus the
 * production pieces (efficiency allowance). Tested without a database.
 * Phase 5 adds the trip month's commission and trip allowances, the monthly
 * allowances and the backpay deduction. */
import { computeMonthlyPay, effectiveSalaryForMonth, statutoryFor, type MonthlyPay } from "../../scm/shared/hr-payroll";
import { resolvePcb, type PcbCategory, type PcbStatus } from "../../scm/shared/hr-pcb";
import type { PayRulesConfig } from "../../scm/shared/hr-pay-rules";
import type { TripPay } from "../../scm/shared/hr-trip-pay";

export const ALLOWANCE_KINDS = ["LEADERSHIP", "TRANSPORT", "OVERNIGHT", "KPI", "OTHER", "BACKPAY"] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];
export const ALLOWANCE_LABEL: Record<AllowanceKind, string> = {
  LEADERSHIP: "Leadership allowance",
  TRANSPORT: "Transport allowance",
  OVERNIGHT: "Overnight allowance",
  KPI: "KPI allowance",
  OTHER: "Allowance",
  BACKPAY: "Backpay (company advance)",
};
export type AllowanceLine = { kind: AllowanceKind; label: string; amountSen: number; note: string | null };

export type PayslipEmployee = {
  id: number;
  empNo: string;
  name: string;
  departmentName: string | null;
  payMode: "MONTHLY" | "DAILY";
  basicSalarySen: number;
  dailyRateSen: number;
  workingDaysPerMonth: number;
  workingHoursPerDay: number;
  otMultiplier: number;
  resignedOn: string;
  joinDate: string;
  paymentMethod: "TRANSFER" | "CASH";
  bankName: string;
  bankAccount: string;
  epf: boolean;
  socso: boolean;
  eis: boolean;
  pcb: boolean;
  taxResidency: "RESIDENT" | "NON_RESIDENT" | null;
  taxCategory: PcbCategory | null;
  taxChildReliefSen: number | null;
};

export type PayslipFigures = {
  employeeId: number;
  empNo: string;
  employeeName: string;
  departmentName: string | null;
  payMode: "MONTHLY" | "DAILY";
  pay: MonthlyPay;
  /** The monthly allowances (not backpay). */
  allowancesSen: number;
  allowanceLines: AllowanceLine[];
  commissionSen: number;
  tripAllowanceSen: number;
  trip: TripPay | null;
  backpaySen: number;
  grossSen: number;
  statutory: ReturnType<typeof statutoryFor>;
  pcbSen: number;
  pcbStatus: PcbStatus;
  pcbNote: string;
  statutoryEmployeeSen: number;
  advanceSen: number;
  advanceDates: string[];
  penaltySen: number;
  netSen: number;
  paymentMethod: "TRANSFER" | "CASH";
  bankName: string | null;
  bankAccount: string | null;
};

/** Who is on a month's payroll: active, or resigned on or after its first day; joined by its last day. */
export function onPayroll(e: Pick<PayslipEmployee, "joinDate" | "resignedOn">, status: string, period: string): boolean {
  const first = `${period}-01`;
  const [y, m] = period.split("-").map(Number);
  const last = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  if (e.joinDate && e.joinDate > last) return false;
  if (status === "ACTIVE") return true;
  return status === "RESIGNED" && e.resignedOn !== "" && e.resignedOn >= first;
}

export function buildPayslip(input: {
  employee: PayslipEmployee;
  period: string;
  salaryHistory: ReadonlyArray<{ effectiveFrom: string; basicSalarySen: number }>;
  days: ReadonlyArray<{ date: string; hours: number }>;
  holidays: ReadonlySet<string>;
  absenceThroughDay: number;
  shortHours: number;
  rulesOn: (ymd: string) => PayRulesConfig;
  advances: ReadonlyArray<{ date: string; amountSen: number }>;
  penaltySen: number;
  paidLeave?: ReadonlySet<string>;
  /** The trip month of the same name (23rd to 22nd), or null. */
  trip?: TripPay | null;
  /** Monthly allowance lines in force this month; BACKPAY is a deduction. */
  allowances?: ReadonlyArray<{ kind: AllowanceKind; amountSen: number; note: string | null }>;
  /** Earlier months of the same year, for PCB: normal remuneration, employee EPF, PCB withheld. */
  ytd: { remunerationSen: number; epfSen: number; pcbSen: number };
}): PayslipFigures {
  const { employee: e, period } = input;
  const [year, month] = period.split("-").map(Number);
  const monthly = e.payMode !== "DAILY";
  const salarySen = monthly ? effectiveSalaryForMonth(input.salaryHistory, e.basicSalarySen, year, month, input.holidays) : 0;
  const pay = computeMonthlyPay({
    employee: { payMode: e.payMode, salarySen, dailyRateSen: e.dailyRateSen, workingDaysPerMonth: e.workingDaysPerMonth, workingHoursPerDay: e.workingHoursPerDay, otMultiplier: e.otMultiplier, resignedOn: e.resignedOn },
    year,
    month,
    days: input.days,
    holidays: input.holidays,
    absenceThroughDay: input.absenceThroughDay,
    shortHours: input.shortHours,
    rulesOn: input.rulesOn,
    paidLeave: input.paidLeave,
  });
  const trip = input.trip ?? null;
  const commissionSen = trip?.commission.amountSen ?? 0;
  const tripAllowanceSen = trip?.allowanceSen ?? 0;
  const allowanceLines: AllowanceLine[] = (input.allowances ?? []).map((a) => ({ kind: a.kind, label: ALLOWANCE_LABEL[a.kind], amountSen: a.amountSen, note: a.note }));
  const allowancesSen = allowanceLines.filter((a) => a.kind !== "BACKPAY").reduce((s, a) => s + a.amountSen, 0);
  const backpaySen = allowanceLines.filter((a) => a.kind === "BACKPAY").reduce((s, a) => s + a.amountSen, 0);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cfgEnd = input.rulesOn(`${period}-${String(lastDay).padStart(2, "0")}`);
  const statutory = statutoryFor(salarySen + commissionSen, { epf: e.epf, socso: e.socso, eis: e.eis }, cfgEnd);
  const pcb = resolvePcb({
    pcbEnabled: e.pcb,
    year,
    monthIndex: month,
    residency: e.taxResidency,
    category: e.taxCategory,
    childReliefSen: e.taxChildReliefSen,
    /* Allowances stay out of PCB as in Hookka (and the YTD sum); commission is pay. */
    currentRemunerationSen: pay.grossSen + commissionSen,
    currentEpfSen: statutory.epfEmployeeSen,
    ytdRemunerationSen: input.ytd.remunerationSen,
    ytdEpfSen: input.ytd.epfSen,
    ytdPcbSen: input.ytd.pcbSen,
  });
  const grossSen = pay.grossSen + commissionSen + tripAllowanceSen + allowancesSen;
  const statutoryEmployeeSen = statutory.epfEmployeeSen + statutory.socsoEmployeeSen + statutory.eisEmployeeSen + pcb.pcbSen;
  const advanceSen = input.advances.reduce((s, a) => s + a.amountSen, 0);
  const cash = e.paymentMethod === "CASH";
  return {
    employeeId: e.id,
    empNo: e.empNo,
    employeeName: e.name,
    departmentName: e.departmentName,
    payMode: e.payMode,
    pay,
    allowancesSen,
    allowanceLines,
    commissionSen,
    tripAllowanceSen,
    trip,
    backpaySen,
    grossSen,
    statutory,
    pcbSen: pcb.pcbSen,
    pcbStatus: pcb.status,
    pcbNote: pcb.note,
    statutoryEmployeeSen,
    advanceSen,
    advanceDates: input.advances.map((a) => a.date).sort(),
    penaltySen: input.penaltySen,
    /* Not clamped, as in Hookka: a negative net shows in red and HR decides. */
    netSen: grossSen - statutoryEmployeeSen - advanceSen - backpaySen - input.penaltySen,
    paymentMethod: e.paymentMethod,
    bankName: cash ? null : e.bankName || null,
    bankAccount: cash ? null : e.bankAccount || null,
  };
}

/** The payroll month a penalty approved on `approvedYmd` lands in: its own month, rolled past any month already approved. */
export function penaltyPeriod(approvedYmd: string, lockedPeriods: ReadonlySet<string>): string {
  let [y, m] = approvedYmd.slice(0, 7).split("-").map(Number);
  for (let i = 0; i < 24; i++) {
    const p = `${y}-${String(m).padStart(2, "0")}`;
    if (!lockedPeriods.has(p)) return p;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}
