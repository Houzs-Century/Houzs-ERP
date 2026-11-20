/* HR · Attendance (redesign stage 5). Today's status as four cards, then the
 * whole month as a grid: a sticky employee column + sticky day header, one
 * coloured cell per day (present / late L / leave V / absent A / not-in ? /
 * rest), and PRES / LATE / ABS totals. Sample data; today is the 20th. */
import { useState } from "react";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { EMPLOYEES, POSITION, avatarColor, initials, type Emp, type Punch } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const DAYS = 30;
const TODAY = 20;
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const weekday = (d: number) => WD[(d - 1) % 7];
const isRest = (d: number) => { const i = (d - 1) % 7; return i === 0 || i === 6; };

type Cell = "present" | "late" | "leave" | "absent" | "notin" | "rest" | "future";
function cellFor(emp: Emp, d: number): Cell {
  if (isRest(d)) return "rest";
  if (d > TODAY) return "future";
  if (d === TODAY) return emp.punch === "on" ? "present" : emp.punch === "late" ? "late" : emp.punch === "out" ? "notin" : "leave";
  const h = (emp.id * 131 + d * 17) % 100;
  if (h < 8) return "late";
  if (h < 11) return "leave";
  if (h < 14) return "absent";
  return "present";
}
const CELL: Record<Cell, { bg: string; letter: string; color: string }> = {
  present: { bg: "bg-synced-bg", letter: "", color: "" },
  late: { bg: "bg-warning-bg", letter: "L", color: "text-warning-text" },
  leave: { bg: "bg-surface-dim", letter: "V", color: "text-ink-muted" },
  absent: { bg: "bg-err-bg", letter: "A", color: "text-err" },
  notin: { bg: "bg-surface-2", letter: "?", color: "text-ink-muted" },
  rest: { bg: "", letter: "·", color: "text-ink-soft" },
  future: { bg: "", letter: "", color: "" },
};

function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  return <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", avatarColor(name))} style={{ width: size, height: size, fontSize: size * 0.38 }} title={name}>{initials(name)}</span>;
}

const STATUS: { key: Punch; label: string; dot: string }[] = [
  { key: "on", label: "On duty", dot: "bg-synced" },
  { key: "late", label: "Late", dot: "bg-time" },
  { key: "out", label: "Not in yet", dot: "bg-err" },
  { key: "leave", label: "On leave", dot: "bg-ink-muted" },
];

export function AttendancePage({ onPickEmployee }: { onPickEmployee?: (e: Emp) => void }) {
  const [month] = useState("November 2026");
  const totalsOf = (e: Emp) => {
    let pres = 0, late = 0, abs = 0;
    for (let d = 1; d <= DAYS; d++) { const c = cellFor(e, d); if (c === "present") pres++; else if (c === "late") { late++; pres++; } else if (c === "absent") abs++; }
    return { pres, late, abs };
  };

  return (
    <>
      <HrPageHeader
        title="Attendance"
        subtitle="Today at the top, the whole month below"
        actions={<><button type="button" className={hrSecondaryBtn}>Export</button><button type="button" className={hrPrimaryBtn}>Record attendance</button></>}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {/* 4 status cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {STATUS.map((s) => {
            const list = EMPLOYEES.filter((e) => e.punch === s.key);
            return (
              <div key={s.key} className="rounded-xl border border-border bg-surface px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={cx("h-2 w-2 rounded-full", s.dot)} />
                  <span className="text-[12.5px] font-semibold text-ink-secondary">{s.label}</span>
                  <span className="ml-auto text-[20px] font-bold leading-none text-ink">{list.length}</span>
                </div>
                <div className="mt-2.5 flex">
                  {list.slice(0, 8).map((e) => (
                    <button key={e.id} type="button" onClick={() => onPickEmployee?.(e)} className="-ml-1.5 first:ml-0 rounded-full ring-2 ring-surface hover:z-10"><Avatar name={e.name} size={24} /></button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* month grid */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2.5">
            <div className="flex items-center gap-1">
              <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2">‹</button>
              <span className="min-w-[130px] text-center text-[13px] font-semibold text-ink">{month}</span>
              <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2">›</button>
            </div>
            <div className="ml-auto flex items-center gap-3 text-[11px] text-ink-muted">
              <Legend bg="bg-synced-bg" label="Present" /><Legend bg="bg-warning-bg" label="Late" /><Legend bg="bg-surface-dim" label="Leave" /><Legend bg="bg-err-bg" label="Absent" /><Legend bg="bg-surface-2" label="Not in yet" />
            </div>
          </div>

          <div className="thin-scroll min-h-0 flex-1 overflow-auto">
            <table className="border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-30 w-[250px] min-w-[250px] border-b border-border-subtle bg-surface-2 px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-ink-muted">Employee</th>
                  {Array.from({ length: DAYS }, (_, i) => i + 1).map((d) => (
                    <th key={d} className={cx("sticky top-0 z-20 min-w-[26px] border-b border-border-subtle px-0 py-1 text-center font-semibold", d === TODAY ? "bg-primary-soft" : isRest(d) ? "bg-surface-2" : "bg-surface")}>
                      <div className="text-[9px] text-ink-muted">{weekday(d)}</div>
                      <div className={cx("text-[10px]", d === TODAY ? "text-primary-ink" : "text-ink-secondary")}>{d}</div>
                    </th>
                  ))}
                  {["PRES", "LATE", "ABS"].map((t) => (
                    <th key={t} className="sticky top-0 z-20 min-w-[34px] border-b border-l border-border-subtle bg-surface-2 px-1 py-1.5 text-center text-[9px] font-bold text-ink-muted">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EMPLOYEES.map((e) => {
                  const t = totalsOf(e);
                  return (
                    <tr key={e.id} className="group">
                      <th className="sticky left-0 z-10 w-[250px] min-w-[250px] border-b border-border-subtle bg-surface px-3 py-1 text-left group-hover:bg-row-hover">
                        <button type="button" onClick={() => onPickEmployee?.(e)} className="flex items-center gap-2 text-left">
                          <Avatar name={e.name} size={26} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", POSITION[e.position].dot)} />
                              <span className="truncate text-[12px] font-semibold text-ink">{e.name}</span>
                            </span>
                          </span>
                        </button>
                      </th>
                      {Array.from({ length: DAYS }, (_, i) => i + 1).map((d) => {
                        const c = cellFor(e, d);
                        const s = CELL[c];
                        return (
                          <td key={d} className={cx("border-b border-r border-border-subtle p-0.5 text-center", d === TODAY && "bg-primary-soft/30")}>
                            <div className={cx("mx-auto flex h-6 w-6 items-center justify-center rounded text-[9px] font-bold", s.bg, s.color)}>{s.letter}</div>
                          </td>
                        );
                      })}
                      <td className="border-b border-l border-border-subtle text-center font-semibold text-synced">{t.pres}</td>
                      <td className="border-b border-border-subtle text-center font-semibold text-time">{t.late}</td>
                      <td className="border-b border-border-subtle text-center font-semibold text-err">{t.abs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function Legend({ bg, label }: { bg: string; label: string }) {
  return <span className="flex items-center gap-1"><span className={cx("h-3 w-3 rounded-sm border border-border-subtle", bg)} />{label}</span>;
}
