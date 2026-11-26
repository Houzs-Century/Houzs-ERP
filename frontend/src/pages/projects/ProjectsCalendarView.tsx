import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, Circle, X, ChevronDown, Search } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { getHolidaysOn } from "../../lib/holidays";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { booleanPreference, useIdentityPreference } from "../../hooks/useIdentityPreference";
import { useStickyFilters } from "../../hooks/useStickyFilters";
import { useRafCoalescedHover } from "../../hooks/useRafCoalescedHover";
import { api } from "../../api/client";
import { ResetFiltersButton } from "../../components/ResetFiltersButton";
import { cn, todayInAppTz } from "../../lib/utils";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { composeDefaultProjectName, upcaseLeadingState } from "./projectHelpers";
import { STATUS_OPTIONS, statusBarStyle } from "./projectStatus";
import {
  type CalendarProject,
  type CalendarTask,
  type CalendarMode,
  CALENDAR_BAR_H,
  CALENDAR_LANE_TOTAL,
  EMPTY_CALENDAR_PROJECTS,
  EMPTY_CALENDAR_TASKS,
  buildCalendarWindow,
  buildProjectsCalendarModel,
} from "./calendarModel";
import { CalendarTaskChip, DayCountBadge, CalendarBarPopover, CalendarTaskPopover, CalendarDayModal } from "./calendarParts";
import { CalendarSearchStrip, useCalendarSearch } from "./CalendarSearchStrip";
import { type CalendarMatch, matchStart, monthPeriod, pickAdjacentMatch, weekStartOf } from "./calendarSearch";

// Owner 2026-09-30: the calendar filter must survive going into a project and
// back, and only clear on logout or after an hour of not being touched.
const CALENDAR_FILTER_IDLE_MS = 60 * 60 * 1000;

const PROJECTS_CALENDAR_FILTER_KEYS = [
  "brand",
  // `status` was READ and SET here but never listed, so it alone was dropped on
  // every navigation while brand/organizer/search survived (owner 2026-09-30).
  "status",
  "stage",
  "organizer",
  "month",
  "mode",
  "week",
  "section",
  "q",
] as const;

const EMPTY_MATCHES: CalendarMatch[] = [];

export function ProjectsCalendarView() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters(
    "projects-calendar",
    PROJECTS_CALENDAR_FILTER_KEYS,
    { idleTtlMs: CALENDAR_FILTER_IDLE_MS }
  );
  const brand = params.get("brand") || "";
  const status = params.get("status") || "";
  const organizer = params.get("organizer") || "";
  const search = params.get("q") || "";
  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setBrand = (v: string) => patchParams({ brand: v });
  const setStatus = (v: string) => patchParams({ status: v });
  const setOrganizer = (v: string) => patchParams({ organizer: v });
  const setSearch = (v: string) => patchParams({ q: v });

  const [showTasks, setShowTasks] = useIdentityPreference(
    "projects:cal:showTasks",
    false,
    booleanPreference,
  );
  const [showHolidays, setShowHolidays] = useIdentityPreference(
    "projects:cal:showHolidays",
    true,
    booleanPreference,
  );
  // Owner 2026-07-23: the calendar always shows every project bar + task inline
  // (no "+N more", no Expand-all toggle) — pc and mobile both default-expanded.
  const expandAll = true as boolean;
  const brandsQ = useQuery<{ data: string[] }>("/api/projects/brands", () =>
    api.get("/api/projects/brands")
  );
  const organizersQ = useQuery<{ data: { id: number; name: string }[] }>("/api/projects/organizers", () =>
    api.get("/api/projects/organizers")
  );
  const sectionsListQ = useQuery<{ data: string[] }>("/api/projects/sections-distinct", () =>
    api.get("/api/projects/sections-distinct")
  );
  const mode: CalendarMode =
    params.get("mode") === "week" ? "week" : "month";
  const monthStr = params.get("month") || "";
  const weekStartStr = params.get("week") || "";

  const calendarWindow = useMemo(
    () => buildCalendarWindow(mode, monthStr, weekStartStr),
    [mode, monthStr, weekStartStr],
  );
  const { anchor, startDay, endDay, cells, weekCount, totalCells, fromStr, toStr } = calendarWindow;

  const setAnchor = (next: Date) => {
    if (mode === "week") {
      const yyyy = next.getUTCFullYear();
      const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(next.getUTCDate()).padStart(2, "0");
      patchParams({ week: `${yyyy}-${mm}-${dd}` });
    } else {
      const yyyy = next.getFullYear();
      const mm = String(next.getMonth() + 1).padStart(2, "0");
      patchParams({ month: `${yyyy}-${mm}` });
    }
  };
  const [dayModalIso, setDayModalIso] = useState<string | null>(null);
  const barHoverState = useRafCoalescedHover<{
    project: CalendarProject;
    x: number;
    y: number;
  }>();
  const taskHoverState = useRafCoalescedHover<{
    task: CalendarTask;
    x: number;
    y: number;
  }>();
  const barHover = barHoverState.hover;
  const taskHover = taskHoverState.hover;
  const enterBarHover = useCallback(
    (project: CalendarProject, x: number, y: number) => barHoverState.enter({ project, x, y }),
    [barHoverState.enter],
  );
  const moveBarHover = useCallback(
    (project: CalendarProject, x: number, y: number) => barHoverState.move({ project, x, y }),
    [barHoverState.move],
  );
  const leaveBarHover = barHoverState.leave;
  const enterTaskHover = useCallback(
    (task: CalendarTask, x: number, y: number) => taskHoverState.enter({ task, x, y }),
    [taskHoverState.enter],
  );
  const moveTaskHover = useCallback(
    (task: CalendarTask, x: number, y: number) => taskHoverState.move({ task, x, y }),
    [taskHoverState.move],
  );
  const leaveTaskHover = taskHoverState.leave;

  const gridRef = useRef<HTMLDivElement>(null);
  const wheelTsRef = useRef(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const setAnchorRef = useRef(setAnchor);
  setAnchorRef.current = setAnchor;
  useEffect(() => {
    const el = gridRef.current;
    if (!el || mode !== "month") return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".cal-bar,[data-cal-content]")) return;
      /* Owner 2026-07-16 — never hijack the wheel while the page can still
         scroll in that direction. Owner 2026-07-23 — but the flip must SURVIVE
         a scrollable page: 6c29e5cc (always expand all bars) made the grid
         overflow the viewport on any busy month, which turned the old
         "scrollable ⇒ never flip" guard into a permanent kill-switch — the
         tip kept promising a scroll-to-change-month that could never fire.
         Boundary rule instead: wheeling over blank space flips the month only
         at the edge being pushed past (down at the bottom, up at the top);
         mid-scroll the page scrolls normally. An empty short calendar is at
         both edges at once, which is exactly the pre-expand behaviour. */
      const scroller = el.closest("main");
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
        const atTop = scroller.scrollTop <= 1;
        const atBottom =
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        if (e.deltaY > 0 ? !atBottom : !atTop) return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - wheelTsRef.current < 380) return;
      wheelTsRef.current = now;
      const d = new Date(anchorRef.current);
      d.setMonth(d.getMonth() + (e.deltaY > 0 ? 1 : -1));
      setAnchorRef.current(d);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode]);

  const [availH, setAvailH] = useState<number | null>(null);
  useEffect(() => {
    if (mode !== "month") {
      setAvailH(null);
      return;
    }
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setAvailH(Math.max(440, Math.round(window.innerHeight - top - 14)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mode, anchor]);

  const setMode = (next: "month" | "week") => {
    if (next === "week" && !weekStartStr) {
      const d = new Date(todayMyt() + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      patchParams({ mode: next, week: `${yyyy}-${mm}-${dd}` });
    } else {
      patchParams({ mode: next === "month" ? "" : next });
    }
  };

  const q = useQuery<{ projects: CalendarProject[]; tasks: CalendarTask[] }>("/api/projects/calendar/events?from=:&to=:",
    () => api.get(`/api/projects/calendar/events?from=${fromStr}&to=${toStr}`),
    [fromStr, toStr]
  );

  const allProjects = q.data?.projects ?? EMPTY_CALENDAR_PROJECTS;
  const allTasks = q.data?.tasks ?? EMPTY_CALENDAR_TASKS;
  const anchorMonth = anchor.getMonth();
  const calendarModel = useMemo(
    () =>
      buildProjectsCalendarModel({
        allProjects,
        allTasks,
        cells,
        weekCount,
        mode,
        anchorMonth,
        brand,
        status,
        organizer,
        q: search,
        showTasks,
        expandAll,
      }),
    [
      allProjects,
      allTasks,
      cells,
      weekCount,
      mode,
      anchorMonth,
      brand,
      status,
      organizer,
      search,
      showTasks,
      expandAll,
    ],
  );
  const {
    projects,
    tasks,
    tasksByDate,
    weekSegs,
    overflowByCell,
    barsAreaHByWeek,
    cellBarsH,
    renderedWeeks,
  } = calendarModel;

  const monthLabel = anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const periodLabel =
    mode === "week"
      ? (() => {
          const start = startDay;
          const end = new Date(startDay);
          end.setUTCDate(start.getUTCDate() + 6);
          const fmt = (d: Date) =>
            d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
          const yearSuffix = end.getUTCFullYear();
          return `${fmt(start)} – ${fmt(end)} ${yearSuffix}`;
        })()
      : monthLabel;
  const today = todayInAppTz();

  // All-dates search (owner 2026-11-10): Previous / Next match jump the view to
  // the month (or week) of a matching event, wherever it is, and flash its bar.
  const searchState = useCalendarSearch({ q: search, brand, status, organizer }, true);
  const matches = searchState.result?.matches ?? EMPTY_MATCHES;
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);
  const period =
    mode === "week" ? { start: fromStr, end: toStr } : monthPeriod(anchor.getFullYear(), anchor.getMonth());
  const adjacent = (direction: "next" | "prev") =>
    pickAdjacentMatch({ matches, focusedId, periodStart: period.start, periodEnd: period.end, direction });
  const prevMatch = adjacent("prev");
  const nextMatch = adjacent("next");
  const jumpTo = (m: CalendarMatch) => {
    const start = matchStart(m);
    if (mode === "week") patchParams({ week: weekStartOf(start) });
    else patchParams({ month: start.slice(0, 7) });
    setFocusedId(m.id);
    setFlash((f) => ({ id: m.id, n: (f?.n ?? 0) + 1 }));
  };
  const [enterPending, setEnterPending] = useState(false);
  useEffect(() => {
    if (!enterPending || searchState.loading) return;
    setEnterPending(false);
    if (nextMatch) jumpTo(nextMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per Enter, when the result settles
  }, [enterPending, searchState.loading]);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 3000);
    return () => window.clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (!flash) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cal-project="${flash.id}"]`);
    if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flash, allProjects]);
  const noMatches = searchState.result?.total === 0;

  const BAR_H = CALENDAR_BAR_H;
  const LANE_TOTAL = CALENDAR_LANE_TOTAL;
  const BAR_TOP_OFFSET = mode === "week" ? 52 : 24;
  const MAX_LANES = mode === "week" || expandAll ? Infinity : 3;
  const BAR_TOP_OFFSET_M = 24;
  const COMPACT_ROW_MIN =
    BAR_TOP_OFFSET_M +
    3 * 21 +
    16 +
    (showTasks ? 70 : 8);
  const compactRowH =
    mode === "month" && !expandAll
      ? Math.max(
          COMPACT_ROW_MIN,
          availH ? Math.floor((availH - 34) / Math.max(renderedWeeks, 1)) : COMPACT_ROW_MIN,
        )
      : null;
  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Calendar"
        dense
      />

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            const d = new Date(anchor);
            if (mode === "week") d.setUTCDate(d.getUTCDate() - 7);
            else d.setMonth(d.getMonth() - 1);
            setAnchor(d);
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary"
          title={mode === "week" ? "Previous week" : "Previous month"}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={() => {
            const today = todayMyt();
            if (mode === "week") {
              const d = new Date(today + "T00:00:00Z");
              d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
              setAnchor(d);
            } else {
              setAnchor(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1));
            }
          }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary"
        >
          Today
        </button>
        <button
          onClick={() => {
            const d = new Date(anchor);
            if (mode === "week") d.setUTCDate(d.getUTCDate() + 7);
            else d.setMonth(d.getMonth() + 1);
            setAnchor(d);
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary"
          title={mode === "week" ? "Next week" : "Next month"}
        >
          <ChevronRight size={16} />
        </button>
        <span className="ml-2 font-display text-[15px] font-bold leading-tight tracking-tight text-ink">{periodLabel}</span>

        <div className="ml-3 inline-flex overflow-hidden rounded-md border border-border">
          {(["month", "week"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "px-3 py-1.5 text-[11px] font-semibold transition-colors",
                // Theme C: petrol is the FUNCTIONAL accent (active states);
                // brass is brand-only (owner 2026-07-23 calendar pass).
                mode === m
                  ? "bg-primary text-white"
                  : "bg-surface text-ink-secondary hover:bg-bg/50",
              )}
            >
              {m === "month" ? "Month" : "Week"}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Free-text search (owner 2026-07-20) — live-filters bars + task
              chips; URL-persisted (?q=). */}
          <label className="relative inline-flex h-8 items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-ink-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                setEnterPending(true);
              }}
              placeholder="Search venue, organizer, brand…"
              className="h-8 w-56 rounded-md border border-border bg-surface pl-7 pr-6 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
              title="Search events on the calendar"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-bg/50 hover:text-ink"
                title="Clear search"
              >
                <X size={11} />
              </button>
            )}
          </label>
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-7 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
            title="Filter by brand"
          >
            <option value="">All brands</option>
            {(brandsQ.data?.data ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <span className="relative inline-flex">
          <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-7 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
              title="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="pending">Pending</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
          </span>
          <span className="relative inline-flex">
          <select
              value={organizer}
              onChange={(e) => setOrganizer(e.target.value)}
              className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-7 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
              title="Filter by organizer"
            >
              <option value="">All organizers</option>
              {(organizersQ.data?.data ?? []).map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
          </span>
          <ResetFiltersButton
            active={!!(brand || status || organizer || params.get("stage"))}
            onReset={() => {
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  ["brand", "status", "organizer", "stage"].forEach((k) =>
                    next.delete(k)
                  );
                  return next;
                },
                { replace: true }
              );
            }}
          />
          {/* Tasks toggle button removed 2026-07-20 per owner request
              ("remove button task"). Task chips still render when the
              projects:cal:showTasks localStorage pref is true (default false);
              a one-line re-add of this <button> restores the toggle if needed. */}
          <button
            onClick={() => setShowHolidays(!showHolidays)}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
              showHolidays
                ? "border-primary/40 bg-primary-soft text-primary-ink"
                : "border-border bg-surface text-ink-muted hover:text-ink"
            )}
            title="Show Malaysian federal public holidays"
          >
            {showHolidays ? <Check size={12} /> : <Circle size={12} />} MY Holidays
          </button>
          {(brand || status || organizer) && (
            <button
              onClick={() => {
                setBrand("");
                setStatus("");
                setOrganizer("");
              }}
              className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[12px]">
        {STATUS_OPTIONS.map((s) => (
          <span key={s.value} className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: s.hex }}
            />
            <span className="text-ink-muted">{s.label}</span>
          </span>
        ))}
        {mode === "month" && (
          <span className="ml-auto text-[10.5px] text-ink-muted">
            Tip: scroll over empty space to change month
          </span>
        )}
      </div>

      {searchState.active && (
        <CalendarSearchStrip
          label={search.trim() ? `'${search.trim()}'` : "the filters"}
          result={searchState.result}
          loading={searchState.loading}
          error={searchState.error}
          prev={prevMatch}
          next={nextMatch}
          focusedId={focusedId}
          onJump={jumpTo}
        />
      )}

      {q.loading && <div className="text-[12px] text-ink-muted">Loading calendar…</div>}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {q.error}
        </div>
      )}

      <div hidden={noMatches}>
        <div ref={gridRef} className="rounded-md border border-border bg-surface">
        {mode === "month" && (
          <div className="grid shrink-0 grid-cols-7 border-b border-border bg-bg/60">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div
                key={d}
                className="px-2 py-1.5 text-[12.5px] font-semibold uppercase tracking-wider text-ink-muted"
              >
                {d}
              </div>
            ))}
          </div>
        )}
        {Array.from({ length: weekCount }).map((_, w) => {
          if (
            mode === "month" &&
            !Array.from({ length: 7 }).some(
              (_, d) => cells[w * 7 + d].date.getUTCMonth() === anchor.getMonth()
            )
          ) {
            return null;
          }
          const segs = weekSegs[w];
          const barsAreaH = barsAreaHByWeek[w];
          const rowMinHeight =
            mode === "week"
              ? BAR_TOP_OFFSET + barsAreaH + (showTasks ? 320 : 90)
              : expandAll
                ? BAR_TOP_OFFSET + barsAreaH + (showTasks ? 40 : 8)
                : 96;
          return (
            <div
              key={w}
              className="relative grid grid-cols-7"
              style={
                compactRowH != null
                  ? { height: compactRowH }
                  : { minHeight: rowMinHeight }
              }
            >
              {Array.from({ length: 7 }).map((_, d) => {
                const idx = w * 7 + d;
                const cell = cells[idx];
                const inMonth =
                  mode === "week"
                    ? true
                    : cell.date.getUTCMonth() === anchor.getMonth();
                const cellTasks = tasksByDate.get(cell.iso) ?? [];
                const isToday = cell.iso === today;
                const holidays = showHolidays ? getHolidaysOn(cell.iso) : [];
                const isHolidayCell = holidays.length > 0;
                const overflow = overflowByCell[idx];
                const weekHeaderLabel =
                  mode === "week"
                    ? `${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][cell.date.getUTCDay()]}. ${String(cell.date.getUTCDate()).padStart(2, "0")}/${String(cell.date.getUTCMonth() + 1).padStart(2, "0")}`
                    : null;
                if (mode === "month" && !inMonth) {
                  return (
                    <div
                      key={idx}
                      className="border-b border-r border-border bg-surface-dim/25"
                    />
                  );
                }
                return (
                  <div
                    key={idx}
                    className={cn(
                      "relative border-b border-r border-border text-[10px]",
                      mode === "week"
                        ? "px-2 py-2"
                        : expandAll
                          ? "px-1.5 py-1"
                          : "flex flex-col overflow-hidden px-1.5 py-1",
                      !inMonth && "bg-bg/40 text-ink-muted",
                      isHolidayCell && inMonth && "bg-[color:var(--hz-dk-surface-2,#e7e8f5)]",
                      mode === "month" && isToday && "bg-accent-soft/50 ring-1 ring-inset ring-accent/50",
                    )}
                    data-cal-content={
                      mode === "month" &&
                      (cellBarsH[idx] > 0 || cellTasks.length > 0 || isHolidayCell)
                        ? ""
                        : undefined
                    }
                  >
                    {mode === "week" ? (
                      <div className="mb-1.5 flex items-center justify-center">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold",
                            isToday
                              ? "bg-primary text-white"
                              : "text-ink-secondary",
                          )}
                        >
                          {weekHeaderLabel}
                        </span>
                        {cellTasks.length > 0 && (
                          <DayCountBadge
                            count={cellTasks.length}
                            overdue={cellTasks.some((t) => t.is_overdue)}
                            className="ml-1"
                          />
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {isToday ? (
                          <span className="inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[13px] font-bold text-white">
                            {cell.date.getUTCDate()}
                          </span>
                        ) : (
                          <span className="shrink-0 text-[14px] font-semibold text-ink">
                            {cell.date.getUTCDate()}
                          </span>
                        )}
                        {isHolidayCell && (
                          <span
                            className="min-w-0 truncate rounded bg-[#bcc0e6] px-1.5 py-0.5 text-[9.5px] font-semibold text-[#2b3063]"
                            title={holidays.map((h) => h.name).join(", ")}
                          >
                            {holidays[0].name}
                            {holidays.length > 1 && ` +${holidays.length - 1}`}
                          </span>
                        )}
                      </div>
                    )}

                    <div
                      className="shrink-0"
                      style={{
                        height:
                          mode === "week" || expandAll
                            ? cellBarsH[idx]
                            : MAX_LANES * LANE_TOTAL,
                      }}
                      aria-hidden
                    />

                    {mode === "month" && overflow > 0 && (
                      <button
                        type="button"
                        data-cal-content
                        onClick={(e) => {
                          e.stopPropagation();
                          setDayModalIso(cell.iso);
                        }}
                        className="block w-full pr-0.5 text-right text-[9px] font-semibold text-accent hover:underline"
                        title="Show every project + task on this day"
                      >
                        +{overflow} more
                      </button>
                    )}

                    {cellTasks.length > 0 && (
                      <div
                        data-cal-content
                        className={cn(
                          "space-y-0.5 border-t border-border-subtle pt-1",
                          mode === "month" && !expandAll
                            ? "absolute inset-x-1.5 bottom-1 z-20 bg-inherit"
                            : "mt-1",
                        )}
                      >
                        {(mode === "week" || expandAll ? cellTasks : cellTasks.slice(0, 2)).map((t) => (
                          <CalendarTaskChip
                            key={t.id}
                            task={t}
                            onOpen={() => navigate(`/projects/${t.project_id}`)}
                            onHover={(e) => enterTaskHover(t, e.clientX, e.clientY)}
                            onMove={(e) => moveTaskHover(t, e.clientX, e.clientY)}
                            onLeave={leaveTaskHover}
                          />
                        ))}
                        {mode === "month" && !expandAll && cellTasks.length > 2 && (
                          <button
                            onClick={() => setDayModalIso(cell.iso)}
                            title={cellTasks
                              .slice(2)
                              .map((t) => `${t.project_code}: ${t.title}`)
                              .join("\n")}
                            className="block text-[9px] font-semibold text-accent hover:underline"
                          >
                            +{cellTasks.length - 2} more
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div
                className="pointer-events-none absolute left-0 right-0 z-10"
                style={{ top: BAR_TOP_OFFSET }}
                aria-hidden={false}
              >
                {segs.map((seg) => {
                  const span = seg.endCol - seg.startCol + 1;
                  const leftPct = (seg.startCol / 7) * 100;
                  const widthPct = (span / 7) * 100;
                  return (
                    <button
                      key={`${w}-${seg.project.id}-${seg.startCol}`}
                      data-cal-project={seg.project.id}
                      onClick={() => navigate(`/projects/${seg.project.id}`)}
                      onMouseEnter={(e) =>
                        enterBarHover(seg.project, e.clientX, e.clientY)
                      }
                      onMouseMove={(e) =>
                        moveBarHover(seg.project, e.clientX, e.clientY)
                      }
                      onMouseLeave={leaveBarHover}
                      style={{
                        position: "absolute",
                        left: `calc(${leftPct}% + 4px)`,
                        width: `calc(${widthPct}% - 8px)`,
                        top: seg.lane * LANE_TOTAL,
                        height: BAR_H,
                        ...statusBarStyle(seg.project.status),
                      }}
                      className={cn(
                        "cal-bar pointer-events-auto truncate px-2 text-left text-[10.5px] font-semibold leading-[18px] hover:-translate-y-px",
                        flash?.id === seg.project.id && "z-20 animate-pulse ring-2 ring-accent ring-offset-1",
                        seg.clipLeft ? "rounded-l-none" : "rounded-l-md",
                        seg.clipRight ? "rounded-r-none" : "rounded-r-md"
                      )}
                    >
                      {upcaseLeadingState(
                        (seg.project.event_type_name || "").toLowerCase() === "solo"
                          ? composeDefaultProjectName({
                              state: seg.project.state,
                              brand: seg.project.brand,
                              // Bars always say SOLO (owner 2026-08-19); organizer
                              // stays in the field / lists / stored names (08-17 rule).
                              organizer: null,
                              venue: seg.project.venue,
                              event_type_slug: "solo",
                            })
                          : seg.project.name,
                        seg.project.state,
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {dayModalIso && (
        <CalendarDayModal
          iso={dayModalIso}
          projects={projects.filter((p) => {
            const s = p.start_date.slice(0, 10);
            const e = (p.end_date || p.start_date).slice(0, 10);
            return s <= dayModalIso && e >= dayModalIso;
          })}
          tasks={tasksByDate.get(dayModalIso) ?? []}
          holidays={showHolidays ? getHolidaysOn(dayModalIso) : []}
          onClose={() => setDayModalIso(null)}
          onOpenProject={(id) => {
            setDayModalIso(null);
            navigate(`/projects/${id}`);
          }}
        />
      )}

      {barHover && <CalendarBarPopover info={barHover} />}
      {taskHover && <CalendarTaskPopover info={taskHover} />}

    </div>
  );
}
