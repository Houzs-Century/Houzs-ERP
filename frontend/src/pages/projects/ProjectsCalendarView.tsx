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

const PROJECTS_CALENDAR_FILTER_KEYS = [
  "brand",
  "stage",
  "organizer",
  "month",
  // 2026-05-08 — week view toggle. `mode=week` swaps the 6×7 month
  // grid for a single 1×7 row anchored on `week` (Sunday ISO date).
  "mode",
  "week",
  // 2026-05-15 — `section` replaces the legacy `stage` filter (the
  // tasklist sections are the new stages). `stage` stays in the keys
  // list so old bookmarks parse without throwing.
  "section",
  // 2026-07-20 — free-text search (venue/organizer/brand/code/title).
  "q",
] as const;

export function ProjectsCalendarView() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters(
    "projects-calendar",
    PROJECTS_CALENDAR_FILTER_KEYS
  );
  const brand = params.get("brand") || "";
  const status = params.get("status") || "";
  const organizer = params.get("organizer") || "";
  // 2026-07-20 — free-text search. Named `search` (not `q`) to avoid a
  // collision with the useQuery result later in this component that already
  // owns the identifier `q`. URL key stays "q" for a short, shareable URL.
  const search = params.get("q") || "";
  // anchor lives in URL as `month=YYYY-MM` so a refresh / shared link
  // lands on the same month.
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

  // showTasks / showHolidays are personal display prefs (checkbox toggles
  // on the legend, not data filters), so they stay in localStorage per
  // CLAUDE.md's URL-state convention.
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
  // Active template's sections, mirroring the list-view pill row.
  const sectionsListQ = useQuery<{ data: string[] }>("/api/projects/sections-distinct", () =>
    api.get("/api/projects/sections-distinct")
  );
  // ?mode=week swaps the 6×7 month grid for a single 1×7 row anchored
  // on `?week=YYYY-MM-DD` (Sunday). `?month=YYYY-MM` is the existing
  // monthly anchor; both URL params persist via stickyFilters.
  const mode: CalendarMode =
    params.get("mode") === "week" ? "week" : "month";
  const monthStr = params.get("month") || "";
  const weekStartStr = params.get("week") || "";

  // Stable across hover/popover renders: new Date objects here used to
  // invalidate every downstream calendar projection on each mousemove.
  const calendarWindow = useMemo(
    () => buildCalendarWindow(mode, monthStr, weekStartStr),
    [mode, monthStr, weekStartStr],
  );
  const { anchor, startDay, endDay, cells, weekCount, totalCells, fromStr, toStr } = calendarWindow;

  const setAnchor = (next: Date) => {
    if (mode === "week") {
      // Save the Monday ISO date.
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
  // Day modal — opened by month-view "+N more" expanders to surface every
  // project / task that lands on a single day without forcing a switch to
  // week mode. Previously these expanders called expandToWeekForCell()
  // which navigated the whole view; ops asked for a lighter overlay.
  const [dayModalIso, setDayModalIso] = useState<string | null>(null);
  // Hover popover — replaces the native bar `title` tooltip with a
  // styled card carrying the project's basic info (code, brand, venue,
  // span, organizer, stage). Anchored to the cursor; cleared on leave.
  // Mousemove can fire hundreds of times per second. Keep entry/exit immediate,
  // but coalesce cursor-position updates to one React state update per frame.
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

  // Wheel-over-grid navigates months (month mode). Refs keep the handler
  // reading the latest anchor/setAnchor without re-binding the listener;
  // a timestamp throttles to one month per gesture. Non-passive so we can
  // preventDefault and stop the page scrolling under the cursor.
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
      // Only flip months when scrolling over BLANK calendar space (e.g. the
      // empty leading cells, or a day with no items). Over a project bar, task
      // chip, or a "+N more" link the page scrolls normally — so Expand all can
      // still be scrolled by dragging over its content. Works in both modes.
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

  // Month grid fills from its top to the viewport bottom, so the 5–6 week
  // rows share that height EQUALLY (uniform rows, no tiny empty week, no
  // dead gap at the bottom). Re-measured on resize / month change since the
  // grid's top is fixed by the header+toolbar+legend above it.
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
    // When flipping to week mode for the first time, snap the week
    // anchor to the Monday of "today" so the user lands on the
    // current week instead of an unrelated one.
    if (next === "week" && !weekStartStr) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      patchParams({ mode: next, week: `${yyyy}-${mm}-${dd}` });
    } else {
      patchParams({ mode: next === "month" ? "" : next });
    }
  };

  // Window: month = 6 weeks (42 cells) from the first Monday on/before
  // the 1st; week = 1 week (7 cells) from the week anchor.
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

  // Calendar header shows the full month name (owner request 2026-07):
  // "November 2025", not "11/2025". Row/cell dates stay numeric elsewhere.
  const monthLabel = anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  // Period label for the calendar header. Month → "April 2026"; week
  // → "06 Apr – 12 Apr 2026" so the user knows the exact window.
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

  // Per-week lane-packing. Each project that overlaps a week becomes a
  // single segment for that week (clipped to the visible Sun..Sat range)
  // with a lane index. Segments are rendered as absolutely-positioned
  // bars overlaid on the week row, so a multi-day project shows as ONE
  // continuous bar from start to end with the project name on it — not
  // a chain of per-cell pills. Bars wrap at week boundaries; the
  // clipLeft/clipRight flags drive the rounded-corner + chevron hint.
  // Layout constants for the per-week bar overlay. BAR_TOP_OFFSET puts the
  // bars below the day-number row; week mode's pill header needs a bigger one.
  const BAR_H = CALENDAR_BAR_H;
  const LANE_TOTAL = CALENDAR_LANE_TOTAL;
  const BAR_TOP_OFFSET = mode === "week" ? 52 : 24;
  // Compact month shows up to 3 project-event lanes per cell; extra bars fold
  // into "+N more". Tasks render separately (2 rows, pinned to the bottom).
  // Week mode + expand-all never cap — they show everything inline.
  const MAX_LANES = mode === "week" || expandAll ? Infinity : 3;
  // Compact month: every row is the SAME height — tall enough for 3 bars + 2
  // task rows (COMPACT_ROW_MIN), but stretched to fill the viewport when
  // there's room. If the month needs more than the viewport, the page scrolls
  // (and the wheel-to-change-month is disabled so scrolling works normally).
  const BAR_TOP_OFFSET_M = 24;
  const COMPACT_ROW_MIN =
    BAR_TOP_OFFSET_M +
    3 * 21 /* 3 bar lanes */ +
    16 /* project "+N more" line */ +
    (showTasks ? 70 : 8) /* 2 task rows when tasks shown, else just padding */;
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
            if (mode === "week") {
              const d = new Date();
              d.setUTCHours(0, 0, 0, 0);
              d.setUTCDate(d.getUTCDate() - d.getUTCDay());
              setAnchor(d);
            } else {
              const d = new Date();
              d.setDate(1);
              setAnchor(d);
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

        {/* Month / Week toggle */}
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

        {/* Filters */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Free-text search (owner 2026-07-20) — live-filters bars + task
              chips; URL-persisted (?q=). */}
          <label className="relative inline-flex h-8 items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-ink-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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
              // Functional form so the latest URL state is read at call
              // time rather than the closure-captured `params` snapshot
              // — avoids losing later deletes when React re-renders
              // between paint and click. Also clears legacy `stage` key
              // that mig-050 retired but still sits in some sticky
              // storage entries.
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

      {/* Status legend — bars are tinted by project status (mig 088). */}
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

      {q.loading && <div className="text-[12px] text-ink-muted">Loading calendar…</div>}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {q.error}
        </div>
      )}

      {/* The grid always fits its container: the 7 day columns shrink to
          the viewport width on mobile rather than scrolling horizontally. */}
      <div>
        <div ref={gridRef} className="rounded-md border border-border bg-surface">
        {/* Weekday header — month view only. In week view each cell
            renders its own "Day. DD/MM" header with a today pill, so
            this row would be redundant. */}
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
        {/* 6 week rows. Each row is a relative grid so an absolute bar
            overlay can paint a single continuous pill from start col to
            end col on top of the day cells. */}
        {Array.from({ length: weekCount }).map((_, w) => {
          // Month mode shows only the current month's weeks — a week whose
          // every cell falls in an adjacent month is dropped entirely.
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
          // Compact month: every row is the SAME fixed height (compactRowH) —
          // an empty week (29/30) matches a busy one, and the height always
          // fits 3 bars + 2 task rows so they never overlap. Week / expand-all:
          // content-driven min-height so every bar + task shows inline.
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
                // In week mode every cell is part of the active
                // window, so don't grey-out anything.
                const inMonth =
                  mode === "week"
                    ? true
                    : cell.date.getUTCMonth() === anchor.getMonth();
                const cellTasks = tasksByDate.get(cell.iso) ?? [];
                const isToday = cell.iso === today;
                const holidays = showHolidays ? getHolidaysOn(cell.iso) : [];
                const isHolidayCell = holidays.length > 0;
                const overflow = overflowByCell[idx];
                // Week-view per-day header label: "Su. 03/05".
                const weekHeaderLabel =
                  mode === "week"
                    ? `${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][cell.date.getUTCDay()]}. ${String(cell.date.getUTCDate()).padStart(2, "0")}/${String(cell.date.getUTCMonth() + 1).padStart(2, "0")}`
                    : null;
                // Adjacent-month cells render blank — only the current
                // month's dates carry content.
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
                      isHolidayCell && inMonth && "bg-[#e7e8f5]",
                      // Today highlight only on month view; week view
                      // moves the highlight onto the header pill so
                      // the cell body stays neutral. A brass inset ring +
                      // stronger tint makes today unmistakable.
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
                      // Week-mode header: centred "Day. DD/MM" with a
                      // filled accent pill on today's column.
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
                        {/* Holiday marker sits right beside the date (deeper
                            tint than before so it reads at a glance). */}
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

                    {/* Reserved vertical space for the absolute bar overlay so
                        cell content (holiday + tasks) sits below this cell's
                        own bars. Month caps at the visible-lane count so the
                        overflowing bars don't reserve space ("+N more" instead). */}
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

                    {/* Bar overflow — month mode only (week mode has
                        unlimited lanes). Clicking expands the cell's
                        week into week view, showing every bar inline
                        without a popover. Old popover behaviour removed
                        per the team's request. */}
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
                          // Compact month: pin tasks to the cell bottom so every
                          // cell's tasks line up on the last rows regardless of
                          // how many bars (or a "+N more") sit above.
                          mode === "month" && !expandAll
                            ? "absolute inset-x-1.5 bottom-1 z-20 bg-inherit"
                            : "mt-1",
                        )}
                      >
                        {/* Week mode shows every task — there's room.
                            Month mode keeps a 2-task cap + "+N more"
                            expander since cells are tighter. */}
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

              {/* Bar overlay — one absolutely-positioned pill per
                  segment, spanning startCol..endCol. Pointer events
                  pass through the wrapper so the underlying cells stay
                  clickable; the bars themselves opt back in. */}
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
