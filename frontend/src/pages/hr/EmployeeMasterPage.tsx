/* HR · Employees & Attendance — Employee Master (redesign look, real data).
 * Six stat cards (four are click-to-filter), a toolbar (search, group/flat,
 * show-salary), and three layouts: A table (grouped by position), B by-position
 * columns, D today board. The roster is the real employee master; today's punch
 * is joined from the attendance read. Add / edit / import reuse the existing
 * working EmployeeDrawer and bulk modals (HrEmployees owns them). Salary masked
 * by default. */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { avatarColor, initials } from "./hrAvatar";
import { dayByEmployee, punchOf, type PunchState } from "./attendanceToday";
import { useAttendance, useEmployees, type Employee } from "./hrApi";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
type Layout = "A" | "B" | "D";
type Filter = null | "punched" | "late" | "notlinked" | "foreign";

// A view row joins an employee to today's punch and the figure the page shows.
type Row = { e: Employee; punch: PunchState; time: string | null; lateMin: number; salarySen: number; linked: boolean; position: string };

// Position accent: the real position is free text, so colour it deterministically
// from a semantic-token palette rather than three fixed buckets.
const POS_PALETTE = [
  { dot: "bg-learning", soft: "bg-learning-soft", text: "text-learning", bar: "bg-learning" },
  { dot: "bg-accent", soft: "bg-accent-soft", text: "text-accent", bar: "bg-accent" },
  { dot: "bg-primary", soft: "bg-primary-soft", text: "text-primary", bar: "bg-primary" },
  { dot: "bg-time", soft: "bg-warning-bg", text: "text-time", bar: "bg-time" },
  { dot: "bg-synced", soft: "bg-synced-bg", text: "text-synced", bar: "bg-synced" },
];
function posStyle(pos: string) {
  let h = 0;
  for (let i = 0; i < pos.length; i++) h = (h * 31 + pos.charCodeAt(i)) >>> 0;
  return POS_PALETTE[h % POS_PALETTE.length];
}
const posLabel = (p: string) => p || "No position";

function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", avatarColor(name))} style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials(name)}
    </span>
  );
}
const PUNCH_DOT: Record<PunchState, string> = { on: "bg-synced", late: "bg-time", out: "bg-err", leave: "bg-ink-muted" };
function PositionPill({ pos }: { pos: string }) {
  const p = posStyle(pos);
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", p.soft, p.text)}><span className={cx("h-1.5 w-1.5 rounded-full", p.dot)} />{posLabel(pos)}</span>;
}
function Today({ r, ready }: { r: Row; ready: boolean }) {
  if (!ready) return <span className="text-[12px] text-ink-muted">—</span>;
  if (r.punch === "leave") return <span className="flex items-center gap-1.5 text-[12px] text-ink-muted"><span className="h-2 w-2 rounded-full bg-ink-muted" />On leave</span>;
  if (r.punch === "out") return <span className="flex items-center gap-1.5 text-[12px]"><span className="h-2 w-2 rounded-full bg-err" /><span className="font-semibold text-err">Not in</span></span>;
  return (
    <span className="flex items-center gap-1.5 text-[12px]">
      <span className={cx("h-2 w-2 rounded-full", PUNCH_DOT[r.punch])} />
      <span className="font-mono font-semibold text-ink">{r.time ?? "In"}</span>
      <span className="text-ink-muted">In</span>
      {r.lateMin > 0 && <span className="font-semibold text-time">{r.lateMin} min late</span>}
    </span>
  );
}
function StatusBadge({ s }: { s: Employee["status"] }) {
  if (s === "ACTIVE") return <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-synced">Active</span>;
  const label = s === "RESIGNED" ? "Resigned" : "Inactive";
  return <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted">{label}</span>;
}
function Erp({ r }: { r: Row }) {
  return r.linked
    ? <span className="flex items-center gap-1.5 text-[12px] text-ink-muted"><span className="text-synced">✓</span><span className="truncate">{r.e.userName ?? r.e.userEmail}</span></span>
    : <span className="inline-flex items-center gap-1 rounded bg-warning-bg px-1.5 py-0.5 text-[11px] font-semibold text-warning-text">⚠ Not linked</span>;
}

function StatCard({ label, value, sub, bar, active, onClick }: { label: string; value: ReactNode; sub: string; bar: string; active?: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} className={cx("flex min-w-0 flex-col overflow-hidden rounded-xl border bg-surface text-left", active ? "border-primary ring-1 ring-primary" : "border-border", onClick && "hover:border-primary/50")}>
      <div className={cx("h-[3px] w-full", bar)} />
      <div className="px-3.5 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
        <div className="mt-1 text-[22px] font-bold leading-none text-ink">{value}</div>
        <div className="mt-1.5 text-[11px] text-ink-muted">{sub}</div>
      </div>
    </Tag>
  );
}

export function EmployeeMasterPage({
  onPickEmployee,
  onNew,
  onBulk,
  canManage,
}: {
  onPickEmployee: (e: Employee) => void;
  onNew: () => void;
  onBulk: (b: "accounts" | "import") => void;
  canManage: boolean;
}) {
  const emp = useEmployees();
  const att = useAttendance(todayMY().slice(0, 10));
  const [layout, setLayout] = useState<Layout>("A");
  const [grouped, setGrouped] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const [showSalary, setShowSalary] = useState(false);

  const attReady = att.data != null;
  const dayByEmp = useMemo(() => dayByEmployee(att.data), [att.data]);

  const allRows = useMemo<Row[]>(() => {
    const list = emp.data?.employees ?? [];
    return list
      .filter((e) => e.status === "ACTIVE")
      .map((e) => {
        const p = punchOf(dayByEmp.get(e.id) ?? null);
        return {
          e,
          punch: p.state,
          time: p.time,
          lateMin: p.lateMin,
          salarySen: e.payMode === "DAILY" ? e.dailyRateSen : e.basicSalarySen,
          linked: e.userId != null,
          position: e.position || "",
        };
      });
  }, [emp.data, dayByEmp]);

  const total = allRows.length;
  const notLinked = allRows.filter((r) => !r.linked).length;
  const foreign = allRows.filter((r) => r.e.isOutsource).length;
  const punchedIn = allRows.filter((r) => r.punch === "on" || r.punch === "late").length;
  const notIn = allRows.filter((r) => r.punch === "out").length;
  const onLeave = allRows.filter((r) => r.punch === "leave").length;
  const lateToday = allRows.filter((r) => r.punch === "late").length;
  const totalSalary = allRows.reduce((s, r) => s + r.salarySen, 0);
  const money = (sen: number) => (showSalary ? fmtSen(sen) : "RM ••••••");
  const dash = (n: number): ReactNode => (attReady ? n : "—");

  const matchesFilter = (r: Row) =>
    filter === null ||
    (filter === "punched" && (r.punch === "on" || r.punch === "late")) ||
    (filter === "late" && r.punch === "late") ||
    (filter === "notlinked" && !r.linked) ||
    (filter === "foreign" && r.e.isOutsource);
  const rows = useMemo(
    () => allRows.filter((r) => matchesFilter(r) && (query === "" || r.e.name.toLowerCase().includes(query.toLowerCase()) || r.e.empNo.toLowerCase().includes(query.toLowerCase()))),
    [allRows, query, filter],
  );
  const positions = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows) if (!seen.includes(r.position)) seen.push(r.position);
    return seen.sort((a, b) => posLabel(a).localeCompare(posLabel(b)));
  }, [rows]);
  const byPos = (p: string) => rows.filter((r) => r.position === p);
  const onDutyOf = (list: Row[]) => list.filter((r) => r.punch === "on" || r.punch === "late").length;
  const toggleFilter = (f: Exclude<Filter, null>) => setFilter((cur) => (cur === f ? null : f));
  const filterLabel: Record<Exclude<Filter, null>, string> = { punched: "Punched in today", late: "Late today", notlinked: "No ERP account", foreign: "Outsourced" };

  const layoutBtn = (l: Layout, label: string) => (
    <button type="button" onClick={() => setLayout(l)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", layout === l ? "bg-surface text-primary shadow-sm" : "text-ink-muted hover:text-ink")}>{label}</button>
  );

  return (
    <>
      <HrPageHeader
        title="Employee Master"
        subtitle={emp.data ? `${total} active` : "Drivers, helpers and warehouse crew"}
        actions={
          <>
            <div className="mr-1 flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
              <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Layout</span>
              {layoutBtn("A", "Table")}{layoutBtn("B", "By position")}{layoutBtn("D", "Today board")}
            </div>
            {canManage && <button type="button" className={hrSecondaryBtn} onClick={() => onBulk("accounts")}>From ERP accounts</button>}
            {canManage && <button type="button" className={hrSecondaryBtn} onClick={() => onBulk("import")}>Import</button>}
            {canManage && <button type="button" className={hrPrimaryBtn} onClick={onNew}>+ Add employee</button>}
          </>
        }
      />

      <div className="flex flex-col gap-3 px-6 py-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Active employees" value={emp.data ? total : "—"} sub={emp.data ? "in the company" : "loading"} bar="bg-primary" />
          <StatCard label="Punched in today" value={<span>{dash(punchedIn)} / {total}</span>} sub={attReady ? `${notIn} not in · ${onLeave} on leave` : "loading today"} bar="bg-synced" active={filter === "punched"} onClick={() => toggleFilter("punched")} />
          <StatCard label="No ERP account" value={emp.data ? notLinked : "—"} sub="cannot punch in" bar="bg-time" active={filter === "notlinked"} onClick={() => toggleFilter("notlinked")} />
          <StatCard label="Monthly basic" value={<span className="font-money">{money(totalSalary)}</span>} sub={`${total} employees`} bar="bg-accent" />
          <StatCard label="Late today" value={dash(lateToday)} sub="past shift start" bar="bg-err" active={filter === "late"} onClick={() => toggleFilter("late")} />
          <StatCard label="Outsourced" value={emp.data ? foreign : "—"} sub="foreign workers" bar="bg-learning" active={filter === "foreign"} onClick={() => toggleFilter("foreign")} />
        </div>

        <div className="flex min-h-[380px] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or Emp No" className="h-8 w-56 rounded-md border border-border bg-surface-2 px-3 text-[12px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none" />
            {layout === "A" && (
              <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
                <button type="button" onClick={() => setGrouped(true)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", grouped ? "bg-surface text-primary shadow-sm" : "text-ink-muted")}>Group by position</button>
                <button type="button" onClick={() => setGrouped(false)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", !grouped ? "bg-surface text-primary shadow-sm" : "text-ink-muted")}>Flat list</button>
              </div>
            )}
            <span className="text-[12px] text-ink-muted">{rows.length} employees</span>
            {filter && (
              <button type="button" onClick={() => setFilter(null)} className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-[11px] font-semibold text-primary-ink">
                {filterLabel[filter]} <span className="text-[13px] leading-none">×</span>
              </button>
            )}
            <button type="button" onClick={() => setShowSalary((v) => !v)} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">
              {showSalary ? "Hide salary" : "Show salary"}
            </button>
          </div>

          <div className="thin-scroll flex-1 overflow-auto">
            {emp.loading && <div className="px-4 py-10 text-center text-[12px] text-ink-muted">Loading…</div>}
            {emp.error && !emp.loading && <div className="px-4 py-10 text-center text-[12px] text-err">{emp.error}</div>}
            {emp.data && (
              <>
                {layout === "A" && <TableLayout rows={rows} grouped={grouped} money={money} attReady={attReady} onPick={onPickEmployee} onDutyOf={onDutyOf} positions={positions} byPos={byPos} />}
                {layout === "B" && <ByPositionLayout positions={positions} byPos={byPos} onDutyOf={onDutyOf} attReady={attReady} onPick={onPickEmployee} />}
                {layout === "D" && <TodayBoardLayout rows={rows} attReady={attReady} onPick={onPickEmployee} />}
                {rows.length === 0 && <div className="px-4 py-10 text-center text-[12px] text-ink-muted">No employees match.</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── A · Table ────────────────────────────────────────────────────────────────
function RowLine({ r, money, attReady, onPick }: { r: Row; money: (n: number) => string; attReady: boolean; onPick: (e: Employee) => void }) {
  return (
    <button type="button" onClick={() => onPick(r.e)} className="grid w-full grid-cols-[2.2fr_1.3fr_1.5fr_1.6fr_1fr_0.8fr_auto] items-center gap-3 border-b border-border-subtle px-4 py-2 text-left hover:bg-primary-soft/40">
      <span className="flex min-w-0 items-center gap-2.5">
        <Avatar name={r.e.name} />
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{r.e.name}</span>
          <span className="block font-mono text-[11px] font-semibold text-accent">{r.e.empNo}</span>
        </span>
      </span>
      <span><PositionPill pos={r.position} /></span>
      <Today r={r} ready={attReady} />
      <span className="min-w-0"><Erp r={r} /></span>
      <span className="text-right font-money text-[12.5px] text-ink">{money(r.salarySen)}</span>
      <span><StatusBadge s={r.e.status} /></span>
      <span className="text-ink-muted">›</span>
    </button>
  );
}
function GroupHeader({ pos, list, onDuty, money, salarySen }: { pos: string; list: Row[]; onDuty: number; money: (n: number) => string; salarySen: number }) {
  const p = posStyle(pos);
  return (
    <div className={cx("flex items-center gap-2 px-4 py-1.5", p.soft)}>
      <span className={cx("h-2 w-2 rounded-full", p.dot)} />
      <span className={cx("text-[12px] font-bold", p.text)}>{posLabel(pos)}</span>
      <span className="text-[11px] text-ink-muted">{list.length} people · {onDuty} on duty</span>
      <span className="ml-auto font-money text-[11px] text-ink-muted">{money(salarySen)}</span>
    </div>
  );
}
function TableLayout({ rows, grouped, money, attReady, onPick, onDutyOf, positions, byPos }: { rows: Row[]; grouped: boolean; money: (n: number) => string; attReady: boolean; onPick: (e: Employee) => void; onDutyOf: (l: Row[]) => number; positions: string[]; byPos: (p: string) => Row[] }) {
  if (!grouped) return <div>{rows.map((r) => <RowLine key={r.e.id} r={r} money={money} attReady={attReady} onPick={onPick} />)}</div>;
  return (
    <div>
      {positions.map((pos) => {
        const list = byPos(pos);
        if (list.length === 0) return null;
        return (
          <div key={pos}>
            <GroupHeader pos={pos} list={list} onDuty={onDutyOf(list)} money={money} salarySen={list.reduce((s, r) => s + r.salarySen, 0)} />
            {list.map((r) => <RowLine key={r.e.id} r={r} money={money} attReady={attReady} onPick={onPick} />)}
          </div>
        );
      })}
    </div>
  );
}

// ── B · By position (columns of cards) ───────────────────────────────────────
function PersonCard({ r, attReady, onPick }: { r: Row; attReady: boolean; onPick: (e: Employee) => void }) {
  return (
    <button type="button" onClick={() => onPick(r.e)} className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left hover:border-primary/50">
      <Avatar name={r.e.name} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-ink">{r.e.name}</span>
        <span className="block font-mono text-[10.5px] text-accent">{r.e.empNo}</span>
      </span>
      <span className="flex items-center gap-1 text-[11px]">
        <span className={cx("h-2 w-2 rounded-full", PUNCH_DOT[r.punch])} />
        <span className="font-mono text-ink-muted">{!attReady ? "—" : r.punch === "out" ? "—" : r.punch === "leave" ? "Leave" : r.time ?? "In"}</span>
      </span>
    </button>
  );
}
function ByPositionLayout({ positions, byPos, onDutyOf, attReady, onPick }: { positions: string[]; byPos: (p: string) => Row[]; onDutyOf: (l: Row[]) => number; attReady: boolean; onPick: (e: Employee) => void }) {
  return (
    <div className="grid h-full gap-3 p-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
      {positions.map((pos) => {
        const list = byPos(pos);
        const p = posStyle(pos);
        return (
          <div key={pos} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-2/60">
            <div className={cx("flex items-center gap-2 rounded-t-xl px-3 py-2", p.soft)}>
              <span className={cx("h-2 w-2 rounded-full", p.dot)} />
              <span className={cx("truncate text-[12.5px] font-bold", p.text)}>{posLabel(pos)}</span>
              <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{onDutyOf(list)}/{list.length}</span>
            </div>
            <div className="h-1 bg-surface-2"><div className={cx("h-full", p.bar)} style={{ width: `${list.length ? (onDutyOf(list) / list.length) * 100 : 0}%` }} /></div>
            <div className="grid flex-1 content-start gap-2 p-2">
              {list.map((r) => <PersonCard key={r.e.id} r={r} attReady={attReady} onPick={onPick} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── D · Today board (columns by punch status) ────────────────────────────────
const BOARD: { key: PunchState; label: string; dot: string }[] = [
  { key: "on", label: "On duty", dot: "bg-synced" },
  { key: "late", label: "Late", dot: "bg-time" },
  { key: "out", label: "Not in yet", dot: "bg-err" },
  { key: "leave", label: "On leave", dot: "bg-ink-muted" },
];
function TodayBoardLayout({ rows, attReady, onPick }: { rows: Row[]; attReady: boolean; onPick: (e: Employee) => void }) {
  if (!attReady) return <div className="px-4 py-10 text-center text-[12px] text-ink-muted">Loading today's punches…</div>;
  return (
    <div className="grid h-full grid-cols-4 gap-3 p-3">
      {BOARD.map((col) => {
        const list = rows.filter((r) => r.punch === col.key);
        return (
          <div key={col.key} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-2/60">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className={cx("h-2 w-2 rounded-full", col.dot)} />
              <span className="text-[12.5px] font-bold text-ink">{col.label}</span>
              <span className="ml-auto text-[11px] font-semibold text-ink-muted">{list.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {list.map((r) => (
                <button key={r.e.id} type="button" onClick={() => onPick(r.e)} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left hover:border-primary/50">
                  <Avatar name={r.e.name} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-ink">{r.e.name}</span>
                    <span className="block truncate text-[10.5px] text-ink-muted">{posLabel(r.position)}</span>
                  </span>
                  <span className="font-mono text-[11px] text-ink-muted">{r.punch === "out" || r.punch === "leave" ? "" : r.time ?? ""}{r.lateMin > 0 ? ` · +${r.lateMin}m` : ""}</span>
                </button>
              ))}
              {list.length === 0 && <div className="px-2 py-4 text-center text-[11px] text-ink-muted">None</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
