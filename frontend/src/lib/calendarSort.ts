// Shared ordering for the Projects calendar day cells — used by BOTH the
// desktop calendar (pages/Projects.tsx) and the mobile calendar
// (mobile/MobileCalendar.tsx) so the two surfaces read identically.
//
// Owner rule 2026-07-20: within a day, order fair events by STATE first
// (fixed geographic sequence, PENANG at the top down to JOHOR, East Malaysia
// last — NOT alphabetical), then keep the events of one fair together by
// venue + organizer, then brand. That stops one fair's brands being split
// apart and stops states from scattering (a fair spanning three brands now
// stacks as one block).

// Fixed display order, north -> south, PENANG on top per the owner; East
// Malaysia last. Cities that show up in the free-text state field (e.g. IPOH
// for Perak) sit next to their state. Any value not listed sorts AFTER all of
// these, then alphabetically among themselves — so an unexpected label never
// breaks the sort, it just lands at the bottom.
export const CALENDAR_STATE_ORDER: readonly string[] = [
  "PENANG",
  "KEDAH",
  "PERLIS",
  "PERAK",
  "IPOH",
  "KELANTAN",
  "TERENGGANU",
  "PAHANG",
  "SELANGOR",
  "KL",
  "KUALA LUMPUR",
  "PUTRAJAYA",
  "NEGERI SEMBILAN",
  "MELAKA",
  "JOHOR",
  "LABUAN",
  "SABAH",
  "SARAWAK",
];

const STATE_RANK = new Map(CALENDAR_STATE_ORDER.map((s, i) => [s, i] as const));

export function calendarStateRank(state: string | null | undefined): number {
  const key = (state ?? "").trim().toUpperCase();
  const r = STATE_RANK.get(key);
  return r === undefined ? CALENDAR_STATE_ORDER.length : r;
}

export interface CalendarSortable {
  state?: string | null;
  venue?: string | null;
  organizer?: string | null;
  brand?: string | null;
}

// State (fixed order) -> venue -> organizer -> brand. Venue+organizer together
// keep one fair's brand rows adjacent; brand is the final tiebreak so the
// stack reads in a stable brand order.
export function compareCalendarEvents(a: CalendarSortable, b: CalendarSortable): number {
  return (
    calendarStateRank(a.state) - calendarStateRank(b.state) ||
    (a.state ?? "").localeCompare(b.state ?? "") ||
    (a.venue ?? "").localeCompare(b.venue ?? "") ||
    (a.organizer ?? "").localeCompare(b.organizer ?? "") ||
    (a.brand ?? "").localeCompare(b.brand ?? "")
  );
}
