/* HR · Employees & Attendance — Overview (redesign stage 2). A 12-column
 * dashboard: Today / Headcount / Payroll, a month attendance chart with a
 * per-day hover popover, Needs attention, Coming up, Most late. Sample data
 * (handoff: data wiring later). Amounts masked behind an eye toggle. */
import { useState } from "react";
import type { ReactNode } from "react";
import { ATTEND_DAYS, COMING_UP, EMPLOYEES, MOST_LATE, NEEDS_ATTENTION, POSITION, avatarColor, initials, type Emp, type Punch } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

function Avatar({ name, size = 24, ring = false }: { name: string; size?: number; ring?: boolean }) {
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", avatarColor(name), ring && "ring-2 ring-surface")}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

function Card({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("flex min-w-0 flex-col rounded-xl border border-border bg-surface px-[18px] py-4", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold text-ink">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

const linkCls = "text-[11px] font-semibold text-primary hover:text-primary-ink";

const PUNCH: Record<Punch, { label: string; dot: string }> = {
  on: { label: "On duty", dot: "bg-synced" },
  late: { label: "Late", dot: "bg-time" },
  out: { label: "Not in yet", dot: "bg-err" },
  leave: { label: "On leave", dot: "bg-ink-muted" },
};

function StatusCell({ punch, emps, onPick }: { punch: Punch; emps: Emp[]; onPick: (e: Emp) => void }) {
  const info = PUNCH[punch];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className={cx("h-2 w-2 rounded-full", info.dot)} />
        <span className="text-[12px] text-ink-secondary">{info.label}</span>
        <span className="ml-auto text-[13px] font-bold text-ink">{emps.length}</span>
      </div>
      <div className="flex pl-0.5">
        {emps.slice(0, 6).map((e, i) => (
          <button key={e.id} type="button" onClick={() => onPick(e)} className="-ml-1.5 first:ml-0 transition-transform hover:z-10 hover:-translate-y-0.5">
            <Avatar name={e.name} size={24} ring />
          </button>
        ))}
      </div>
    </div>
  );
}

const toneBar: Record<string, string> = { err: "bg-err", warning: "bg-time", primary: "bg-primary", accent: "bg-accent", learning: "bg-learning" };
const comingTone: Record<string, string> = { accent: "bg-accent-soft text-accent", err: "bg-err-bg text-err", primary: "bg-primary-soft text-primary-ink", learning: "bg-learning-soft text-learning" };

export function OverviewPage({ onNavigate, onPickEmployee }: { onNavigate: (key: string) => void; onPickEmployee?: (e: Emp) => void }) {
  const [showPay, setShowPay] = useState(false);
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const pick = (e: Emp) => onPickEmployee?.(e);
  const money = (v: string) => (showPay ? v : "RM ••••••");

  const byPunch = (p: Punch) => EMPLOYEES.filter((e) => e.punch === p);
  const punchedIn = EMPLOYEES.filter((e) => e.punch === "on" || e.punch === "late").length;
  const onDuty = byPunch("on").length, late = byPunch("late").length, notIn = byPunch("out").length, leave = byPunch("leave").length;
  const seg = (n: number) => `${(n / EMPLOYEES.length) * 100}%`;

  return (
    <div className="grid min-w-[1080px] grid-cols-12 gap-[14px] px-6 py-4" style={{ gridAutoRows: "min-content" }}>
      {/* ── Today ───────────────────────────────────────────── */}
      <Card
        title="Today"
        className="col-span-5"
        right={<button type="button" onClick={() => onNavigate("attendance")} className={linkCls}>Attendance ›</button>}
      >
        <div className="text-[11px] text-ink-muted">Fri, 20 Nov · as of 09:30</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[40px] font-bold leading-none text-ink">{punchedIn}</span>
          <span className="text-[13px] text-ink-muted">/ {EMPLOYEES.length} punched in</span>
        </div>
        <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-2">
          <div className="bg-synced" style={{ width: seg(onDuty) }} />
          <div className="bg-time" style={{ width: seg(late) }} />
          <div className="bg-err" style={{ width: seg(notIn) }} />
          <div className="bg-ink-muted" style={{ width: seg(leave) }} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
          <StatusCell punch="on" emps={byPunch("on")} onPick={pick} />
          <StatusCell punch="late" emps={byPunch("late")} onPick={pick} />
          <StatusCell punch="out" emps={byPunch("out")} onPick={pick} />
          <StatusCell punch="leave" emps={byPunch("leave")} onPick={pick} />
        </div>
      </Card>

      {/* ── Headcount ───────────────────────────────────────── */}
      <Card
        title="Headcount"
        className="col-span-4"
        right={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-muted">Operation Department</span>
            <button type="button" onClick={() => onNavigate("employees")} className={linkCls}>Employees ›</button>
          </div>
        }
      >
        <div className="flex gap-6">
          {[{ n: 17, l: "Active" }, { n: 3, l: "Probation" }, { n: 11, l: "Foreign (HCFW)" }].map((s) => (
            <div key={s.l}>
              <div className="text-[22px] font-bold leading-none text-ink">{s.n}</div>
              <div className="mt-0.5 text-[11px] text-ink-muted">{s.l}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-3">
          {[
            { pos: "driver" as const, on: 4, total: 5 },
            { pos: "crew" as const, on: 9, total: 11 },
            { pos: "supervisor" as const, on: 1, total: 1 },
          ].map((r) => (
            <div key={r.pos}>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-1.5 text-ink-secondary"><span className={cx("h-2 w-2 rounded-sm", POSITION[r.pos].dot)} />{POSITION[r.pos].label}</span>
                <span className="text-[11px] text-ink-muted">{r.on} / {r.total} on duty</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className={cx("h-full rounded-full", POSITION[r.pos].bar)} style={{ width: `${(r.on / r.total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Payroll · Nov ───────────────────────────────────── */}
      <Card
        title="Payroll · Nov"
        className="col-span-3"
        right={
          <button type="button" onClick={() => setShowPay((v) => !v)} aria-label={showPay ? "Hide amounts" : "Show amounts"} className="text-ink-muted hover:text-ink">
            <EyeIcon off={!showPay} />
          </button>
        }
      >
        <div className="text-[11px] text-ink-muted">Net payable</div>
        <div className="mt-0.5 font-money text-[26px] font-bold leading-none text-ink">{money("RM 48,210")}</div>
        <div className="mt-3 flex flex-col gap-1.5 text-[12px]">
          <div className="flex justify-between"><span className="text-ink-muted">Gross</span><span className="font-money text-ink">{money("RM 61,540")}</span></div>
          <div className="flex justify-between"><span className="text-ink-muted">Deductions</span><span className="font-money text-err">{money("RM 13,330")}</span></div>
        </div>
        <button type="button" onClick={() => onNavigate("payroll")} className="mt-auto flex items-center justify-between rounded-lg bg-warning-bg px-3 py-2 text-left text-[11px] font-semibold text-warning-text">
          <span>Draft · pay date in 10 days</span><span>Review ›</span>
        </button>
      </Card>

      {/* ── Attendance · November ───────────────────────────── */}
      <Card
        title="Attendance · November"
        className="col-span-8 row-span-2"
        right={
          <div className="flex items-center gap-4 text-[11px]">
            <span><span className="font-bold text-primary">79%</span> <span className="text-ink-muted">Avg on-time</span></span>
            <span><span className="font-bold text-time">27</span> <span className="text-ink-muted">Late</span></span>
            <span><span className="font-bold text-err">16</span> <span className="text-ink-muted">Absent</span></span>
          </div>
        }
      >
        <div className="relative flex flex-1 items-end gap-2 pt-6">
          {ATTEND_DAYS.map((d, i) => {
            const low = d.onTime < 70;
            const openLeft = i >= ATTEND_DAYS.length / 2;
            return (
              <div
                key={d.date}
                className={cx("relative flex flex-1 flex-col items-center gap-1 rounded-md pb-1 pt-1", d.today && "bg-primary-soft/50")}
                onMouseEnter={() => setHoverDay(i)}
                onMouseLeave={() => setHoverDay((h) => (h === i ? null : h))}
              >
                <span className={cx("text-[10px] font-semibold", low ? "text-time" : "text-ink-muted")}>{d.onTime}%</span>
                <div className="flex h-[150px] w-2.5 items-end overflow-hidden rounded-full bg-surface-2">
                  <div className={cx("w-full rounded-full", low ? "bg-[rgb(201_162_90)]" : "bg-primary")} style={{ height: `${d.onTime}%` }} />
                </div>
                <div className="flex min-h-[14px] gap-0.5">
                  {d.late > 0 && <span className="rounded bg-warning-bg px-1 text-[9px] font-bold leading-[13px] text-warning-text">{d.late}</span>}
                  {d.absent > 0 && <span className="rounded bg-err-bg px-1 text-[9px] font-bold leading-[13px] text-err">{d.absent}</span>}
                </div>
                <div className="text-center leading-tight">
                  <div className="text-[10px] text-ink-muted">{d.dow}</div>
                  <div className={cx("text-[11px] font-semibold", d.today ? "text-primary-ink" : "text-ink-secondary")}>{d.date}</div>
                </div>
                {hoverDay === i && <DayPopover day={d} openLeft={openLeft} />}
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-4 border-t border-border-subtle pt-2 text-[11px] text-ink-muted">
          <Legend dot="bg-primary" label="On time" />
          <Legend dot="bg-time" label="Late count" />
          <Legend dot="bg-err" label="Absent count" />
        </div>
      </Card>

      {/* ── Needs attention ─────────────────────────────────── */}
      <Card
        title="Needs attention"
        className="col-span-4 row-span-2"
        right={<span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-err px-1 text-[11px] font-bold text-white">{NEEDS_ATTENTION.length}</span>}
      >
        <div className="flex flex-col divide-y divide-border-subtle">
          {NEEDS_ATTENTION.map((n, i) => (
            <div key={i} className="flex items-center gap-3 py-2 first:pt-0">
              <span className={cx("h-8 w-1 shrink-0 rounded-full", toneBar[n.tone])} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-ink">{n.title}</div>
                <div className="truncate text-[11px] text-ink-muted">{n.sub}</div>
              </div>
              <button type="button" onClick={() => onNavigate(n.to)} className={cx(linkCls, "shrink-0")}>{n.action} ›</button>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Coming up ───────────────────────────────────────── */}
      <Card title="Coming up" className="col-span-4">
        <div className="flex flex-col gap-3">
          {COMING_UP.slice(0, 4).map((c, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex w-10 shrink-0 flex-col items-center">
                <span className="text-[17px] font-bold leading-none text-ink">{c.day}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-accent">{c.mon}</span>
              </div>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{c.label}</span>
              <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", comingTone[c.tone])}>{c.kind}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Most late · this month ──────────────────────────── */}
      <Card title="Most late · this month" className="col-span-4">
        <div className="flex flex-col gap-2.5">
          {MOST_LATE.map((m, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Avatar name={m.name} size={26} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-ink">{m.name}</div>
                <div className="truncate text-[11px] text-ink-muted">{POSITION[m.position].label}</div>
              </div>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-time" style={{ width: `${(m.count / MOST_LATE[0].count) * 100}%` }} />
              </div>
              <span className="w-4 text-right text-[12px] font-bold text-ink">{m.count}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cx("h-2 w-2 rounded-full", dot)} />{label}</span>;
}

function DayPopover({ day, openLeft }: { day: (typeof ATTEND_DAYS)[number]; openLeft: boolean }) {
  const groups: { label: string; names: string[]; dot: string }[] = [
    { label: "Late", names: day.names.late, dot: "bg-time" },
    { label: "Absent", names: day.names.absent, dot: "bg-err" },
    { label: "Not in yet", names: day.names.notin, dot: "bg-err" },
    { label: "On leave", names: day.names.leave, dot: "bg-ink-muted" },
  ].filter((g) => g.names.length > 0);
  return (
    <div className={cx("absolute bottom-[calc(100%+6px)] z-20 w-[240px] rounded-xl border border-border bg-surface p-3 shadow-lg", openLeft ? "right-0" : "left-0")}>
      <div className="mb-2 flex items-center justify-between text-[12px] font-bold text-ink">
        <span>{day.dow} {day.date} Nov</span>
        <span className="text-primary">{day.onTime}% on time</span>
      </div>
      {groups.length === 0 ? (
        <div className="text-[11px] text-ink-muted">Everyone on time.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted"><span className={cx("h-1.5 w-1.5 rounded-full", g.dot)} />{g.label} · {g.names.length}</div>
              <div className="mt-0.5 pl-3 text-[11.5px] text-ink-secondary">{g.names.join(", ")}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
      {off && <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
    </svg>
  );
}
