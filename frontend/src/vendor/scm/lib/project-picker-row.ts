// project-picker-row — builds one New DP Order "Project / venue" dropdown row
// from a PMS project list row. The stored `name` is "{STATE} [{BRAND}] {TITLE}"
// (e.g. "PULAU PINANG [AKEMI] HOMEDEC @ SETIA SPICE CONVENTION CENTRE"), with
// brand and state also on their own columns. The row the owner asked for leads
// with the event DATE (aligned), then the brand, the title, and the state, so
// same-month same-venue events read apart at a glance. Pure, so it is unit-tested
// without a DOM.

export type ProjectRowInput = {
  code: string | null;
  name: string | null;
  venue: string | null;
  state: string | null;
  brand: string | null;
  start_date: string | null;
  end_date: string | null;
};

export type ProjectRow = {
  /** Aligned date: "2026-08-28 → 31" (same month), "2026-07-31 → 08-02" (across
   *  months), or the full end "2026-12-30 → 2027-01-02" (across years). */
  date: string;
  brand: string;
  title: string;
  state: string;
  /** Lowercased haystack for search: code, title, venue, state, brand. */
  search: string;
  /** Plain one-line label for the closed input (no highlight). */
  plain: string;
  /** start_date (YYYY-MM-DD) for newest-first sorting; '' when unset. */
  sortKey: string;
};

/** The event date the owner spec'd (2026-10-29): ISO, dashes, an arrow to the
 *  end shortened to the part that differs — the day within the same month, MM-DD
 *  across months, the full date across years. A single-day or end-less event is
 *  just the start. Deliberately NOT the house yyyy/mm/dd: this column is rendered
 *  monospace so the dates line up and the two ends read as one span. */
export function eventDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  // .slice(0, 10) is the ISO-value idiom: a bare calendar day, no timezone shift.
  const s = (start ?? '').slice(0, 10);
  const e = (end ?? '').slice(0, 10);
  if (!s) return '';
  if (!e || e === s) return s;
  const [sy, sm] = s.split('-');
  const [ey, em, ed] = e.split('-');
  if (sy !== ey) return `${s} → ${e}`;
  if (sm !== em) return `${s} → ${em}-${ed}`;
  return `${s} → ${ed}`;
}

/** Everything after the first "]" is the title — the "{STATE} [{BRAND}] " prefix
 *  drops out whatever the state's case. A name with no bracket is taken whole. */
function titleFromName(name: string): string {
  const close = name.indexOf(']');
  return (close >= 0 ? name.slice(close + 1) : name).trim();
}

export function projectRowParts(p: ProjectRowInput): ProjectRow {
  const name = (p.name ?? '').trim();
  const title = titleFromName(name) || name;
  const brand = (p.brand ?? '').trim();
  const state = (p.state ?? '').trim();
  const date = eventDateRange(p.start_date, p.end_date);
  const plain = [date, brand ? `[${brand}]` : '', title, state ? `· ${state}` : '']
    .filter(Boolean)
    .join(' ');
  const search = [p.code ?? '', title, p.venue ?? '', state, brand]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return { date, brand, title, state, search, plain, sortKey: (p.start_date ?? '').slice(0, 10) };
}
