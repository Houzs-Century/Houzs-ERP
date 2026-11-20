/* HR · the remaining sub-pages (redesign stage 7), each config over the shared
 * HrTablePage: Shifts, Punch Sites, Working Hours, Public Holidays, Pay Rules,
 * Trip Pay, Allowances, Advances, Penalty, Labor Cost, KPI. Sample data; money
 * masked by default. Shifts / Working Hours / KPI match their reference shots;
 * the rest follow the shared template. */
import { fmtSen } from "../../vendor/shared/format";
import { hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Person, Tag, Bar, TimeSpan, mask, type HrCol } from "./HrTablePage";
import { EMPLOYEES, POSITION, type Emp, type Position } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const M = (sen: number, show: boolean, tone?: string) => <span className={"font-money " + (tone ?? "text-ink")}>{mask(fmtSen(sen), show)}</span>;
const Pill = ({ pos }: { pos: Position }) => { const p = POSITION[pos]; return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", p.soft, p.text)}><span className={cx("h-1.5 w-1.5 rounded-full", p.dot)} />{p.label}</span>; };
const exp = <button type="button" className={hrSecondaryBtn}>Export</button>;
const prim = (t: string) => <button type="button" className={hrPrimaryBtn}>{t}</button>;

// ── Shifts ───────────────────────────────────────────────────────────────────
type Shift = { id: number; name: string; code: string; s: number; e: number; brk: number | null; days: string; assigned: number; status: "ACTIVE" | "DRAFT" };
const SHIFTS: Shift[] = [
  { id: 1, name: "Driver Day", code: "SH-DRV", s: 480, e: 1080, brk: 60, days: "Mon – Sat", assigned: 5, status: "ACTIVE" },
  { id: 2, name: "Warehouse Day", code: "SH-WHS", s: 510, e: 1050, brk: 60, days: "Mon – Sat", assigned: 12, status: "ACTIVE" },
  { id: 3, name: "Saturday Half", code: "SH-SAT", s: 510, e: 780, brk: null, days: "Sat", assigned: 0, status: "ACTIVE" },
  { id: 4, name: "Peak Season OT", code: "SH-PEAK", s: 480, e: 1260, brk: 90, days: "Mon – Sun", assigned: 0, status: "DRAFT" },
];
export function ShiftsPage() {
  return <HrTablePage<Shift> title="Shifts" subtitle="Working time templates assigned to employees" actions={<>{exp}{prim("+ New shift")}</>}
    stats={[
      { label: "Active shifts", value: () => 4, sub: "Day, half-day and peak season", bar: "bg-primary" },
      { label: "Assigned", value: () => <span>17 <span className="text-[13px] text-ink-muted">people</span></span>, sub: "All employees have a shift", bar: "bg-synced" },
      { label: "Grace period", value: () => <span>15 <span className="text-[13px] text-ink-muted">min</span></span>, sub: "Before late is counted", bar: "bg-time" },
      { label: "Avg day", value: () => <span>8.6 <span className="text-[13px] text-ink-muted">hrs</span></span>, sub: "Excluding breaks", bar: "bg-accent" },
    ]}
    rows={SHIFTS} searchOf={(r) => `${r.name} ${r.code}`} searchPlaceholder="Search shift"
    columns={[
      { key: "name", label: "Shift", render: (r) => <span className="font-semibold text-ink">{r.name}</span> },
      { key: "code", label: "Code", render: (r) => <span className="font-mono text-[11px] text-accent">{r.code}</span> },
      { key: "hrs", label: "Hours (06:00 – 22:00)", render: (r) => <div className="flex items-center gap-2"><TimeSpan startMin={r.s} endMin={r.e} tone="bg-accent" /><span className="shrink-0 font-mono text-[11px] text-ink-muted">{hhmm(r.s)}–{hhmm(r.e)}</span></div> },
      { key: "brk", label: "Break", align: "right", render: (r) => (r.brk ? `${r.brk} min` : <span className="text-ink-soft">—</span>) },
      { key: "days", label: "Days", render: (r) => r.days },
      { key: "assigned", label: "Assigned", align: "right", render: (r) => <span className="font-semibold text-ink">{r.assigned}</span> },
      { key: "status", label: "Status", render: (r) => <Tag tone={r.status === "ACTIVE" ? "ok" : "muted"}>{r.status === "ACTIVE" ? "Active" : "Draft"}</Tag> },
    ]}
    footer={() => <>total assigned <span className="font-semibold text-ink">17 people</span></>} />;
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ── Punch Sites ──────────────────────────────────────────────────────────────
type Site = { id: number; name: string; code: string; area: string; radius: number; punches: number; status: "ACTIVE" | "DRAFT" };
const SITES: Site[] = [
  { id: 1, name: "KL Warehouse", code: "PS-KL", area: "Kuala Lumpur", radius: 200, punches: 11, status: "ACTIVE" },
  { id: 2, name: "Shah Alam Hub", code: "PS-SA", area: "Selangor", radius: 150, punches: 3, status: "ACTIVE" },
  { id: 3, name: "Penang Depot", code: "PS-PG", area: "Penang", radius: 200, punches: 0, status: "ACTIVE" },
  { id: 4, name: "Johor Showroom", code: "PS-JB", area: "Johor", radius: 120, punches: 0, status: "DRAFT" },
  { id: 5, name: "Klang Store", code: "PS-KLG", area: "Selangor", radius: 150, punches: 0, status: "ACTIVE" },
];
export function PunchSitesPage() {
  return <HrTablePage<Site> title="Punch Sites" subtitle="Where a phone punch counts as on site" actions={<>{exp}{prim("+ New site")}</>}
    stats={[
      { label: "Sites", value: () => 5, sub: "3 active today", bar: "bg-primary" },
      { label: "Punches today", value: () => 14, sub: "across all sites", bar: "bg-synced" },
      { label: "In range", value: () => <span>13 <span className="text-[13px] text-ink-muted">· 93%</span></span>, sub: "of today's punches", bar: "bg-accent" },
      { label: "Off-site today", value: () => 1, sub: "HR notified", bar: "bg-err" },
    ]}
    rows={SITES} searchOf={(r) => `${r.name} ${r.code} ${r.area}`} searchPlaceholder="Search site"
    columns={[
      { key: "name", label: "Site", render: (r) => <span className="font-semibold text-ink">{r.name}</span> },
      { key: "code", label: "Code", render: (r) => <span className="font-mono text-[11px] text-accent">{r.code}</span> },
      { key: "area", label: "Area", render: (r) => r.area },
      { key: "radius", label: "Radius", align: "right", render: (r) => `${r.radius} m` },
      { key: "punches", label: "Punches today", align: "right", render: (r) => <span className="font-semibold text-ink">{r.punches}</span> },
      { key: "status", label: "Status", render: (r) => <Tag tone={r.status === "ACTIVE" ? "ok" : "muted"}>{r.status === "ACTIVE" ? "Active" : "Draft"}</Tag> },
    ]}
    footer={() => <><span className="font-semibold text-ink">5</span> sites</>} />;
}

// ── Working Hours ────────────────────────────────────────────────────────────
type WH = { id: number; e: Emp; days: number; regular: number; ot: number; late: number };
const WH_ROWS: WH[] = EMPLOYEES.map((e) => { const days = 14 + (e.id % 3); const regular = 110 + (e.id * 7) % 40; const ot = 5 + (e.id * 3) % 22; const late = (e.id * 13) % 60; return { id: e.id, e, days, regular, ot, late }; });
const WH_MAXOT = Math.max(...WH_ROWS.map((r) => r.ot));
export function WorkingHoursPage() {
  const totReg = WH_ROWS.reduce((s, r) => s + r.regular, 0), totOt = WH_ROWS.reduce((s, r) => s + r.ot, 0), totLate = WH_ROWS.reduce((s, r) => s + r.late, 0);
  return <HrTablePage<WH> title="Working Hours" subtitle="Hours worked per employee · November 2026" actions={<>{exp}{prim("Recalculate")}</>}
    periods={["This month", "Last month", "Custom"]}
    stats={[
      { label: "Regular hours", value: () => <span>{totReg.toLocaleString()} <span className="text-[13px] text-ink-muted">hrs</span></span>, sub: "1 – 20 Nov", bar: "bg-primary" },
      { label: "Overtime", value: () => <span>{totOt} <span className="text-[13px] text-ink-muted">hrs</span></span>, sub: "Drivers account for most", bar: "bg-accent" },
      { label: "Late minutes", value: () => <span>{totLate} <span className="text-[13px] text-ink-muted">min</span></span>, sub: "Deducted per pay rules", bar: "bg-time" },
      { label: "Avg per day", value: () => <span>8.4 <span className="text-[13px] text-ink-muted">hrs</span></span>, sub: "Per employee", bar: "bg-synced" },
    ]}
    rows={WH_ROWS} searchOf={(r) => `${r.e.name} ${r.e.empNo}`} searchPlaceholder="Search employee"
    columns={[
      { key: "emp", label: "Employee", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "pos", label: "Position", render: (r) => <Pill pos={r.e.position} /> },
      { key: "days", label: "Days", align: "right", render: (r) => r.days },
      { key: "reg", label: "Regular", align: "right", render: (r) => <span className="font-semibold text-ink">{r.regular} h</span> },
      { key: "ot", label: "Overtime", render: (r) => <span className="flex items-center gap-2"><Bar pct={(r.ot / WH_MAXOT) * 100} tone="bg-accent" w="w-16" /><span className="text-ink-secondary">{r.ot} h</span></span> },
      { key: "late", label: "Late", align: "right", render: (r) => <span className="text-time">{r.late} m</span> },
      { key: "total", label: "Total", align: "right", render: (r) => <span className="font-semibold text-ink">{r.regular + r.ot} h</span> },
    ]}
    footer={() => <>total hours <span className="font-semibold text-ink">{(totReg + totOt).toLocaleString()} h</span></>} />;
}

// ── Public Holidays ──────────────────────────────────────────────────────────
type Hol = { id: number; date: string; name: string; type: "National" | "State"; day: string; status: "PAST" | "UPCOMING" };
const HOLS: Hol[] = [
  { id: 1, date: "15 Nov 2026", name: "Deepavali", type: "National", day: "Sun", status: "PAST" },
  { id: 2, date: "11 Dec 2026", name: "Sultan of Selangor's Birthday", type: "State", day: "Fri", status: "UPCOMING" },
  { id: 3, date: "25 Dec 2026", name: "Christmas Day", type: "National", day: "Fri", status: "UPCOMING" },
  { id: 4, date: "01 Jan 2027", name: "New Year's Day", type: "National", day: "Fri", status: "UPCOMING" },
  { id: 5, date: "29 Jan 2027", name: "Chinese New Year", type: "National", day: "Fri", status: "UPCOMING" },
];
export function PublicHolidaysPage() {
  return <HrTablePage<Hol> title="Public Holidays" subtitle="Days nobody is docked for not working" actions={<>{exp}{prim("+ Add holiday")}</>}
    stats={[
      { label: "Holidays 2026", value: () => 15, sub: "National and Selangor", bar: "bg-primary" },
      { label: "Next holiday", value: () => "11 Dec", sub: "Sultan's Birthday", bar: "bg-accent" },
      { label: "Worked on holiday", value: () => 2, sub: "this year · paid 3×", bar: "bg-time" },
      { label: "Upcoming", value: () => 4, sub: "in the next 90 days", bar: "bg-learning" },
    ]}
    rows={HOLS} searchOf={(r) => `${r.name} ${r.date}`} searchPlaceholder="Search holiday"
    columns={[
      { key: "date", label: "Date", render: (r) => <span className="font-semibold text-ink">{r.date}</span> },
      { key: "name", label: "Name", render: (r) => r.name },
      { key: "type", label: "Type", render: (r) => <Tag tone={r.type === "National" ? "info" : "muted"}>{r.type}</Tag> },
      { key: "day", label: "Day", render: (r) => r.day },
      { key: "status", label: "Status", render: (r) => <Tag tone={r.status === "PAST" ? "muted" : "ok"}>{r.status === "PAST" ? "Past" : "Upcoming"}</Tag> },
    ]}
    footer={() => <><span className="font-semibold text-ink">15</span> holidays</>} />;
}

// ── Pay Rules ────────────────────────────────────────────────────────────────
type Rule = { id: number; name: string; code: string; value: string; from: string };
const RULES: Rule[] = [
  { id: 1, name: "Weekday overtime", code: "RULE-OT1", value: "1.5× hourly", from: "01 Jan 2026" },
  { id: 2, name: "Rest-day overtime", code: "RULE-OT2", value: "2.0× hourly", from: "01 Jan 2026" },
  { id: 3, name: "Public-holiday OT", code: "RULE-OT3", value: "3.0× hourly", from: "01 Jan 2026" },
  { id: 4, name: "Lateness", code: "RULE-LATE", value: "Deduct per min after 15 min grace", from: "01 Jan 2026" },
  { id: 5, name: "EPF", code: "RULE-EPF", value: "11% employee · 13% employer", from: "01 Jan 2026" },
  { id: 6, name: "SOCSO", code: "RULE-SOCSO", value: "Per PERKESO table", from: "01 Jan 2026" },
  { id: 7, name: "Shift", code: "RULE-SHIFT", value: "08:00 – 18:00", from: "12 Nov 2026" },
];
export function PayRulesPage() {
  return <HrTablePage<Rule> title="Pay Rules" subtitle="Shift, lateness, overtime and statutory rates" actions={<>{exp}{prim("+ New rule")}</>}
    stats={[
      { label: "Active rules", value: () => 7, sub: "scheduled by date", bar: "bg-primary" },
      { label: "OT rates", value: () => "1.5 / 2 / 3×", sub: "weekday / rest / holiday", bar: "bg-accent" },
      { label: "Grace period", value: () => <span>15 <span className="text-[13px] text-ink-muted">min</span></span>, sub: "before late counts", bar: "bg-time" },
      { label: "Last changed", value: () => "12 Nov", sub: "Shift rule", bar: "bg-learning" },
    ]}
    rows={RULES} searchOf={(r) => `${r.name} ${r.code}`} searchPlaceholder="Search rule"
    columns={[
      { key: "name", label: "Rule", render: (r) => <span className="font-semibold text-ink">{r.name}</span> },
      { key: "code", label: "Code", render: (r) => <span className="font-mono text-[11px] text-accent">{r.code}</span> },
      { key: "value", label: "Value", render: (r) => <span className="text-ink-secondary">{r.value}</span> },
      { key: "from", label: "Effective from", render: (r) => r.from },
      { key: "status", label: "Status", render: () => <Tag tone="ok">Active</Tag> },
    ]}
    footer={() => <><span className="font-semibold text-ink">7</span> active rules</>} />;
}

// ── Trip Pay ─────────────────────────────────────────────────────────────────
type Trip = { id: number; e: Emp; trips: number; commission: number; allowance: number };
const TRIPS: Trip[] = EMPLOYEES.filter((e) => e.position === "driver").map((e) => ({ id: e.id, e, trips: 20 + (e.id * 7) % 25, commission: 80000 + (e.id * 9000) % 60000, allowance: 20000 + (e.id * 5000) % 40000 }));
export function TripPayPage() {
  const totCom = TRIPS.reduce((s, r) => s + r.commission, 0), totAll = TRIPS.reduce((s, r) => s + r.allowance, 0), totTrips = TRIPS.reduce((s, r) => s + r.trips, 0);
  return <HrTablePage<Trip> title="Trip Pay" subtitle="Driver commission and trip allowances · 23 Oct – 22 Nov" actions={<>{exp}{prim("Import trip report")}</>}
    stats={[
      { label: "Drivers", value: () => TRIPS.length, sub: "with trips this month", bar: "bg-primary" },
      { label: "Trips", value: () => totTrips, sub: "this trip month", bar: "bg-synced" },
      { label: "Commission", value: (s) => M(totCom, s), sub: "by job type", bar: "bg-accent" },
      { label: "Allowances", value: (s) => M(totAll, s), sub: "overnight · from punches", bar: "bg-learning" },
    ]}
    rows={TRIPS} searchOf={(r) => `${r.e.name} ${r.e.empNo}`} searchPlaceholder="Search driver"
    columns={[
      { key: "emp", label: "Driver", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "trips", label: "Trips", align: "right", render: (r) => <span className="font-semibold text-ink">{r.trips}</span> },
      { key: "com", label: "Commission", align: "right", render: (r, s) => M(r.commission, s) },
      { key: "all", label: "Allowance", align: "right", render: (r, s) => M(r.allowance, s) },
      { key: "total", label: "Total", align: "right", render: (r, s) => <span className="font-money font-semibold text-ink">{mask(fmtSen(r.commission + r.allowance), s)}</span> },
    ]}
    footer={(s) => <>total <span className="font-money font-semibold text-ink">{mask(fmtSen(totCom + totAll), s)}</span></>} />;
}

// ── Allowances ───────────────────────────────────────────────────────────────
type Allow = { id: number; e: Emp; kind: "Leadership" | "Transport" | "KPI"; amount: number; month: string; status: "PAID" | "PENDING" };
const ALLOWS: Allow[] = [
  { id: 1, e: EMPLOYEES[16], kind: "Leadership", amount: 50000, month: "Nov 2026", status: "PAID" },
  { id: 2, e: EMPLOYEES[10], kind: "Transport", amount: 30000, month: "Nov 2026", status: "PAID" },
  { id: 3, e: EMPLOYEES[0], kind: "KPI", amount: 80000, month: "Nov 2026", status: "PENDING" },
  { id: 4, e: EMPLOYEES[5], kind: "Transport", amount: 30000, month: "Nov 2026", status: "PAID" },
  { id: 5, e: EMPLOYEES[3], kind: "KPI", amount: 50000, month: "Nov 2026", status: "PENDING" },
];
export function AllowancesPage() {
  const tot = ALLOWS.reduce((s, r) => s + r.amount, 0);
  return <HrTablePage<Allow> title="Allowances" subtitle="Leadership, transport and KPI allowances" actions={<>{exp}{prim("+ Add allowance")}</>}
    stats={[
      { label: "Total allowances", value: (s) => M(tot, s), sub: `${ALLOWS.length} this month`, bar: "bg-primary" },
      { label: "Leadership", value: (s) => M(50000, s), sub: "1 person", bar: "bg-accent" },
      { label: "Transport", value: (s) => M(60000, s), sub: "2 people", bar: "bg-synced" },
      { label: "KPI", value: (s) => M(130000, s), sub: "2 pending", bar: "bg-time" },
    ]}
    rows={ALLOWS} searchOf={(r) => `${r.e.name} ${r.kind}`} searchPlaceholder="Search employee"
    columns={[
      { key: "emp", label: "Employee", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "kind", label: "Kind", render: (r) => <Tag tone={r.kind === "Leadership" ? "info" : r.kind === "KPI" ? "warn" : "muted"}>{r.kind}</Tag> },
      { key: "amt", label: "Amount", align: "right", render: (r, s) => M(r.amount, s) },
      { key: "month", label: "Month", render: (r) => r.month },
      { key: "status", label: "Status", render: (r) => <Tag tone={r.status === "PAID" ? "ok" : "warn"}>{r.status === "PAID" ? "Paid" : "Pending"}</Tag> },
    ]}
    footer={(s) => <>total <span className="font-money font-semibold text-ink">{mask(fmtSen(tot), s)}</span></>} />;
}

// ── Advances ─────────────────────────────────────────────────────────────────
type Adv = { id: number; e: Emp; date: string; amount: number; note: string; status: "UNSETTLED" | "SETTLED" };
const ADVS: Adv[] = [
  { id: 1, e: EMPLOYEES[10], date: "18 Nov 2026", amount: 40000, note: "Family emergency", status: "UNSETTLED" },
  { id: 2, e: EMPLOYEES[7], date: "05 Nov 2026", amount: 30000, note: "Advance request", status: "SETTLED" },
  { id: 3, e: EMPLOYEES[11], date: "02 Nov 2026", amount: 20000, note: "—", status: "SETTLED" },
];
export function AdvancesPage() {
  const outstanding = ADVS.filter((r) => r.status === "UNSETTLED").reduce((s, r) => s + r.amount, 0);
  return <HrTablePage<Adv> title="Advances" subtitle="Cash given ahead of payday, taken back in full" actions={<>{exp}{prim("Record advance")}</>}
    stats={[
      { label: "Outstanding", value: (s) => M(outstanding, s), sub: "to deduct this month", bar: "bg-time" },
      { label: "Requests", value: () => 1, sub: "pending approval", bar: "bg-primary" },
      { label: "This month", value: () => 3, sub: "advances given", bar: "bg-synced" },
      { label: "Settled", value: () => 2, sub: "fully recovered", bar: "bg-learning" },
    ]}
    rows={ADVS} searchOf={(r) => `${r.e.name} ${r.note}`} searchPlaceholder="Search employee"
    columns={[
      { key: "emp", label: "Employee", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "date", label: "Date", render: (r) => r.date },
      { key: "amt", label: "Amount", align: "right", render: (r, s) => M(r.amount, s) },
      { key: "note", label: "Note", render: (r) => <span className="text-ink-secondary">{r.note}</span> },
      { key: "status", label: "Status", render: (r) => <Tag tone={r.status === "SETTLED" ? "ok" : "warn"}>{r.status === "SETTLED" ? "Settled" : "To deduct"}</Tag> },
    ]}
    footer={(s) => <>outstanding <span className="font-money font-semibold text-ink">{mask(fmtSen(outstanding), s)}</span></>} />;
}

// ── Penalty ──────────────────────────────────────────────────────────────────
type Pen = { id: number; e: Emp; incident: string; amount: number; by: string; status: "APPLIED" | "DISPUTED" | "PENDING" };
const PENS: Pen[] = [
  { id: 1, e: EMPLOYEES[10], incident: "Damaged sofa leg during delivery", amount: 5000, by: "Hana", status: "DISPUTED" },
  { id: 2, e: EMPLOYEES[7], incident: "Repeated lateness", amount: 3000, by: "Nico", status: "APPLIED" },
];
export function PenaltyPage() {
  const tot = PENS.reduce((s, r) => s + r.amount, 0);
  return <HrTablePage<Pen> title="Penalty" subtitle="Deductions for incidents, approved by someone other than who raised it" actions={<>{exp}{prim("+ New penalty")}</>}
    stats={[
      { label: "This month", value: () => 2, sub: "penalties raised", bar: "bg-primary" },
      { label: "Pending", value: () => 0, sub: "awaiting approval", bar: "bg-time" },
      { label: "Disputed", value: () => 1, sub: "needs review", bar: "bg-err" },
      { label: "Total", value: (s) => M(tot, s), sub: "to deduct", bar: "bg-accent" },
    ]}
    rows={PENS} searchOf={(r) => `${r.e.name} ${r.incident}`} searchPlaceholder="Search employee"
    columns={[
      { key: "emp", label: "Employee", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "inc", label: "Incident", render: (r) => <span className="text-ink-secondary">{r.incident}</span> },
      { key: "amt", label: "Amount", align: "right", render: (r, s) => M(r.amount, s, "text-err") },
      { key: "by", label: "Approved by", render: (r) => r.by },
      { key: "status", label: "Status", render: (r) => <Tag tone={r.status === "DISPUTED" ? "bad" : r.status === "PENDING" ? "warn" : "ok"}>{r.status === "DISPUTED" ? "Disputed" : r.status === "PENDING" ? "Pending" : "Applied"}</Tag> },
    ]}
    footer={(s) => <>total <span className="font-money font-semibold text-ink">{mask(fmtSen(tot), s)}</span></>} />;
}

// ── Labor Cost ───────────────────────────────────────────────────────────────
type LC = { id: number; e: Emp; hours: number; cost: number; dock: number };
const LCS: LC[] = EMPLOYEES.map((e) => { const hours = 120 + (e.id * 7) % 40; const cost = Math.round(e.salarySen * (hours / 160)); const dock = (e.id % 4 === 0) ? Math.round(e.salarySen * 0.02) : 0; return { id: e.id, e, hours, cost, dock }; });
export function LaborCostPage() {
  const tot = LCS.reduce((s, r) => s + r.cost, 0), totDock = LCS.reduce((s, r) => s + r.dock, 0);
  return <HrTablePage<LC> title="Labor Cost" subtitle="A month's logged hours priced the way payroll prices them · November 2026" actions={<>{exp}{prim("Settle month")}</>}
    stats={[
      { label: "Total cost", value: (s) => M(tot, s), sub: "17 employees", bar: "bg-primary" },
      { label: "Hours logged", value: () => LCS.reduce((s, r) => s + r.hours, 0).toLocaleString(), sub: "this month", bar: "bg-synced" },
      { label: "Short-hour docks", value: (s) => M(totDock, s), sub: "deducted", bar: "bg-time" },
      { label: "Status", value: () => "Open", sub: "not settled", bar: "bg-accent" },
    ]}
    rows={LCS} searchOf={(r) => `${r.e.name} ${r.e.empNo}`} searchPlaceholder="Search employee"
    columns={[
      { key: "emp", label: "Employee", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "dept", label: "Department", render: () => "Operation Department" },
      { key: "hours", label: "Hours", align: "right", render: (r) => <span className="font-semibold text-ink">{r.hours} h</span> },
      { key: "cost", label: "Cost", align: "right", render: (r, s) => M(r.cost, s) },
      { key: "dock", label: "Short-hour dock", align: "right", render: (r, s) => (r.dock ? M(r.dock, s, "text-err") : <span className="text-ink-soft">—</span>) },
    ]}
    footer={(s) => <>total cost <span className="font-money font-semibold text-ink">{mask(fmtSen(tot), s)}</span></>} />;
}

// ── KPI ──────────────────────────────────────────────────────────────────────
type Kpi = { id: number; e: Emp; att: number; punc: number; out: number; score: number; grade: "A" | "B" | "C" };
const KPIS: Kpi[] = EMPLOYEES.map((e) => { const att = 76 + (e.id * 7) % 24; const punc = 78 + (e.id * 11) % 22; const out = 72 + (e.id * 13) % 28; const score = Math.round((att + punc + out) / 3); const grade = score >= 90 ? "A" : score >= 70 ? "B" : "C"; return { id: e.id, e, att, punc, out, score, grade }; });
export function KpiPage() {
  const avg = Math.round(KPIS.reduce((s, r) => s + r.score, 0) / KPIS.length);
  return <HrTablePage<Kpi> title="KPI" subtitle="Monthly scorecard · November 2026 (to date)" actions={<>{exp}{prim("Edit KPI weights")}</>}
    periods={["This month", "Quarter"]}
    stats={[
      { label: "Average score", value: () => <span>{avg} <span className="text-[13px] text-ink-muted">/ 100</span></span>, sub: "17 employees", bar: "bg-primary" },
      { label: "Grade A", value: () => KPIS.filter((r) => r.grade === "A").length, sub: "Score 90+", bar: "bg-synced" },
      { label: "Needs attention", value: () => KPIS.filter((r) => r.score < 70).length, sub: "Score below 70", bar: "bg-err" },
      { label: "Punctuality", value: () => <span>88 <span className="text-[13px] text-ink-muted">%</span></span>, sub: "team average", bar: "bg-accent" },
    ]}
    rows={KPIS} searchOf={(r) => `${r.e.name} ${r.e.empNo}`} searchPlaceholder="Search employee"
    columns={[
      { key: "emp", label: "Employee", render: (r) => <Person name={r.e.name} sub={r.e.empNo} /> },
      { key: "pos", label: "Position", render: (r) => <Pill pos={r.e.position} /> },
      { key: "att", label: "Attendance", render: (r) => <ScoreBar pct={r.att} tone="bg-synced" /> },
      { key: "punc", label: "Punctuality", render: (r) => <ScoreBar pct={r.punc} tone="bg-accent" /> },
      { key: "out", label: "Output", render: (r) => <ScoreBar pct={r.out} tone="bg-learning" /> },
      { key: "score", label: "Score", render: (r) => <span className="flex items-center gap-2"><Bar pct={r.score} tone="bg-primary" w="w-16" /><span className="font-semibold text-ink">{r.score}</span></span> },
      { key: "grade", label: "Grade", render: (r) => <Tag tone={r.grade === "A" ? "ok" : r.grade === "B" ? "info" : "bad"}>{r.grade}</Tag> },
    ]}
    footer={() => <>team average <span className="font-semibold text-ink">{avg} / 100</span></>} />;
}
function ScoreBar({ pct, tone }: { pct: number; tone: string }) {
  return <span className="flex items-center gap-2"><Bar pct={pct} tone={tone} w="w-16" /><span className="text-ink-secondary">{pct}%</span></span>;
}
