/* HR · Employees & Attendance — Employee Master (redesign stage 3).
 * 6 stat cards (four are click-to-filter), a toolbar (search, group/flat,
 * show-salary), and three layouts: A table (grouped by position), B by-position
 * columns, D today board. Sample data; salary masked by default. The B and D
 * layouts follow the written handoff (their reference shots matched A). */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { EMPLOYEES, POSITION, avatarColor, initials, type Emp, type Position, type Punch } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
type Layout = "A" | "B" | "D";
type Filter = null | "punched" | "late" | "probation" | "foreign";

function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", avatarColor(name))} style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials(name)}
    </span>
  );
}
const PUNCH_DOT: Record<Punch, string> = { on: "bg-synced", late: "bg-time", out: "bg-err", leave: "bg-ink-muted" };
function PositionPill({ pos }: { pos: Position }) {
  const p = POSITION[pos];
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", p.soft, p.text)}><span className={cx("h-1.5 w-1.5 rounded-full", p.dot)} />{p.label}</span>;
}
function Today({ e }: { e: Emp }) {
  if (e.punch === "leave") return <span className="flex items-center gap-1.5 text-[12px] text-ink-muted"><span className="h-2 w-2 rounded-full bg-ink-muted" />On leave</span>;
  if (e.punch === "out") return <span className="flex items-center gap-1.5 text-[12px]"><span className="h-2 w-2 rounded-full bg-err" /><span className="font-semibold text-err">Not in</span><span className="text-ink-muted">· shift {e.shift}</span></span>;
  return (
    <span className="flex items-center gap-1.5 text-[12px]">
      <span className={cx("h-2 w-2 rounded-full", PUNCH_DOT[e.punch])} />
      <span className="font-mono font-semibold text-ink">{e.time}</span>
      <span className="text-ink-muted">In · shift {e.shift}</span>
      {e.lateMin > 0 && <span className="font-semibold text-time">{e.lateMin} min late</span>}
    </span>
  );
}
function StatusBadge({ s }: { s: Emp["status"] }) {
  return s === "ACTIVE"
    ? <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-synced">Active</span>
    : <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warning-text">Probation</span>;
}
function Erp({ e }: { e: Emp }) {
  return e.erp
    ? <span className="flex items-center gap-1.5 text-[12px] text-ink-muted"><span className="text-synced">✓</span><span className="truncate font-mono">{e.erp}</span></span>
    : <span className="inline-flex items-center gap-1 rounded bg-warning-bg px-1.5 py-0.5 text-[11px] font-semibold text-warning-text">⚠ Not linked</span>;
}

function StatCard({ label, value, sub, bar, active, onClick }: { label: string; value: ReactNode; sub: string; bar: string; active?: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} className={cx("flex min-w-[150px] flex-col overflow-hidden rounded-xl border bg-surface text-left", active ? "border-primary ring-1 ring-primary" : "border-border", onClick && "hover:border-primary/50")}>
      <div className={cx("h-[3px] w-full", bar)} />
      <div className="px-3.5 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
        <div className="mt-1 text-[22px] font-bold leading-none text-ink">{value}</div>
        <div className="mt-1.5 text-[11px] text-ink-muted">{sub}</div>
      </div>
    </Tag>
  );
}

const ORDER: Position[] = ["driver", "crew", "supervisor"];

export function EmployeeMasterPage({ onPickEmployee }: { onPickEmployee?: (e: Emp) => void }) {
  const [layout, setLayout] = useState<Layout>("A");
  const [grouped, setGrouped] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const [showSalary, setShowSalary] = useState(false);

  const total = EMPLOYEES.length;
  const probation = EMPLOYEES.filter((e) => e.status === "PROBATION").length;
  const foreign = EMPLOYEES.filter((e) => e.foreign).length;
  const punchedIn = EMPLOYEES.filter((e) => e.punch === "on" || e.punch === "late").length;
  const notIn = EMPLOYEES.filter((e) => e.punch === "out").length;
  const onLeave = EMPLOYEES.filter((e) => e.punch === "leave").length;
  const lateToday = EMPLOYEES.filter((e) => e.punch === "late").length;
  const totalSalary = EMPLOYEES.reduce((s, e) => s + e.salarySen, 0);
  const money = (sen: number) => (showSalary ? fmtSen(sen) : "RM ••••••");

  const matchesFilter = (e: Emp) =>
    filter === null ||
    (filter === "punched" && (e.punch === "on" || e.punch === "late")) ||
    (filter === "late" && e.punch === "late") ||
    (filter === "probation" && e.status === "PROBATION") ||
    (filter === "foreign" && e.foreign);
  const rows = useMemo(
    () => EMPLOYEES.filter((e) => matchesFilter(e) && (query === "" || e.name.toLowerCase().includes(query.toLowerCase()) || e.empNo.toLowerCase().includes(query.toLowerCase()))),
    [query, filter],
  );
  const byPos = (p: Position) => rows.filter((e) => e.position === p);
  const onDutyOf = (list: Emp[]) => list.filter((e) => e.punch === "on" || e.punch === "late").length;
  const toggleFilter = (f: Exclude<Filter, null>) => setFilter((cur) => (cur === f ? null : f));
  const filterLabel: Record<Exclude<Filter, null>, string> = { punched: "Punched in today", late: "Late today", probation: "On probation", foreign: "Foreign workers" };

  const layoutBtn = (l: Layout, label: string) => (
    <button type="button" onClick={() => setLayout(l)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", layout === l ? "bg-surface text-primary shadow-sm" : "text-ink-muted hover:text-ink")}>{label}</button>
  );

  return (
    <>
      <HrPageHeader
        title="Employee Master"
        subtitle="Drivers, helpers and warehouse crew · Friday, 20 Nov 2026"
        actions={
          <>
            <div className="mr-1 flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
              <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Layout</span>
              {layoutBtn("A", "Table")}{layoutBtn("B", "By position")}{layoutBtn("D", "Today board")}
            </div>
            <button type="button" className={hrSecondaryBtn}>From ERP accounts</button>
            <button type="button" className={hrSecondaryBtn}>Import</button>
            <button type="button" className={hrSecondaryBtn}>Export</button>
            <button type="button" className={hrPrimaryBtn}>+ Add employee</button>
          </>
        }
      />

      <div className="flex flex-col gap-3 px-6 py-4">
        {/* stat cards */}
        <div className="flex gap-3 overflow-x-auto pb-1">
          <StatCard label="Active employees" value={total} sub={`${total - probation} confirmed · ${probation} on probation`} bar="bg-primary" />
          <StatCard label="Punched in today" value={`${punchedIn} / ${total}`} sub={`${notIn} not in yet · ${onLeave} on leave`} bar="bg-synced" active={filter === "punched"} onClick={() => toggleFilter("punched")} />
          <StatCard label="Late this month" value={<span>27 <span className="text-[13px] font-semibold text-ink-muted">times</span></span>} sub={`${lateToday} late today`} bar="bg-time" active={filter === "late"} onClick={() => toggleFilter("late")} />
          <StatCard label="Monthly basic" value={<span className="font-money">{money(totalSalary)}</span>} sub={`${total} employees`} bar="bg-accent" />
          <StatCard label="On probation" value={probation} sub="Next confirms in 86 days" bar="bg-learning" active={filter === "probation"} onClick={() => toggleFilter("probation")} />
          <StatCard label="Foreign workers" value={<span>{foreign} <span className="text-[13px] font-semibold text-ink-muted">HCFW</span></span>} sub="2 permits expire within 90 days" bar="bg-err" active={filter === "foreign"} onClick={() => toggleFilter("foreign")} />
        </div>

        {/* table / board card */}
        <div className="flex min-h-[380px] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or Emp No" className="h-8 w-56 rounded-md border border-border bg-surface-2 px-3 text-[12px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none" />
            {layout === "A" && (
              <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
                <button type="button" onClick={() => setGrouped(true)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", grouped ? "bg-surface text-primary shadow-sm" : "text-ink-muted")}>Group by position</button>
                <button type="button" onClick={() => setGrouped(false)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", !grouped ? "bg-surface text-primary shadow-sm" : "text-ink-muted")}>Flat list</button>
              </div>
            )}
            <span className="text-[12px] text-ink-muted">Operation Department · {rows.length} employees</span>
            {filter && (
              <button type="button" onClick={() => setFilter(null)} className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-[11px] font-semibold text-primary-ink">
                {filterLabel[filter]} <span className="text-[13px] leading-none">×</span>
              </button>
            )}
            <button type="button" onClick={() => setShowSalary((v) => !v)} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">
              {showSalary ? "Hide salary" : "Show salary"}
            </button>
          </div>

          {/* body */}
          <div className="thin-scroll flex-1 overflow-auto">
            {layout === "A" && <TableLayout rows={rows} grouped={grouped} money={money} onPick={onPickEmployee} onDutyOf={onDutyOf} byPos={byPos} />}
            {layout === "B" && <ByPositionLayout byPos={byPos} onDutyOf={onDutyOf} onPick={onPickEmployee} />}
            {layout === "D" && <TodayBoardLayout rows={rows} onPick={onPickEmployee} />}
          </div>
        </div>
      </div>
    </>
  );
}

// ── A · Table ────────────────────────────────────────────────────────────────
function Row({ e, money, onPick }: { e: Emp; money: (n: number) => string; onPick?: (e: Emp) => void }) {
  return (
    <button type="button" onClick={() => onPick?.(e)} className="grid w-full grid-cols-[2.2fr_1.1fr_1.5fr_1.6fr_1fr_0.8fr_auto] items-center gap-3 border-b border-border-subtle px-4 py-2 text-left hover:bg-primary-soft/40">
      <span className="flex min-w-0 items-center gap-2.5">
        <Avatar name={e.name} />
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{e.name}</span>
          <span className="block font-mono text-[11px] font-semibold text-accent">{e.empNo}</span>
        </span>
      </span>
      <span><PositionPill pos={e.position} /></span>
      <Today e={e} />
      <span className="min-w-0"><Erp e={e} /></span>
      <span className="text-right font-money text-[12.5px] text-ink">{money(e.salarySen)}</span>
      <span><StatusBadge s={e.status} /></span>
      <span className="text-ink-muted">›</span>
    </button>
  );
}
function GroupHeader({ pos, list, onDuty, money, salarySen }: { pos: Position; list: Emp[]; onDuty: number; money: (n: number) => string; salarySen: number }) {
  const p = POSITION[pos];
  return (
    <div className={cx("flex items-center gap-2 px-4 py-1.5", p.soft)}>
      <span className={cx("h-2 w-2 rounded-full", p.dot)} />
      <span className={cx("text-[12px] font-bold", p.text)}>{p.label}</span>
      <span className="text-[11px] text-ink-muted">{list.length} people · {onDuty} on duty</span>
      <span className="ml-auto font-money text-[11px] text-ink-muted">{money(salarySen)}</span>
    </div>
  );
}
function TableLayout({ rows, grouped, money, onPick, onDutyOf, byPos }: { rows: Emp[]; grouped: boolean; money: (n: number) => string; onPick?: (e: Emp) => void; onDutyOf: (l: Emp[]) => number; byPos: (p: Position) => Emp[] }) {
  if (!grouped) return <div>{rows.map((e) => <Row key={e.id} e={e} money={money} onPick={onPick} />)}</div>;
  return (
    <div>
      {ORDER.map((pos) => {
        const list = byPos(pos);
        if (list.length === 0) return null;
        return (
          <div key={pos}>
            <GroupHeader pos={pos} list={list} onDuty={onDutyOf(list)} money={money} salarySen={list.reduce((s, e) => s + e.salarySen, 0)} />
            {list.map((e) => <Row key={e.id} e={e} money={money} onPick={onPick} />)}
          </div>
        );
      })}
    </div>
  );
}

// ── B · By position (columns of cards) ───────────────────────────────────────
function PersonCard({ e, onPick }: { e: Emp; onPick?: (e: Emp) => void }) {
  return (
    <button type="button" onClick={() => onPick?.(e)} className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left hover:border-primary/50">
      <Avatar name={e.name} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-ink">{e.name}</span>
        <span className="block font-mono text-[10.5px] text-accent">{e.empNo}</span>
      </span>
      <span className="flex items-center gap-1 text-[11px]">
        <span className={cx("h-2 w-2 rounded-full", PUNCH_DOT[e.punch])} />
        <span className="font-mono text-ink-muted">{e.punch === "out" ? "—" : e.punch === "leave" ? "Leave" : e.time}</span>
      </span>
    </button>
  );
}
function ByPositionLayout({ byPos, onDutyOf, onPick }: { byPos: (p: Position) => Emp[]; onDutyOf: (l: Emp[]) => number; onPick?: (e: Emp) => void }) {
  return (
    <div className="grid h-full gap-3 p-3" style={{ gridTemplateColumns: "1fr 2fr 1fr" }}>
      {ORDER.map((pos) => {
        const list = byPos(pos);
        const p = POSITION[pos];
        return (
          <div key={pos} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-2/60">
            <div className={cx("flex items-center gap-2 rounded-t-xl px-3 py-2", p.soft)}>
              <span className={cx("h-2 w-2 rounded-full", p.dot)} />
              <span className={cx("text-[12.5px] font-bold", p.text)}>{p.label}</span>
              <span className="ml-auto text-[11px] text-ink-muted">{onDutyOf(list)}/{list.length} on duty</span>
            </div>
            <div className="h-1 bg-surface-2"><div className={cx("h-full", p.bar)} style={{ width: `${list.length ? (onDutyOf(list) / list.length) * 100 : 0}%` }} /></div>
            <div className={cx("grid flex-1 content-start gap-2 p-2", pos === "crew" ? "grid-cols-2" : "grid-cols-1")}>
              {list.map((e) => <PersonCard key={e.id} e={e} onPick={onPick} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── D · Today board (columns by punch status) ────────────────────────────────
const BOARD: { key: Punch; label: string; dot: string }[] = [
  { key: "on", label: "On duty", dot: "bg-synced" },
  { key: "late", label: "Late", dot: "bg-time" },
  { key: "out", label: "Not in yet", dot: "bg-err" },
  { key: "leave", label: "On leave", dot: "bg-ink-muted" },
];
function TodayBoardLayout({ rows, onPick }: { rows: Emp[]; onPick?: (e: Emp) => void }) {
  return (
    <div className="grid h-full grid-cols-4 gap-3 p-3">
      {BOARD.map((col) => {
        const list = rows.filter((e) => e.punch === col.key);
        return (
          <div key={col.key} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-2/60">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className={cx("h-2 w-2 rounded-full", col.dot)} />
              <span className="text-[12.5px] font-bold text-ink">{col.label}</span>
              <span className="ml-auto text-[11px] font-semibold text-ink-muted">{list.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {list.map((e) => (
                <button key={e.id} type="button" onClick={() => onPick?.(e)} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left hover:border-primary/50">
                  <Avatar name={e.name} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-ink">{e.name}</span>
                    <span className="block text-[10.5px] text-ink-muted">{POSITION[e.position].label}</span>
                  </span>
                  <span className="font-mono text-[11px] text-ink-muted">{e.punch === "out" ? "—" : e.punch === "leave" ? "" : e.time}{e.lateMin > 0 ? ` · +${e.lateMin}m` : ""}</span>
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
