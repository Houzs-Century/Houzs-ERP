/* HR · Payroll (redesign stage 7 template sample). The month's payslips over
 * the shared HrTablePage. Sample amounts; masked by default. */
import { fmtSen } from "../../vendor/shared/format";
import { hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Person, Tag, mask, type HrCol } from "./HrTablePage";
import { EMPLOYEES } from "./hrSampleData";

type PayRow = { id: number; name: string; empNo: string; basic: number; allow: number; trip: number; ot: number; deduct: number; net: number };

const ROWS: PayRow[] = EMPLOYEES.map((e) => {
  const basic = e.salarySen;
  const allow = e.position === "supervisor" ? 50000 : e.foreign ? 10000 : 30000;
  const trip = e.position === "driver" ? 45000 + (e.id % 3) * 10000 : 0;
  const ot = (e.id % 4) * 12000;
  const deduct = Math.round(basic * 0.11) + 1950 + (e.id % 5 === 0 ? 8000 : 0);
  return { id: e.id, name: e.name, empNo: e.empNo, basic, allow, trip, ot, deduct, net: basic + allow + trip + ot - deduct };
});

const sum = (f: (r: PayRow) => number) => ROWS.reduce((s, r) => s + f(r), 0);
const gross = sum((r) => r.basic + r.allow + r.trip + r.ot);
const deductions = sum((r) => r.deduct);
const net = sum((r) => r.net);

const moneyCell = (v: number, show: boolean, tone?: string) => <span className={"font-money " + (tone ?? "text-ink")}>{mask(fmtSen(v), show)}</span>;

const COLS: HrCol<PayRow>[] = [
  { key: "emp", label: "Employee", render: (r) => <Person name={r.name} sub={r.empNo} /> },
  { key: "basic", label: "Basic", align: "right", render: (r, s) => moneyCell(r.basic, s) },
  { key: "allow", label: "Allowances", align: "right", render: (r, s) => moneyCell(r.allow, s) },
  { key: "trip", label: "Trip Pay", align: "right", render: (r, s) => (r.trip ? moneyCell(r.trip, s) : <span className="text-ink-soft">—</span>) },
  { key: "ot", label: "Overtime", align: "right", render: (r, s) => (r.ot ? moneyCell(r.ot, s) : <span className="text-ink-soft">—</span>) },
  { key: "deduct", label: "Deductions", align: "right", render: (r, s) => moneyCell(r.deduct, s, "text-err") },
  { key: "net", label: "Net Pay", align: "right", render: (r, s) => <span className="font-money font-semibold text-ink">{mask(fmtSen(r.net), s)}</span> },
  { key: "status", label: "Status", render: () => <Tag tone="ok">Ready</Tag> },
];

export function PayrollPage() {
  return (
    <HrTablePage<PayRow>
      title="Payroll"
      subtitle="November 2026 run · pay date 30 Nov"
      actions={<><button type="button" className={hrSecondaryBtn}>Export</button><button type="button" className={hrSecondaryBtn}>Payslips</button><button type="button" className={hrPrimaryBtn}>Finalise payroll</button></>}
      stats={[
        { label: "Gross pay", value: (s) => <span className="font-money">{mask(fmtSen(gross), s)}</span>, sub: `${ROWS.length} employees`, bar: "bg-primary" },
        { label: "Deductions", value: (s) => <span className="font-money text-err">{mask(fmtSen(deductions), s)}</span>, sub: "EPF · SOCSO · EIS · penalty", bar: "bg-err" },
        { label: "Net pay", value: (s) => <span className="font-money">{mask(fmtSen(net), s)}</span>, sub: "Bank transfer", bar: "bg-synced" },
        { label: "Run status", value: () => "Draft", sub: <span className="text-warning-text">3 items need review</span>, bar: "bg-time" },
      ]}
      periods={["Nov 2026", "Oct 2026", "Sep 2026"]}
      rows={ROWS}
      columns={COLS}
      searchOf={(r) => `${r.name} ${r.empNo}`}
      searchPlaceholder="Search employee"
      footer={(s) => <>Net payable <span className="font-money font-semibold text-ink">{mask(fmtSen(net), s)}</span></>}
    />
  );
}
