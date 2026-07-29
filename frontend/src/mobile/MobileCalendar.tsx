import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { getHolidaysOn } from "../lib/holidays";
import { useBranding } from "../hooks/useBranding";
import { HOUZS_COMPANY_CODE, shortCompanyName } from "../lib/branding";
import { compareCalendarEvents } from "../lib/calendarSort";
import "./mobile.css";

/**
 * Mobile Calendar screen — 1:1 with the owner's mobile design prototype,
 * wired to the same feed the desktop Projects calendar uses.
 *
 * Data source: GET /api/projects/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (backend/src/routes/projects.ts, gated by projects.calendar page access,
 * row-scoped by PIC + brand). Returns { projects, tasks }:
 *
 *   project: { id, code, name, stage, status ("confirmed"|"pending"|
 *     "cancelled"), brand, organizer, start_date, end_date, venue, state,
 *     active_section_name, sections_total, event_type_name }
 *   task:    { id, project_id, project_code, project_name, brand, organizer,
 *     title, due_date, status, project_status, owner_name, is_overdue }
 *
 * The brand / section / organizer selects are wired to the SAME lookup
 * endpoints the desktop Projects calendar uses — /api/projects/brands,
 * /api/projects/sections-distinct and /api/projects/organizers — so the
 * dropdowns list every configured value (not only the ones that happen to
 * fall in the visible month). The confirmed / pending / cancelled legend maps
 * onto project.status. Projects render as event bars on their start_date;
 * tasks render when the "Tasks" toggle is on (keyed off due_date).
 *
 * The "My holidays" toggle overlays Malaysian federal public holidays, sourced
 * from the SAME local table the desktop Projects calendar uses
 * (src/lib/holidays.ts → getHolidaysOn); no backend feed is involved. Holidays
 * render as purple event bars (matching the design's #7a5c86) and bypass the
 * brand/section/organizer filters (they are not project-scoped).
 */

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

// A normalized event on the grid — either a project bar or a task chip.
type CalEvent = {
  key: string;
  kind: "project" | "task" | "holiday";
  projectId: number; // tapping a project/task drills into this project (0 for holidays)
  date: string; // YYYY-MM-DD
  label: string; // day-sheet title (unchanged mobile design)
  // Compact grid-bar caption. For a project this leads with the STATE
  // (the desktop calendar's "SEL"/"JOH" pill), mirroring the desktop bar
  // exactly; tasks/holidays reuse their label.
  barLabel: string;
  color: string;
  brand: string | null;
  section: string | null;
  organizer: string | null;
  status: string | null;
  sub: string | null;
  // State + venue carried for the shared day-cell sort (compareCalendarEvents);
  // null on tasks/holidays so they fall after the state-ordered project bars.
  state: string | null;
  venue: string | null;
  // Task-only presentation extras, mirroring the desktop task chip: is_overdue
  // reds the bar, project_status colours a status dot, owner_name -> initials.
  overdue?: boolean;
  dot?: string;
  initials?: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Status → bar colour, mirroring the prototype legend.
const STATUS_COLOR: Record<string, string> = {
  confirmed: "#2f8a5b",
  pending: "#cf9a2e",
  cancelled: "#b23a3a",
};
const TASK_COLOR = "#a16a2e";
const HOLIDAY_COLOR = "#7a5c86";
const statusColor = (s: string | null) => STATUS_COLOR[(s ?? "").toLowerCase()] ?? "#5a6b7a";
// Overdue task bar colour — the mobile "cancelled / late" red token (--red),
// reused so a late task reads in the same family as a cancelled bar.
const OVERDUE_COLOR = "#b23a3a";

// Up-to-two-letter owner initials for the task-bar badge (desktop task chip).
const ownerInitials = (name: string | null): string =>
  (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();

// Project bar caption — byte-for-byte the desktop Projects calendar's bar text
// (pages/Projects.tsx: composeDefaultProjectName + the solo / non-solo split at
// the bar render). A SOLO event is composed live as "{state} [{brand}] SOLO @
// {venue}" so the bar leads with the STATE — the brown-tinted "SEL"/"JOH" pill
// the owner sees on desktop; every other event shows its own project name,
// which the New Project form already defaults to the same state-first shape.
// Pure formatter over fields already on the shared /api/projects/calendar/events
// row — it derives no new data and re-uses the exact desktop logic so the two
// surfaces read identically.
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
// Owner-locked numeric DD/MM/YYYY (mobile date format — never month names),
// matching MobileSalesOrders and the Build Spec's DDMMYYYY rule.
const ddmmyyyy = (y: number, m: number, d: number) => `${pad(d)}/${pad(m + 1)}/${y}`;

// Monday-first week matrix for a month, matching the prototype's calWeeks().
function monthWeeks(y: number, m: number): (number | null)[][] {
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // Mon = 0
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
  /** Open the system-wide search palette (header magnifying-glass). */
  onOpenSearch?: () => void;
  /** Jump the calendar to a specific month on mount (search → calendar jump). */
  initialYear?: number;
  initialMonth?: number; // 0-11
  /** Visually highlight this project's bar (paired with initialYear/Month). */
  focusProjectId?: number;
} = {}) {
  const today = new Date();

  // Header brand lockup — company-aware, mirroring the login/profile pattern.
  // HOUZS keeps the historic literal ("HOUZS" / "CENTURY · ERP") verbatim; any
  // other active company derives from its short name: first word as the bold
  // mark, the remaining words + "· ERP" as the spaced eyebrow (so a 2990
  // session never shows the Houzs brand).
  const { pageAccess } = useAuth();
  // Same capability the desktop Projects → Calendar sub-tab uses. Gate every
  // /api/projects/* read so none fires a 403 for a user without calendar access
  // (OFF, not hide) — defence-in-depth on top of the shell's tab gating.
  const canViewCalendar = pageAccess("projects.calendar") !== "none";
  const branding = useBranding();
  const isHouzsBrand = branding.companyCode === HOUZS_COMPANY_CODE;
  const brandWords = shortCompanyName(branding.companyName).split(/\s+/).filter(Boolean);
  const brandMark = isHouzsBrand ? "HOUZS" : (brandWords[0] ?? "").toUpperCase();
  const brandEyebrow = isHouzsBrand
    ? "CENTURY · ERP"
    : (brandWords.length > 1 ? `${brandWords.slice(1).join(" ")} · ERP` : "ERP").toUpperCase();

  const [year, setYear] = useState(initialYear ?? today.getFullYear());
  const [month, setMonth] = useState(initialMonth ?? today.getMonth());
  const [mode, setMode] = useState<"month" | "week">("month");
  const [brandF, setBrandF] = useState("all");
  const [sectionF, setSectionF] = useState("all");
  const [orgF, setOrgF] = useState("all");
  const [showTasks, setShowTasks] = useState(false);
  // My-holidays toggle — overlays Malaysian federal public holidays from the
  // local src/lib/holidays.ts table (same source as the desktop calendar); no
  // backend feed needed. Rendered as a day-cell tint + name (see MonthGrid).
  // Defaults ON to match the desktop Projects calendar, which always overlays
  // federal holidays.
  const [showHolidays, setShowHolidays] = useState(true);
  // Owner 2026-07-23: always expand every week's bars (no cap, no "+N more");
  // the Expand-all toggle was removed. Kept as a const so MonthGrid's prop and
  // the (now-unreachable) overflow handler still type-check.
  const expand = true;
  // Day-detail sheet — opened by tapping a date cell or a "+N more" overflow
  // link, mirroring the desktop CalendarDayModal. Holds the tapped day (1-31)
  // so the sheet can list that day's project/task bars + public holidays.
  const [daySheet, setDaySheet] = useState<number | null>(null);

  // Search → calendar jump: when the shell re-mounts the Calendar tab with a new
  // target month (the tapped project's start_date), snap to it. Keyed on the
  // incoming values so a subsequent manual nav is not clobbered.
  useEffect(() => {
    if (initialYear != null) setYear(initialYear);
    if (initialMonth != null) setMonth(initialMonth);
    if (initialYear != null || initialMonth != null) setMode("month");
  }, [initialYear, initialMonth]);

  // Fetch the full month in one call, keyed by month so navigation refetches.
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

  // Filter option lists come from the SAME lookup endpoints the desktop
  // Projects calendar uses, so every configured brand / section / organizer is
  // selectable — not just the ones that happen to land in the visible month.
  // All three are gated by `projects` page access (same as the events feed).
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

  // Normalize projects (+ optionally tasks) into grid events, then filter.
  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = [];
    // A project occupies EVERY day from start_date through end_date, not just
    // its start day — the desktop Projects calendar spans the same range
    // (Projects.tsx: s = start_date, e = end_date || start_date; its day modal
    // matches projects where s <= day && e >= day). The mobile grid draws one
    // bar per day (no spanning bars), so we emit an event for each in-range day;
    // this is what makes tapping day 11/12/13 of a 10–13 fair surface it instead
    // of reading "no projects that day". Clamp to the visible month so a fair
    // straddling a month boundary paints only its in-month days (and a day
    // number can't collide with the adjacent month), and key by day so the
    // per-day bars carry unique React keys. end_date is inclusive and falls back
    // to start_date for a single-day event.
    const monthFirst = iso(year, month, 1);
    const lastDom = new Date(year, month + 1, 0).getDate();
    const monthLast = iso(year, month, lastDom);
    for (const p of projects) {
      const start = p.start_date.slice(0, 10);
      const end = (p.end_date || p.start_date).slice(0, 10);
      if (start > monthLast || end < monthFirst) continue; // no overlap this month
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
    // Holidays overlay the whole month regardless of the project filters — they
    // are federal, not project-scoped (mirrors the design's holiday layer).
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
  }, [projects, tasks, showTasks, showHolidays, year, month, brandF, sectionF, orgF]);

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

  // Search → calendar jump: once the target month's data is in, surface the
  // focused project by opening its day sheet (so it's visible even when its bar
  // sits under a "+N more" overflow). Runs once per focus target + load.
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

  const nav = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const goToday = () => {
    const n = new Date();
    setYear(n.getFullYear());
    setMonth(n.getMonth());
    setMode("month");
  };

  const isThisMonth = year === today.getFullYear() && month === today.getMonth();
  // Day-of-month to mark with the brown "today" badge — only when the grid is
  // showing the current month (null otherwise so no cell is falsely marked).
  const todayDay = isThisMonth ? today.getDate() : null;
  let weeks = monthWeeks(year, month);
  if (mode === "week") {
    const target = isThisMonth ? today.getDate() : 1;
    weeks = [weeks.find((w) => w.includes(target)) ?? weeks[0]];
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "#fff" }}>
      {/* Header — brand lockup + search, matching the v7 calendar chrome. The
          month nav / mode / filters live in the scroll body (below), per spec. */}
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

      <div className="scroll" style={{ padding: 12, paddingBottom: 120, background: "#fff" }}>
        {/* Month nav — ‹ · Today · › · right-aligned month title (v7 lockup) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
          <button onClick={() => nav(-1)} aria-label="Previous month" className="cal-navbtn">‹</button>
          <button onClick={goToday} className="cal-today">Today</button>
          <button onClick={() => nav(1)} aria-label="Next month" className="cal-navbtn">›</button>
          <div style={{ flex: 1, fontSize: 17, fontWeight: 800, color: "#11140f", textAlign: "right" }}>{MONTHS[month]} {year}</div>
        </div>

        {/* Month / Week segmented toggle */}
        <div style={{ display: "flex", background: "var(--bg)", border: "1px solid var(--line-card)", borderRadius: 10, padding: 3, marginBottom: 10 }}>
          {(["month", "week"] as const).map((mo) => (
            <button key={mo} onClick={() => setMode(mo)} className={`cal-seg${mode === mo ? " on" : ""}`}>{mo === "month" ? "Month" : "Week"}</button>
          ))}
        </div>

        {/* Filters — populated from the live feed (native selects hold many dynamic values) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
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

        {/* Tasks / My holidays / Expand toggles */}
        <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
          <button onClick={() => setShowTasks((v) => !v)} className={`cal-tog${showTasks ? " on" : ""}`}>{showTasks ? "●" : "○"} Tasks</button>
          <button onClick={() => setShowHolidays((v) => !v)} className={`cal-tog${showHolidays ? " on" : ""}`}>{showHolidays ? "●" : "○"} My holidays</button>
        </div>
        {/* Legend */}
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

        {isLoading && <div style={emptyBox}>Loading…</div>}
        {error && <div style={{ ...emptyBox, color: "var(--red)" }}>Couldn't load the calendar. Pull to retry.</div>}

        {/* Month AND Week share the prototype's single .wk grid — week mode just
            renders the one week containing today (computed above) with every bar
            uncapped, exactly as the prototype's calRender() does. No separate
            agenda list (the prototype has none). */}
        {!isLoading && !error && (
          <MonthGrid weeks={weeks} byDay={byDay} expand={expand} onExpandAll={() => {}} onOpenDay={setDaySheet} empty={events.length === 0} onOpen={onOpenProject} focusProjectId={focusProjectId} todayDay={todayDay} />
        )}
      </div>

      {/* Day-detail sheet — tapping a date cell or a "+N more" link surfaces
          every event on that day (projects, tasks and public holidays),
          mirroring the desktop CalendarDayModal. */}
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
  /** Day-of-month to badge as "today", or null when not viewing this month. */
  todayDay: number | null;
}) {
  return (
    <>
      {/* Weekday header */}
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
        // Earliest-starting first, then the shared STATE->venue rule (matches the
        // desktop calendar's grouping).
        const bars = [...barMap.values()].sort(
          (a, b) => a.startIdx - b.startIdx || compareCalendarEvents(a.e, b.e),
        );
        // Up to 4 bars per week (all when Expand-all is on); overflow "+N more".
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
            {/* Bars grid — 7 columns aligned to the day numbers above; each bar
                spans grid-column start..end so it sits on its real dates. Each
                bar keeps its own row so overlapping fairs stack (no packing). */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", rowGap: 2, padding: "2px 0" }}>
              {bars.slice(0, cap).map(({ e, startIdx, endIdx }, i) => {
                const focused = focusProjectId != null && e.kind === "project" && e.projectId === focusProjectId;
                const isTask = e.kind === "task";
                const overdue = isTask && !!e.overdue;
                const cls = "cal-bar" + (focused ? " cal-bar-focus" : "") + (overdue ? " overdue" : "");
                return (
                  <div
                    key={`${e.key}-${i}`}
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

// Day-detail bottom sheet — lists every event on a tapped day (projects,
// tasks and public holidays). Reuses the app's bottom-sheet chrome from
// mobile.css (.sheet-bd / .sheet / .grab / .sheet-head / .sheet-x /
// .sheet-scroll). Mirrors the desktop CalendarDayModal.
function DaySheet({ year, month, day, events, onClose, onOpen }: {
  year: number;
  month: number;
  day: number;
  events: CalEvent[];
  onClose: () => void;
  onOpen: (projectId: number) => void;
}) {
  // Weekday name + owner-locked numeric DD/MM/YYYY (never a month name).
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
            <div style={{ borderRadius: 10, border: "1px solid #c9cbe3", background: "#ecedf6", padding: "9px 12px" }}>
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

const emptyBox: React.CSSProperties = {
  textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0",
};
