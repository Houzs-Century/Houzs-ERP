import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { getHolidaysOn } from "../lib/holidays";
import { useBranding } from "../hooks/useBranding";
import { useIdleSessionFilter } from "../hooks/useIdleSessionFilter";
import { HOUZS_COMPANY_CODE, shortCompanyName } from "../lib/branding";
import { compareCalendarEvents } from "../lib/calendarSort";
import { todayMyt } from "../vendor/scm/lib/dates";
import { projectMatchesCalendarFilters } from "../pages/projects/calendarModel";
import { CalendarSearchStrip, useCalendarSearch } from "../pages/projects/CalendarSearchStrip";
import { type CalendarMatch, matchStart, monthPeriod, pickAdjacentMatch } from "../pages/projects/calendarSearch";
import "./mobile.css";


type CalProject = {
  id: number;
  code: string | null;
  name: string;
  stage: string | null;
  status: string | null;
  brand: string | null;
  organizer: string | null;
  start_date: string;
  end_date: string | null;
  venue: string | null;
  state: string | null;
  active_section_name: string | null;
  sections_total: number | null;
  event_type_name: string | null;
};

type CalTask = {
  id: number;
  project_id: number;
  project_code: string | null;
  project_name: string | null;
  brand: string | null;
  organizer: string | null;
  title: string;
  due_date: string;
  status: string | null;
  project_status: string | null;
  owner_name: string | null;
  is_overdue: number | null;
};

type CalEvent = {
  key: string;
  kind: "project" | "task" | "holiday";
  projectId: number;
  date: string;
  label: string;
  barLabel: string;
  color: string;
  brand: string | null;
  section: string | null;
  organizer: string | null;
  status: string | null;
  sub: string | null;
  state: string | null;
  venue: string | null;
  overdue?: boolean;
  dot?: string;
  initials?: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

const STATUS_COLOR: Record<string, string> = {
  confirmed: "#2f8a5b",
  pending: "#cf9a2e",
  cancelled: "#b23a3a",
};
const TASK_COLOR = "#a16a2e";
const HOLIDAY_COLOR = "#7a5c86";
const statusColor = (s: string | null) => STATUS_COLOR[(s ?? "").toLowerCase()] ?? "#5a6b7a";
const OVERDUE_COLOR = "#b23a3a";

const ownerInitials = (name: string | null): string =>
  (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();

function composeDefaultProjectName(p: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  eventTypeSlug?: string | null;
}): string {
  const state = (p.state || "").trim();
  const brand = (p.brand || "").trim();
  const organizer = (p.organizer || "").trim();
  const venue = (p.venue || "").trim();
  const isSolo = (p.eventTypeSlug || "").toLowerCase() === "solo";
  const orgSlot = isSolo ? "SOLO" : organizer;
  const head: string[] = [];
  // State leads UPPERCASE (owner 2026-07-24) — states are now stored Title Case
  // but the bar convention is all-caps, matching non-solo names. Same as desktop.
  if (state) head.push(state.toUpperCase());
  if (brand) head.push(`[${brand}]`);
  if (orgSlot) head.push(orgSlot);
  const left = head.join(" ");
  if (!venue) return left;
  if (!left) return `@ ${venue}`;
  return `${left} @ ${venue}`;
}

// Event bars show the STATE in all-caps (owner 2026-07-29). Newer stored names
// lead with a Title-Case state ("Kuala Lumpur"), so uppercase that leading
// state on render. No-op when the name doesn't begin with the state. Mirrors
// pages/Projects.tsx upcaseLeadingState so the two surfaces read identically.
function upcaseLeadingState(name: string, state?: string | null): string {
  const s = (state || "").trim();
  if (s && name.toLowerCase().startsWith(s.toLowerCase())) {
    return s.toUpperCase() + name.slice(s.length);
  }
  return name;
}

function projectBarLabel(p: CalProject): string {
  const raw =
    (p.event_type_name || "").toLowerCase() === "solo"
      ? composeDefaultProjectName({
          state: p.state,
          brand: p.brand,
          organizer: p.organizer,
          venue: p.venue,
          eventTypeSlug: "solo",
        })
      : p.name;
  return upcaseLeadingState(raw, p.state);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const dayOf = (d: string) => Number(d.slice(8, 10));
const ddmmyyyy = (y: number, m: number, d: number) => `${pad(d)}/${pad(m + 1)}/${y}`;

function monthWeeks(y: number, m: number): (number | null)[][] {
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function MobileCalendar({
  onOpenProject,
  onOpenSearch,
  initialYear,
  initialMonth,
  focusProjectId,
}: {
  onOpenProject?: (projectId: number) => void;
  onOpenSearch?: () => void;
  initialYear?: number;
  initialMonth?: number;
  focusProjectId?: number;
} = {}) {
  const todayIso = todayMyt();
  const today = { year: Number(todayIso.slice(0, 4)), month: Number(todayIso.slice(5, 7)) - 1, day: Number(todayIso.slice(8, 10)) };

  const { pageAccess } = useAuth();
  const canViewCalendar = pageAccess("projects.calendar") !== "none";
  const branding = useBranding();
  const isHouzsBrand = branding.companyCode === HOUZS_COMPANY_CODE;
  const brandWords = shortCompanyName(branding.companyName).split(/\s+/).filter(Boolean);
  const brandMark = isHouzsBrand ? "HOUZS" : (brandWords[0] ?? "").toUpperCase();
  const brandEyebrow = isHouzsBrand
    ? "CENTURY · ERP"
    : (brandWords.length > 1 ? `${brandWords.slice(1).join(" ")} · ERP` : "ERP").toUpperCase();

  const [year, setYear] = useState(initialYear ?? today.year);
  const [month, setMonth] = useState(initialMonth ?? today.month);
  const [mode, setMode] = useState<"month" | "week">("month");
  // Owner 2026-09-30: the calendar filter must survive going into a project and
  // back, clearing only on logout or after an hour untouched — same rule as the
  // desktop calendar. These are plain state (not URL params), so they persist
  // through useIdleSessionFilter rather than useStickyFilters.
  const [calFilter, patchCalFilter] = useIdleSessionFilter(
    "mobile-calendar",
    { brand: "all", section: "all", org: "all", q: "" },
    60 * 60 * 1000,
  );
  const brandF = calFilter.brand;
  const sectionF = calFilter.section;
  const orgF = calFilter.org;
  const setBrandF = (v: string) => patchCalFilter({ brand: v });
  const setSectionF = (v: string) => patchCalFilter({ section: v });
  const setOrgF = (v: string) => patchCalFilter({ org: v });
  const searchQ = calFilter.q;
  const setSearchQ = (v: string) => patchCalFilter({ q: v });
  const [showTasks, setShowTasks] = useState(false);
  const [showHolidays, setShowHolidays] = useState(true);
  // Owner 2026-07-23: always expand every week's bars (no cap, no "+N more");
  // the Expand-all toggle was removed. Kept as a const so MonthGrid's prop and
  // the (now-unreachable) overflow handler still type-check.
  const expand = true;
  const [daySheet, setDaySheet] = useState<number | null>(null);

  useEffect(() => {
    if (initialYear != null) setYear(initialYear);
    if (initialMonth != null) setMonth(initialMonth);
    if (initialYear != null || initialMonth != null) setMode("month");
  }, [initialYear, initialMonth]);

  const from = iso(year, month, 1);
  const to = iso(year, month, new Date(year, month + 1, 0).getDate());
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-calendar", from, to],
    queryFn: () =>
      api.get<{ projects: CalProject[]; tasks: CalTask[] }>(
        `/api/projects/calendar/events?from=${from}&to=${to}`
      ),
    staleTime: 30_000,
    enabled: canViewCalendar,
  });
  const projects = data?.projects ?? [];
  const tasks = data?.tasks ?? [];

  const { data: brandsData } = useQuery({
    queryKey: ["mobile-calendar-brands"],
    queryFn: () => api.get<{ data: string[] }>("/api/projects/brands"),
    staleTime: 300_000,
    enabled: canViewCalendar,
  });
  const { data: sectionsData } = useQuery({
    queryKey: ["mobile-calendar-sections"],
    queryFn: () => api.get<{ data: string[] }>("/api/projects/sections-distinct"),
    staleTime: 300_000,
    enabled: canViewCalendar,
  });
  const { data: organizersData } = useQuery({
    queryKey: ["mobile-calendar-organizers"],
    queryFn: () => api.get<{ data: { id: number; name: string }[] }>("/api/projects/organizers"),
    staleTime: 300_000,
    enabled: canViewCalendar,
  });
  const brandOptions = brandsData?.data ?? [];
  const sectionOptions = sectionsData?.data ?? [];
  const orgOptions = useMemo(
    () => uniqueSorted((organizersData?.data ?? []).map((o) => o.name)),
    [organizersData]
  );

  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = [];
    const monthFirst = iso(year, month, 1);
    const lastDom = new Date(year, month + 1, 0).getDate();
    const monthLast = iso(year, month, lastDom);
    const searched = new Set<number>();
    for (const p of projects) {
      if (searchQ.trim() && !projectMatchesCalendarFilters(p, { q: searchQ, brand: "", status: "", organizer: "" })) continue;
      searched.add(p.id);
      const start = p.start_date.slice(0, 10);
      const end = (p.end_date || p.start_date).slice(0, 10);
      if (start > monthLast || end < monthFirst) continue;
      const fromDom = start > monthFirst ? dayOf(start) : 1;
      const toDom = end < monthLast ? dayOf(end) : lastDom;
      for (let dom = fromDom; dom <= toDom; dom++) {
        const date = iso(year, month, dom);
        out.push({
          key: `p-${p.id}-${date}`,
          kind: "project",
          projectId: p.id,
          date,
          label: p.code ? `[${p.brand ?? "—"}] ${upcaseLeadingState(p.name, p.state)}` : upcaseLeadingState(p.name, p.state),
          barLabel: projectBarLabel(p),
          color: statusColor(p.status),
          brand: p.brand,
          section: p.active_section_name,
          organizer: p.organizer,
          status: p.status,
          sub: p.venue || p.state || null,
          state: p.state,
          venue: p.venue,
        });
      }
    }
    if (showTasks) {
      for (const t of tasks) {
        if (searchQ.trim() && !searched.has(t.project_id)) continue;
        out.push({
          key: `t-${t.id}`,
          kind: "task",
          projectId: t.project_id,
          date: t.due_date.slice(0, 10),
          label: `Task · ${t.title}`,
          barLabel: `Task · ${t.title}`,
          color: TASK_COLOR,
          brand: t.brand,
          section: null,
          organizer: t.organizer,
          status: t.status,
          sub: t.project_code || t.project_name || null,
          state: null,
          venue: null,
          overdue: t.is_overdue === 1,
          dot: statusColor(t.project_status),
          initials: ownerInitials(t.owner_name),
        });
      }
    }
    const filtered = out.filter((e) => {
      const d = new Date(e.date);
      if (d.getFullYear() !== year || d.getMonth() !== month) return false;
      if (brandF !== "all" && (e.brand ?? "") !== brandF) return false;
      if (sectionF !== "all" && (e.section ?? "") !== sectionF) return false;
      if (orgF !== "all" && (e.organizer ?? "") !== orgF) return false;
      return true;
    });
    if (showHolidays) {
      const days = new Date(year, month + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        for (const h of getHolidaysOn(iso(year, month, d))) {
          filtered.push({
            key: `h-${h.date}-${h.name}`,
            kind: "holiday",
            projectId: 0,
            date: h.date,
            label: h.name,
            barLabel: h.name,
            color: HOLIDAY_COLOR,
            brand: null,
            section: null,
            organizer: null,
            status: null,
            sub: "Public holiday",
            state: null,
            venue: null,
          });
        }
      }
    }
    return filtered;
  }, [projects, tasks, showTasks, showHolidays, year, month, brandF, sectionF, orgF, searchQ]);

  const byDay = useMemo(() => {
    const map: Record<number, CalEvent[]> = {};
    for (const e of events) {
      const d = dayOf(e.date);
      (map[d] = map[d] || []).push(e);
    }
    // Order each day: holidays first (day context), then project fairs by the
    // shared STATE-first rule (compareCalendarEvents — byte-identical to the
    // desktop calendar), then tasks. Owner 2026-07-20 mobile/desktop parity:
    // before this the mobile day cell rendered events in raw API order while
    // desktop already grouped them, so the two surfaces read differently.
    const kindRank = (k: CalEvent["kind"]) => (k === "holiday" ? 0 : k === "project" ? 1 : 2);
    for (const key of Object.keys(map)) {
      map[Number(key)].sort(
        (a, b) => kindRank(a.kind) - kindRank(b.kind) || compareCalendarEvents(a, b),
      );
    }
    return map;
  }, [events]);

  useEffect(() => {
    if (!focusProjectId) return;
    const p = projects.find((x) => x.id === focusProjectId);
    if (!p) return;
    const d = new Date(p.start_date.slice(0, 10));
    if (d.getFullYear() === year && d.getMonth() === month) {
      setDaySheet(d.getDate());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProjectId, projects, year, month]);

  // All-dates search (owner 2026-11-10): Previous / Next match jump to the month
  // of a matching event wherever it is, and flash its bar. Same logic as desktop.
  const searchState = useCalendarSearch(
    {
      q: searchQ,
      brand: brandF === "all" ? "" : brandF,
      status: "",
      organizer: orgF === "all" ? "" : orgF,
    },
    canViewCalendar,
  );
  const matches = searchState.result?.matches ?? EMPTY_MATCHES;
  const [searchFocusId, setSearchFocusId] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);
  const period = monthPeriod(year, month);
  const adjacent = (direction: "next" | "prev") =>
    pickAdjacentMatch({ matches, focusedId: searchFocusId, periodStart: period.start, periodEnd: period.end, direction });
  const prevMatch = adjacent("prev");
  const nextMatch = adjacent("next");
  const jumpTo = (m: CalendarMatch) => {
    const start = matchStart(m);
    setYear(Number(start.slice(0, 4)));
    setMonth(Number(start.slice(5, 7)) - 1);
    setMode("month");
    setSearchFocusId(m.id);
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
  const gridWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!flash) return;
    const el = gridWrapRef.current?.querySelector<HTMLElement>(`[data-cal-project="${flash.id}"]`);
    if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flash, projects]);
  const noMatches = searchState.result?.total === 0;

  const nav = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const goToday = () => {
    setYear(today.year);
    setMonth(today.month);
    setMode("month");
  };

  const isThisMonth = year === today.year && month === today.month;
  const todayDay = isThisMonth ? today.day : null;
  let weeks = monthWeeks(year, month);
  if (mode === "week") {
    const target = isThisMonth ? today.day : 1;
    weeks = [weeks.find((w) => w.includes(target)) ?? weeks[0]];
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--hz-c-surface)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ lineHeight: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#15161a" }}>{brandMark}</div>
            <div style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: ".28em", color: "var(--brand)", marginTop: 2 }}>{brandEyebrow}</div>
          </div>
          <button
            className="iconbtn"
            onClick={onOpenSearch}
            aria-label="Search"
            title="Search"
            style={{ fontFamily: "inherit" }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          </button>
        </div>
      </header>

      {/* Owner 2026-07-30: 12px → 7px side padding. Every pixel taken off the
          page edge widens all 7 day columns, which is what lets a long event
          name finish on one line inside its bar. */}
      <div className="scroll" style={{ padding: "12px 7px", paddingBottom: 120, background: "var(--hz-c-surface)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
          <button onClick={() => nav(-1)} aria-label="Previous month" className="cal-navbtn">‹</button>
          <button onClick={goToday} className="cal-today">Today</button>
          <button onClick={() => nav(1)} aria-label="Next month" className="cal-navbtn">›</button>
          <div style={{ flex: 1, fontSize: 17, fontWeight: 800, color: "var(--hz-c-ink)", textAlign: "right" }}>{MONTHS[month]} {year}</div>
        </div>

        <div style={{ display: "flex", background: "var(--bg)", border: "1px solid var(--line-card)", borderRadius: 10, padding: 3, marginBottom: 10 }}>
          {(["month", "week"] as const).map((mo) => (
            <button key={mo} onClick={() => setMode(mo)} className={`cal-seg${mode === mo ? " on" : ""}`}>{mo === "month" ? "Month" : "Week"}</button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              setEnterPending(true);
            }}
            enterKeyHint="search"
            placeholder="Search venue, organizer, brand…"
            aria-label="Search events"
            className="cal-sel"
            style={{ cursor: "text" }}
          />
          <select value={brandF} onChange={(e) => setBrandF(e.target.value)} className="cal-sel">
            <option value="all">All brands</option>
            {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <div style={{ display: "flex", gap: 7 }}>
            <select value={sectionF} onChange={(e) => setSectionF(e.target.value)} className="cal-sel" style={{ flex: 1 }}>
              <option value="all">All venues</option>
              {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={orgF} onChange={(e) => setOrgF(e.target.value)} className="cal-sel" style={{ flex: 1 }}>
              <option value="all">All organizers</option>
              {orgOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
          <button onClick={() => setShowTasks((v) => !v)} className={`cal-tog${showTasks ? " on" : ""}`}>{showTasks ? "●" : "○"} Tasks</button>
          <button onClick={() => setShowHolidays((v) => !v)} className={`cal-tog${showHolidays ? " on" : ""}`}>{showHolidays ? "●" : "○"} My holidays</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6, padding: "0 2px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR.confirmed }} />
            <span style={{ fontSize: 11, color: "var(--ink2)" }}>Confirmed</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR.pending }} />
            <span style={{ fontSize: 11, color: "var(--ink2)" }}>Pending</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR.cancelled }} />
            <span style={{ fontSize: 11, color: "var(--ink2)" }}>Cancelled</span>
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 10.5, fontStyle: "italic", color: "var(--mut2)", marginBottom: 8, paddingRight: 2 }}>
          Tip: tap an event for details · use ‹ › to change month
        </div>

        {searchState.active && searchQ.trim() !== "" && (
          <CalendarSearchStrip
            label={`'${searchQ.trim()}'`}
            result={searchState.result}
            loading={searchState.loading}
            error={searchState.error}
            prev={prevMatch}
            next={nextMatch}
            focusedId={searchFocusId}
            onJump={jumpTo}
          />
        )}

        {isLoading && <div style={emptyBox}>Loading…</div>}
        {error && <div style={{ ...emptyBox, color: "var(--red)" }}>Couldn't load the calendar. Pull to retry.</div>}

        {!isLoading && !error && !(noMatches && searchQ.trim()) && (
          <div ref={gridWrapRef}>
            <MonthGrid weeks={weeks} byDay={byDay} expand={expand} onExpandAll={() => {}} onOpenDay={setDaySheet} empty={events.length === 0} onOpen={onOpenProject} focusProjectId={flash?.id ?? focusProjectId} todayDay={todayDay} />
          </div>
        )}
      </div>

      {daySheet != null && (
        <DaySheet
          year={year}
          month={month}
          day={daySheet}
          events={byDay[daySheet] ?? []}
          onClose={() => setDaySheet(null)}
          onOpen={(id) => { setDaySheet(null); onOpenProject?.(id); }}
        />
      )}
    </div>
  );
}

function MonthGrid({ weeks, byDay, expand, onExpandAll, onOpenDay, empty, onOpen, focusProjectId, todayDay }: {
  weeks: (number | null)[][];
  byDay: Record<number, CalEvent[]>;
  expand: boolean;
  onExpandAll: () => void;
  onOpenDay: (day: number) => void;
  empty: boolean;
  onOpen?: (projectId: number) => void;
  focusProjectId?: number;
  todayDay: number | null;
}) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", border: "1px solid var(--line-card)", borderBottom: "none", borderRadius: "8px 8px 0 0", overflow: "hidden" }}>
        {WEEKDAYS.map((w, i) => (
          <div key={w} style={{ padding: "7px 0", textAlign: "center", fontSize: 9, fontWeight: 700, letterSpacing: ".08em", color: "var(--mut)", borderRight: i < 6 ? "1px solid var(--line2)" : "none" }}>{w}</div>
        ))}
      </div>

      {empty && (
        <div className="wk" style={{ borderBottom: "1px solid var(--line-card)", borderRadius: "0 0 8px 8px", padding: "18px 0" }}>
          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)" }}>No events this month.</div>
        </div>
      )}

      {!empty && weeks.map((w, wi) => {
        const last = wi === weeks.length - 1;
        // This week's PROJECT/TASK bars: ONE per fair, placed on the ACTUAL date
        // columns it spans (owner 2026-07-23: full-width bars made every event
        // look like it started Monday). byDay holds a multi-day fair on EVERY day
        // it spans, so we track each project's first..last in-week column and draw
        // the bar across exactly those columns. A fair carried over from the
        // previous week correctly starts at Monday here (it IS ongoing); one
        // starting mid-week starts at its real day. Holidays are a day-cell tint.
        const barMap = new Map<string, { e: CalEvent; startIdx: number; endIdx: number }>();
        w.forEach((d, idx) => {
          if (!d || !byDay[d]) return;
          byDay[d].forEach((e) => {
            if (e.kind === "holiday") return;
            const id = e.kind === "project" ? `p${e.projectId}` : e.key;
            const found = barMap.get(id);
            if (found) found.endIdx = idx;
            else barMap.set(id, { e, startIdx: idx, endIdx: idx });
          });
        });
        const bars = [...barMap.values()].sort(
          (a, b) => a.startIdx - b.startIdx || compareCalendarEvents(a.e, b.e),
        );
        const cap = expand ? bars.length : 4;
        const overflow = bars.length - cap;
        return (
          <div key={wi} className="wk" style={last ? { borderBottom: "1px solid var(--line-card)", borderRadius: "0 0 8px 8px" } : undefined}>
            <div className="nums">
              {w.map((d, i) => {
                const dayEvents = d != null ? byDay[d] : undefined;
                const hasEvents = !!dayEvents?.length;
                const isToday = d != null && d === todayDay;
                const dayHols = dayEvents ? dayEvents.filter((e) => e.kind === "holiday") : [];
                const cls = [hasEvents ? "cal-daynum has-ev" : "", dayHols.length ? "holiday" : ""]
                  .filter(Boolean).join(" ") || undefined;
                return (
                  <div
                    key={i}
                    onClick={hasEvents ? () => onOpenDay(d as number) : undefined}
                    className={cls}
                    role={hasEvents ? "button" : undefined}
                    title={hasEvents ? "Tap to see this day's events" : undefined}
                  >
                    {d != null && (isToday ? <span className="cal-today-badge">{d}</span> : d)}
                    {dayHols.length > 0 && (
                      <span className="cal-hol" title={dayHols.map((h) => h.label).join(", ")}>
                        {dayHols[0].label}{dayHols.length > 1 ? ` +${dayHols.length - 1}` : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,minmax(0,1fr))", rowGap: 2, padding: "2px 0", overflow: "hidden" }}>
              {bars.slice(0, cap).map(({ e, startIdx, endIdx }, i) => {
                const focused = focusProjectId != null && e.kind === "project" && e.projectId === focusProjectId;
                const isTask = e.kind === "task";
                const overdue = isTask && !!e.overdue;
                const cls = "cal-bar" + (focused ? " cal-bar-focus" : "") + (overdue ? " overdue" : "");
                return (
                  <div
                    key={`${e.key}-${i}`}
                    data-cal-project={e.kind === "project" ? e.projectId : undefined}
                    className={cls}
                    title={e.sub || undefined}
                    onClick={() => onOpen?.(e.projectId)}
                    style={{
                      gridColumn: `${startIdx + 1} / ${endIdx + 2}`,
                      gridRow: i + 1,
                      margin: "0 2px",
                      ["--bar" as string]: overdue ? OVERDUE_COLOR : e.color,
                    }}
                  >
                    {isTask && e.dot && <span className="cal-bar-dot" style={{ background: e.dot }} aria-hidden />}
                    <span className="cal-bar-lbl">{e.barLabel}</span>
                  </div>
                );
              })}
            </div>
            {overflow > 0 && (
              <div className="cal-more" onClick={onExpandAll}>+{overflow} more</div>
            )}
          </div>
        );
      })}
    </>
  );
}

function DaySheet({ year, month, day, events, onClose, onOpen }: {
  year: number;
  month: number;
  day: number;
  events: CalEvent[];
  onClose: () => void;
  onOpen: (projectId: number) => void;
}) {
  const weekday = new Date(year, month, day).toLocaleDateString("en-GB", { weekday: "long" });
  const heading = `${weekday} · ${ddmmyyyy(year, month, day)}`;
  const holidays = events.filter((e) => e.kind === "holiday");
  const items = events.filter((e) => e.kind !== "holiday");
  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "var(--brand)" }}>Day view</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{heading}</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="sheet-scroll" style={{ gap: 9 }}>
          {holidays.length > 0 && (
            <div style={{ borderRadius: 10, border: "1px solid #c9cbe3", background: "var(--hz-dk-surface-2, #ecedf6)", padding: "9px 12px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "#474d79" }}>Public holiday</div>
              <div style={{ fontSize: 12.5, color: "#474d79", marginTop: 2 }}>{holidays.map((h) => h.label).join(", ")}</div>
            </div>
          )}
          {items.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "20px 0" }}>No projects or tasks on this day.</div>
          ) : (
            items.map((e, i) => (
              <div
                key={`${e.key}-${i}`}
                className="card"
                onClick={() => onOpen(e.projectId)}
                style={{ padding: "11px 13px", borderLeft: `4px solid ${e.kind === "task" && e.overdue ? OVERDUE_COLOR : e.color}`, cursor: "pointer" }}
              >
                {/* Owner 2026-07-29: the day-sheet is where the full event name
                    is meant to be READ — the month-grid bars can't fit it in a
                    7-column phone layout. So the name + venue WRAP here (no
                    nowrap/ellipsis), and the status pill aligns to the top. */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 800, color: e.kind === "task" && e.overdue ? "var(--red)" : "var(--ink)", lineHeight: 1.35, overflowWrap: "anywhere", minWidth: 0 }}>{e.label}</span>
                  {e.status && (
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", padding: "3px 9px", borderRadius: 20, background: `color-mix(in srgb, ${e.color} 16%, white)`, color: "var(--brand-d)", flex: "none" }}>{e.status}</span>
                  )}
                </div>
                {(e.sub || e.organizer || (e.kind === "task" && e.initials)) && (
                  <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 7, marginTop: 5, fontSize: 11.5, color: "var(--mut)", minWidth: 0 }}>
                    {e.kind === "task" && e.initials && <span className="badge b-grey" style={{ flex: "none" }}>{e.initials}</span>}
                    {e.sub && <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.sub}</span>}
                    {e.sub && e.organizer && <span style={{ opacity: .4, flex: "none" }}>·</span>}
                    {e.organizer && <span style={{ flex: "none" }}>{e.organizer}</span>}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function uniqueSorted(vals: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of vals) if (v) set.add(v);
  return [...set].sort();
}

const EMPTY_MATCHES: CalendarMatch[] = [];

const emptyBox: React.CSSProperties = {
  textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0",
};
