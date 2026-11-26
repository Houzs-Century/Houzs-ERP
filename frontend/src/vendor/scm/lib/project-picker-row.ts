
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
  date: string;
  brand: string;
  title: string;
  state: string;
  search: string;
  plain: string;
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
