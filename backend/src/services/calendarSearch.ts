/**
 * All-dates search for the Projects calendar (owner 2026-11-10: "I searched
 * sccc and I can see it, but there is no next that jumps to the next matching
 * event"). The month feed only returns the visible window, so the calendar's
 * Previous / Next / match list read from here instead.
 *
 * The match rule MIRRORS the calendar's own filter in
 * frontend/src/pages/projects/calendarModel.ts (projectMatchesCalendarFilters).
 * Change the two together, or the list will name events the grid hides.
 */

export interface CalendarSearchRow {
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

export interface CalendarSearchFilters {
  q: string;
  brand: string;
  status: string;
  organizer: string;
}

/** Hard cap on rows returned. The response always says when it cut. */
export const CALENDAR_SEARCH_CAP = 300;

/** A venue's initials, so "sccc" finds Setia City Convention Centre. */
export const initialsOf = (name: string | null | undefined): string =>
  (name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");

export function hasCalendarFilter(f: CalendarSearchFilters): boolean {
  return !!(f.q.trim() || f.brand || f.status || f.organizer);
}

export function matchesCalendarSearch(row: CalendarSearchRow, f: CalendarSearchFilters): boolean {
  if (f.brand && row.brand !== f.brand) return false;
  if (f.status && (row.status || "").toLowerCase() !== f.status) return false;
  if (f.organizer && (row.organizer || "") !== f.organizer) return false;
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [row.code, row.name, row.venue, row.organizer, row.brand, row.state, row.event_type_name]
    .map((v) => v ?? "")
    .join(" ")
    .toLowerCase();
  const initials = initialsOf(row.venue);
  return words.every((w) => hay.includes(w) || initials.includes(w));
}

/** Filter, sort by start date (then name, id) and cap. `total` is the full count. */
export function searchCalendarRows(
  rows: CalendarSearchRow[],
  f: CalendarSearchFilters,
  cap: number,
): { matches: CalendarSearchRow[]; total: number; truncated: boolean } {
  const all = rows
    .filter((r) => matchesCalendarSearch(r, f))
    .sort(
      (a, b) =>
        a.start_date.slice(0, 10).localeCompare(b.start_date.slice(0, 10)) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id - b.id,
    );
  return { matches: all.slice(0, cap), total: all.length, truncated: all.length > cap };
}
