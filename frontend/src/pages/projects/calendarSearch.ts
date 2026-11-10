import { composeDefaultProjectName, upcaseLeadingState } from "./projectHelpers";

/**
 * Previous / Next match on the Projects calendar (owner 2026-11-10: "I searched
 * sccc and I can see it, but there is no next that jumps straight to the next
 * matching event"). Pure logic shared by the desktop calendar and the mobile
 * calendar; the matches come from GET /api/projects/calendar/search, which
 * covers ALL dates (the month feed only returns the visible window).
 */

export interface CalendarMatch {
  id: number;
  code: string | null;
  name: string | null;
  status: string | null;
  brand: string | null;
  organizer: string | null;
  start_date: string;
  end_date: string | null;
  venue: string | null;
  state: string | null;
  event_type_name: string | null;
}

export interface CalendarSearchResult {
  matches: CalendarMatch[];
  total: number;
  truncated: boolean;
  cap: number;
}

const day = (iso: string | null | undefined) => (iso ?? "").slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");

export const matchStart = (m: CalendarMatch) => day(m.start_date);
export const matchEnd = (m: CalendarMatch) => day(m.end_date) || day(m.start_date);

/** First and last ISO day of a month (`month` is 0-11). */
export function monthPeriod(year: number, month: number): { start: string; end: string } {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { start: `${year}-${pad(month + 1)}-01`, end: `${year}-${pad(month + 1)}-${pad(last)}` };
}

/** The Monday on or before an ISO day (the calendar's week anchor). */
export function weekStartOf(iso: string): string {
  const d = new Date(day(iso) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * The match Previous / Next should go to, or null when there is none that way.
 *
 * `matches` must be sorted by start date (the endpoint does that).
 *  - If the last-jumped-to match (`focusedId`) is still on screen, step one
 *    match along the list, so several matches in one month are each reachable.
 *  - Otherwise go by the visible period: Next = the first match that starts
 *    AFTER the period, Previous = the last match that starts BEFORE it. Matches
 *    inside the period are already on screen.
 */
export function pickAdjacentMatch({
  matches,
  focusedId,
  periodStart,
  periodEnd,
  direction,
}: {
  matches: CalendarMatch[];
  focusedId: number | null;
  periodStart: string;
  periodEnd: string;
  direction: "next" | "prev";
}): CalendarMatch | null {
  if (focusedId != null) {
    const i = matches.findIndex((m) => m.id === focusedId);
    if (i >= 0 && matchStart(matches[i]) <= periodEnd && matchEnd(matches[i]) >= periodStart) {
      return matches[direction === "next" ? i + 1 : i - 1] ?? null;
    }
  }
  if (direction === "next") return matches.find((m) => matchStart(m) > periodEnd) ?? null;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matchStart(matches[i]) < periodStart) return matches[i];
  }
  return null;
}

/** The same text the calendar bar shows (SOLO events are composed live). */
export function matchLabel(m: CalendarMatch): string {
  const raw =
    (m.event_type_name || "").toLowerCase() === "solo"
      ? composeDefaultProjectName({
          state: m.state,
          brand: m.brand,
          organizer: null,
          venue: m.venue,
          event_type_slug: "solo",
        })
      : m.name || m.code || `#${m.id}`;
  return upcaseLeadingState(raw, m.state);
}

/** "05/11/2026" or "05/11/2026 – 08/11/2026" (numeric DD/MM/YYYY, owner rule). */
export function matchDateRange(m: CalendarMatch): string {
  const fmt = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const s = matchStart(m);
  const e = matchEnd(m);
  return e && e !== s ? `${fmt(s)} – ${fmt(e)}` : fmt(s);
}

/** Query string for the search endpoint; empty values are left out. */
export function calendarSearchPath(f: { q: string; brand: string; status: string; organizer: string }): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.brand) p.set("brand", f.brand);
  if (f.status) p.set("status", f.status);
  if (f.organizer) p.set("organizer", f.organizer);
  return `/api/projects/calendar/search?${p.toString()}`;
}
