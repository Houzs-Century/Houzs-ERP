/* HR · Employees & Attendance — Overview (redesign look, real data). A 12-col
 * dashboard built from the reads HR already has: Today (the attendance day read),
 * Headcount (employee master + today's punch), the month on-time chart (hover a
 * day for who was late / absent / on leave / on time) and "most late" (the
 * working-hours month read), Payroll (the month's run), Needs attention (not
 * punched in, unlinked accounts, work permits expiring, OT to confirm, penalties
 * to approve, a draft payroll, on probation) and Coming up (holidays, work-permit
 * expiry, confirmation due). The chart sits left with Needs attention as a tall
 * right column; Coming up and Most late sit under the chart. Amounts masked. */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { minutesFromWorkDate } from "../../vendor/shared/hr-attendance";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { avatarColor, initials } from "./hrAvatar";
import { dayByEmployee, punchOf, type PunchState } from "./attendanceToday";
import { HR, useAttendance, useEmployees, useHolidays, usePayroll, useWorkingHours, type Employee } from "./hrApi";
import { monthAttendanceStats, monthBounds, monthDayDetail, pad2 } from "./attendanceMonth";
import { buildUpcoming, permitAlert, probationAlert } from "./overviewReminders";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
// Month and weekday labels from Intl, not a hand-kept array — a calendar
// vocabulary has one source of truth (the locale), and it keeps the duplicated-
// decisions audit from counting a second copy of the month/weekday names here.
const monthLabel = (monthIndex: number, style: "long" | "short"): string =>
  new Date(Date.UTC(2000, monthIndex, 1)).toLocaleString("en-US", { month: style, timeZone: "UTC" });
const weekdayLetter = (date: Date): string => date.toLocaleString("en-US", { weekday: "narrow", timeZone: "UTC" });
/** First two names, then "+N" — keeps an alert's sub-line on one row. */
const names2 = (list: string[]): string => (list.length <= 2 ? list.join(", ") : `${list.slice(0, 2).join(", ")} +${list.length - 2}`);

function Avatar({ name, size = 24, ring = false }: { name: string; size?: number; ring?: boolean }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", avatarColor(name), ring && "ring-2 ring-surface")} style={{ width: size, height: size, fontSize: size * 0.4 }} title={name}>
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

/** One status row inside the chart's hover card: a coloured dot, the label, the
 *  count, then the names. Renders nothing when nobody is in that state. */
function TipSection({ label, names, dot }: { label: string; names: string[]; dot: string }) {
  if (names.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", dot)} />
        <span className="text-[11.5px] font-semibold text-ink-secondary">{label}</span>
        <span className="ml-auto text-[12px] font-bold text-ink">{names.length}</span>
      </div>
      <div className="mt-0.5 pl-3.5 text-[11px] leading-snug text-ink-muted">{names.join(", ")}</div>
    </div>
  );
}

const PUNCH: Record<PunchState, { label: string; dot: string }> = {
  on: { label: "On duty", dot: "bg-synced" },
  late: { label: "Late", dot: "bg-time" },
  out: { label: "Not in yet", dot: "bg-err" },
  leave: { label: "On leave", dot: "bg-ink-muted" },
};

type Row = { e: Employee; punch: PunchState };

function StatusCell({ state, rows, onPick }: { state: PunchState; rows: Row[]; onPick: (e: Employee) => void }) {
  const info = PUNCH[state];
  const list = rows.filter((r) => r.punch === state);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className={cx("h-2 w-2 rounded-full", info.dot)} />
        <span className="text-[12px] text-ink-secondary">{info.label}</span>
        <span className="ml-auto text-[13px] font-bold text-ink">{list.length}</span>
      </div>
      <div className="flex pl-0.5">
        {list.slice(0, 6).map((r) => (
          <button key={r.e.id} type="button" onClick={() => onPick(r.e)} className="-ml-1.5 transition-transform first:ml-0 hover:z-10 hover:-translate-y-0.5">
            <Avatar name={r.e.name} size={24} ring />
          </button>
        ))}
        {list.length > 6 && <span className="ml-1 self-center text-[11px] text-ink-muted">+{list.length - 6}</span>}
      </div>
    </div>
  );
}

const toneBar: Record<string, string> = { err: "bg-err", warning: "bg-time", primary: "bg-primary", accent: "bg-accent" };
const comingTone: Record<string, string> = { Holiday: "bg-err-bg text-err", Permit: "bg-warning-bg text-warning-text", Confirm: "bg-primary-soft text-primary" };
/** Flag a work permit this many days before it lapses (owner 2026-11-23). */
const PERMIT_WINDOW_DAYS = 90;

type Hover = { d: number; x: number; bottom: number };

export function OverviewPage({ onNavigate, onPickEmployee }: { onNavigate: (key: string) => void; onPickEmployee: (e: Employee) => void }) {
  const { can } = useAuth();
  const canOt = can("hr.ot.confirm");
  const canPenalty = can("hr.payroll.approve");
  const period = todayMY().slice(0, 7);
  const today = todayMY().slice(0, 10);
  const [showPay, setShowPay] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  const emp = useEmployees();
  const att = useAttendance(today);
  const payroll = usePayroll(period);
  const holidays = useHolidays();
  const wh = useWorkingHours(`${period}-01`, today);
  const ot = useQuery<{ claims: { status: string }[] }>(["attendance-ot-admin", period], () => api.get<{ claims: { status: string }[] }>(`/api/attendance/ot/admin?month=${period}`), [period], { enabled: canOt });
  const penalties = useQuery<{ penalties: { status: string }[] }>(`${HR}/penalties`, () => api.get<{ penalties: { status: string }[] }>(`${HR}/penalties`), [], { enabled: canPenalty });

  const dayByEmp = useMemo(() => dayByEmployee(att.data), [att.data]);
  const allEmps = useMemo(() => emp.data?.employees ?? [], [emp.data]);
  const active = useMemo(() => allEmps.filter((e) => e.status === "ACTIVE"), [allEmps]);
  const rows = useMemo<Row[]>(() => active.map((e) => ({ e, punch: punchOf(dayByEmp.get(e.id) ?? null).state })), [active, dayByEmp]);
  const attReady = att.data != null;

  const total = active.length;
  const onDuty = rows.filter((r) => r.punch === "on").length;
  const late = rows.filter((r) => r.punch === "late").length;
  const notIn = rows.filter((r) => r.punch === "out").length;
  const leave = rows.filter((r) => r.punch === "leave").length;
  const punchedIn = onDuty + late;
  const seg = (n: number) => (total ? `${(n / total) * 100}%` : "0%");

  const outsourced = active.filter((e) => e.isOutsource).length;
  const notLinked = active.filter((e) => !e.userId).length;
  const outNames = useMemo(() => rows.filter((r) => r.punch === "out").map((r) => r.e.name), [rows]);
  const unlinkedNames = useMemo(() => active.filter((e) => !e.userId).map((e) => e.name), [active]);
  const positions = useMemo(() => {
    const m = new Map<string, { total: number; onDuty: number }>();
    for (const r of rows) {
      const key = r.e.position || "No position";
      const cur = m.get(key) ?? { total: 0, onDuty: 0 };
      cur.total++;
      if (r.punch === "on" || r.punch === "late") cur.onDuty++;
      m.set(key, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  }, [rows]);

  const slips = payroll.data?.slips ?? [];
  const gross = slips.reduce((s, p) => s + p.grossSen, 0);
  const net = slips.reduce((s, p) => s + p.netSen, 0);
  const deductions = gross - net;
  const payStatus = payroll.data ? (payroll.data.status ?? (payroll.data.projected ? "Projected" : "Draft")) : "—";
  const money = (sen: number) => (showPay ? fmtSen(sen) : "RM ••••••");

  // The month's on-time chart, "most late" and the per-day hover detail, all from
  // the working-hours read.
  const empNameById = useMemo(() => new Map((wh.data?.employees ?? []).map((e) => [e.id, e.name])), [wh.data]);
  const { perDay, lateByEmp } = useMemo(() => monthAttendanceStats(wh.data?.days ?? []), [wh.data]);
  const perDayByDate = useMemo(() => new Map(perDay.map((s) => [s.date, s])), [perDay]);
  const perDayDetail = useMemo(() => monthDayDetail(wh.data?.days ?? [], wh.data?.employees ?? []), [wh.data]);
  const monthStats = useMemo(() => {
    let onTime = 0, lateDays = 0, absentDays = 0;
    for (const s of perDay) { onTime += s.onTime; lateDays += s.late; absentDays += s.absent; }
    const graded = onTime + lateDays + absentDays;
    return { graded, late: lateDays, absent: absentDays, avg: graded > 0 ? Math.round((onTime / graded) * 100) : null };
  }, [perDay]);
  const mostLate = useMemo(
    () => [...lateByEmp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => ({ id, name: empNameById.get(id) ?? `#${id}`, n })),
    [lateByEmp, empNameById],
  );
  const maxLate = mostLate[0]?.n ?? 0;
  const { y, m } = monthBounds(period);
  const todayDay = Number(today.slice(8, 10));
  const chartDays = Array.from({ length: todayDay }, (_, i) => i + 1);
  const isWeekend = (d: number) => { const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return dow === 0 || dow === 6; };
  const openEmp = (id: number) => { const e = active.find((a) => a.id === id); if (e) onPickEmployee(e); else onNavigate("attendance"); };

  // Someone still out after the shift (plus the grace) has started is worth
  // flagging; before then everyone is simply "not in yet", which is normal.
  const shift = att.data?.shift ?? null;
  const pastShiftStart = shift != null && minutesFromWorkDate(today, new Date()) > shift.startMin + shift.lateGraceMin;
  const otPending = canOt ? (ot.data?.claims.filter((c) => c.status === "PENDING").length ?? 0) : 0;
  const penaltyPending = canPenalty ? (penalties.data?.penalties.filter((p) => p.status === "PENDING_APPROVAL").length ?? 0) : 0;
  const needs = useMemo(() => {
    const items: { tone: string; title: string; sub: string; action: string; to: string }[] = [];
    if (attReady && notIn > 0 && pastShiftStart) items.push({ tone: "err", title: `${notIn} not punched in`, sub: outNames.length ? `${names2(outNames)} · shift started` : "The shift has started", action: "View", to: "attendance" });
    if (notLinked > 0) items.push({ tone: "warning", title: `${notLinked} without an ERP account`, sub: `${names2(unlinkedNames)} cannot punch in`, action: "Link", to: "employees" });
    const permit = permitAlert(allEmps, today, PERMIT_WINDOW_DAYS);
    if (permit.count > 0)
      items.push({
        tone: permit.anyExpired ? "err" : "warning",
        title: `${permit.count} work permit${permit.count === 1 ? "" : "s"} expiring`,
        sub: permit.anyExpired ? "Some have already lapsed — renew now" : `Within ${PERMIT_WINDOW_DAYS} days · foreign workers`,
        action: "Review",
        to: "employees",
      });
    if (otPending > 0) items.push({ tone: "primary", title: `${otPending} overtime to confirm`, sub: "Confirm before payroll closes", action: "Review", to: "ot-requests" });
    if (payroll.data && (payStatus === "DRAFT" || payStatus === "Draft" || payStatus === "MIXED")) items.push({ tone: "accent", title: "Payroll is still in draft", sub: `${period} run`, action: "Open", to: "payroll" });
    const probation = probationAlert(allEmps, today);
    if (probation.count > 0) items.push({ tone: "primary", title: `${probation.count} on probation`, sub: probation.nearestDays != null ? `Next confirmation in ${probation.nearestDays} day${probation.nearestDays === 1 ? "" : "s"}` : "Awaiting confirmation", action: "View", to: "employees" });
    if (penaltyPending > 0) items.push({ tone: "warning", title: `${penaltyPending} ${penaltyPending > 1 ? "penalties" : "penalty"} to approve`, sub: "Waiting for your sign-off", action: "Review", to: "penalties" });
    return items;
  }, [attReady, notIn, pastShiftStart, outNames, notLinked, unlinkedNames, allEmps, today, otPending, penaltyPending, payroll.data, payStatus, period]);

  const upcoming = useMemo(
    () =>
      buildUpcoming(holidays.data?.holidays ?? [], allEmps, today)
        .slice(0, 5)
        .map((u) => ({ day: u.date.slice(8, 10), mon: u.date.slice(5, 7), label: u.label, kind: u.kind })),
    [holidays.data, allEmps, today],
  );

  const comingUp = (
    <Card title="Coming up">
      {upcoming.length === 0 ? (
        <div className="py-4 text-[12px] text-ink-muted">{holidays.loading ? "Loading…" : "Nothing coming up."}</div>
      ) : (
        <div className="flex flex-col gap-3">
          {upcoming.map((c, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex w-10 shrink-0 flex-col items-center">
                <span className="text-[17px] font-bold leading-none text-ink">{c.day}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-accent">{monthLabel(Number(c.mon) - 1, "short").toUpperCase()}</span>
              </div>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{c.label}</span>
              <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold", comingTone[c.kind])}>{c.kind}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );

  const mostLateCard = (
    <Card title="Most late this month">
      {!wh.data ? (
        <div className="py-4 text-[12px] text-ink-muted">{wh.error ?? "Loading…"}</div>
      ) : mostLate.length === 0 ? (
        <div className="py-4 text-[12px] text-ink-muted">No late days this month.</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {mostLate.map((r) => (
            <button key={r.id} type="button" onClick={() => openEmp(r.id)} className="flex items-center gap-2.5 text-left">
              <Avatar name={r.name} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-ink">{r.name}</span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <span className="block h-full rounded-full bg-time" style={{ width: `${maxLate ? (r.n / maxLate) * 100 : 0}%` }} />
                </span>
              </span>
              <span className="shrink-0 text-[13px] font-bold text-time">{r.n}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );

  const tip = hover && renderTip(hover, perDayDetail, perDayByDate, period, y, m);

  return (
    <>
      <div className="grid min-w-[960px] grid-cols-12 gap-[14px] px-6 py-4" style={{ gridAutoRows: "min-content" }}>
        {/* Today */}
        <Card title="Today" className="col-span-5" right={<button type="button" onClick={() => onNavigate("attendance")} className={linkCls}>Attendance ›</button>}>
          {!attReady ? (
            <div className="py-6 text-center text-[12px] text-ink-muted">{att.error ?? "Loading today's punches…"}</div>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-[40px] font-bold leading-none text-ink">{punchedIn}</span>
                <span className="text-[13px] text-ink-muted">/ {total} punched in</span>
              </div>
              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-2">
                <div className="bg-synced" style={{ width: seg(onDuty) }} />
                <div className="bg-time" style={{ width: seg(late) }} />
                <div className="bg-err" style={{ width: seg(notIn) }} />
                <div className="bg-ink-muted" style={{ width: seg(leave) }} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
                <StatusCell state="on" rows={rows} onPick={onPickEmployee} />
                <StatusCell state="late" rows={rows} onPick={onPickEmployee} />
                <StatusCell state="out" rows={rows} onPick={onPickEmployee} />
                <StatusCell state="leave" rows={rows} onPick={onPickEmployee} />
              </div>
            </>
          )}
        </Card>

        {/* Headcount */}
        <Card title="Headcount" className="col-span-4" right={<button type="button" onClick={() => onNavigate("employees")} className={linkCls}>Employees ›</button>}>
          <div className="flex gap-6">
            {[{ n: total, l: "Active" }, { n: outsourced, l: "Outsourced" }, { n: notLinked, l: "Not linked" }].map((s) => (
              <div key={s.l}>
                <div className="text-[22px] font-bold leading-none text-ink">{emp.data ? s.n : "—"}</div>
                <div className="mt-0.5 text-[11px] text-ink-muted">{s.l}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-3">
            {positions.map(([name, c]) => (
              <div key={name}>
                <div className="mb-1 flex items-center justify-between text-[12px]">
                  <span className="truncate text-ink-secondary">{name}</span>
                  <span className="shrink-0 text-[11px] text-ink-muted">{attReady ? `${c.onDuty} / ${c.total} on duty` : `${c.total}`}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${attReady && c.total ? (c.onDuty / c.total) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
            {positions.length === 0 && <div className="text-[12px] text-ink-muted">{emp.loading ? "Loading…" : "No employees yet."}</div>}
          </div>
        </Card>

        {/* Payroll */}
        <Card title={`Payroll · ${period.slice(5, 7)}/${period.slice(0, 4)}`} className="col-span-3" right={<button type="button" onClick={() => setShowPay((v) => !v)} aria-label={showPay ? "Hide amounts" : "Show amounts"} className="text-ink-muted hover:text-ink"><EyeIcon off={!showPay} /></button>}>
          {payroll.error ? (
            <div className="py-4 text-[12px] text-ink-muted">Payroll not available.</div>
          ) : (
            <>
              <div className="text-[11px] text-ink-muted">Net payable</div>
              <div className="mt-0.5 font-money text-[26px] font-bold leading-none text-ink">{payroll.data ? money(net) : "—"}</div>
              <div className="mt-3 flex flex-col gap-1.5 text-[12px]">
                <div className="flex justify-between"><span className="text-ink-muted">Gross</span><span className="font-money text-ink">{payroll.data ? money(gross) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-ink-muted">Deductions</span><span className="font-money text-err">{payroll.data ? money(deductions) : "—"}</span></div>
              </div>
              <button type="button" onClick={() => onNavigate("payroll")} className="mt-3 flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-left text-[11px] font-semibold text-ink-secondary hover:bg-surface-dim">
                <span>{String(payStatus)}</span><span>Open ›</span>
              </button>
            </>
          )}
        </Card>

        {/* Left column: the month chart, then Coming up + Most late */}
        <div className="col-span-8 flex min-w-0 flex-col gap-[14px]">
          <Card
            title={`Attendance · ${monthLabel(m - 1, "long")}`}
            right={monthStats.avg != null ? (
              <div className="flex items-center gap-4 text-[11px]">
                <span className="flex items-baseline gap-1"><span className="text-[16px] font-bold text-ink">{monthStats.avg}%</span><span className="text-ink-muted">on-time</span></span>
                <span className="flex items-baseline gap-1"><span className="text-[15px] font-bold text-time">{monthStats.late}</span><span className="text-ink-muted">late</span></span>
                <span className="flex items-baseline gap-1"><span className="text-[15px] font-bold text-err">{monthStats.absent}</span><span className="text-ink-muted">absent</span></span>
              </div>
            ) : undefined}
          >
            {!wh.data ? (
              <div className="py-10 text-center text-[12px] text-ink-muted">{wh.error ?? "Loading attendance…"}</div>
            ) : monthStats.graded === 0 ? (
              <div className="py-10 text-center text-[12px] text-ink-muted">No attendance recorded this month yet — the bars fill in as people punch each day.</div>
            ) : (
              <div className="flex items-stretch gap-[3px]" style={{ height: 156 }}>
                {chartDays.map((d) => {
                  const s = perDayByDate.get(`${period}-${pad2(d)}`);
                  const rate = s?.rate ?? null;
                  const weekend = isWeekend(d);
                  return (
                    <div
                      key={d}
                      data-testid={`chart-day-${d}`}
                      className="flex min-w-0 flex-1 cursor-default flex-col items-center"
                      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ d, x: r.left + r.width / 2, bottom: r.bottom }); }}
                      onMouseLeave={() => setHover(null)}
                    >
                      <div className="flex h-3 items-end text-[8.5px] font-semibold text-ink-muted">{rate != null ? Math.round(rate * 100) : ""}</div>
                      <div className="flex w-full flex-1 items-end justify-center pt-1">
                        <div className="flex h-full w-full max-w-[18px] items-end overflow-hidden rounded bg-surface-2">
                          {rate != null && (
                            <div
                              className={cx("w-full rounded", rate >= 0.85 ? "bg-synced" : rate >= 0.6 ? "bg-time" : "bg-err")}
                              style={{ height: `${Math.max(rate * 100, 3)}%` }}
                            />
                          )}
                        </div>
                      </div>
                      <div className="mt-1 flex flex-col items-center leading-none">
                        <span className={cx("text-[8.5px]", weekend ? "text-ink-muted/70" : "text-ink-muted")}>{weekdayLetter(new Date(Date.UTC(y, m - 1, d)))}</span>
                        <span className="text-[9px] font-semibold text-ink-secondary">{d}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-[14px]">
            {comingUp}
            {mostLateCard}
          </div>
        </div>

        {/* Needs attention — tall right column */}
        <Card title="Needs attention" className="col-span-4" right={needs.length > 0 ? <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-err px-1 text-[11px] font-bold text-white">{needs.length}</span> : undefined}>
          {needs.length === 0 ? (
            <div className="py-4 text-[12px] text-ink-muted">{emp.loading ? "Loading…" : "Nothing needs attention right now."}</div>
          ) : (
            <div className="flex flex-col divide-y divide-border-subtle">
              {needs.map((n, i) => (
                <div key={i} className="flex items-center gap-3 py-2 first:pt-0">
                  <span className={cx("h-8 w-1 shrink-0 rounded-full", toneBar[n.tone] ?? "bg-primary")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-semibold text-ink">{n.title}</div>
                    <div className="truncate text-[11px] text-ink-muted">{n.sub}</div>
                  </div>
                  <button type="button" onClick={() => onNavigate(n.to)} className={cx(linkCls, "shrink-0")}>{n.action} ›</button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      {tip}
    </>
  );
}

/** The chart's hover card: date, the day's on-time rate, and the names by state,
 *  pinned beneath the hovered column (position: fixed, so no ancestor clips it). */
function renderTip(
  hover: Hover,
  perDayDetail: Map<string, import("./attendanceMonth").DayDetail>,
  perDayByDate: Map<string, import("./attendanceMonth").DayStat>,
  period: string,
  y: number,
  m: number,
): ReactNode {
  const key = `${period}-${pad2(hover.d)}`;
  const detail = perDayDetail.get(key);
  if (!detail) return null;
  const s = perDayByDate.get(key);
  const dObj = new Date(Date.UTC(y, m - 1, hover.d));
  const dateLabel = `${dObj.toLocaleString("en-US", { weekday: "short", timeZone: "UTC" })}, ${hover.d} ${monthLabel(m - 1, "short")}`;
  const W = 250;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const left = Math.min(Math.max(hover.x - W / 2, 8), vw - W - 8);
  return (
    <div className="pointer-events-none fixed z-50 rounded-xl border border-border bg-surface p-3 shadow-[0_16px_48px_-12px_rgba(17,20,15,.4)]" style={{ left, top: hover.bottom + 8, width: W }}>
      <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-border-subtle pb-2">
        <span className="text-[12.5px] font-bold text-ink">{dateLabel}</span>
        <span className="text-[11px] text-ink-muted">{s?.rate != null ? `${Math.round(s.rate * 100)}% on time` : "no graded day"}</span>
      </div>
      <div className="flex flex-col gap-2">
        <TipSection label="Late" names={detail.late} dot="bg-time" />
        <TipSection label="Absent" names={detail.absent} dot="bg-err" />
        <TipSection label="On leave" names={detail.leave} dot="bg-ink-muted" />
        <TipSection label="On time" names={detail.onTime} dot="bg-synced" />
      </div>
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
