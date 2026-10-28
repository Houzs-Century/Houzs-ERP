// event-date-label — the event's full calendar date for the New DP Order
// project picker. A PMS project CODE carries only the year-month (e.g.
// "2027-10-…"), so two events in the same month read as identical by date in
// the dropdown. This turns the row's start_date — and end_date, when the event
// runs more than a day — into the house date string via the one formatter, so
// the label gains the day (and stays searchable). A date-only value is shown
// verbatim with no timezone shift, because that is how formatDate treats a bare
// YYYY-MM-DD. Returns '' when the project has no date, so the caller appends
// nothing.
import { formatDate } from '../../../lib/utils';

export function eventDateLabel(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  // .slice(0, 10) is the ISO-value idiom: collapse a datetime to its calendar
  // day so the start/end equality check compares days, not instants.
  const s = (start ?? '').slice(0, 10);
  const e = (end ?? '').slice(0, 10);
  if (!s && !e) return '';
  if (s && e && e !== s) return `${formatDate(s)}–${formatDate(e)}`;
  return formatDate(s || e);
}
