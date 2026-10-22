/* Where a stop is in its run, for the Last Mile map (owner, 2026-10-07: mark
   what is delivered, what is on its way, and what has run past the time the
   customer was promised). One rule for every screen that colours a stop.

     done      the DO is delivered (DELIVERED / SIGNED / INVOICED, or a
               customer-delivered date), or the job's POD is completed
     active    On the way or Arrived has been tapped
     overdue   not done, and its day has passed — or it is today and the
               promised window's end has passed
     scheduled anything else

   The board's delivery_state is NOT used for "done": it reads DELIVERED once
   every unit has SHIPPED, which is a stop still on the lorry. */

/** DO statuses that mean the customer has the goods. */
export const DO_DELIVERED_STATUSES: readonly string[] = ["DELIVERED", "SIGNED", "INVOICED"];

export type StopStatus = "done" | "active" | "overdue" | "scheduled";

export const STOP_STATUS_COLOR: Record<StopStatus, string> = {
  done: "#15803d",
  active: "#2563eb",
  overdue: "#dc2626",
  scheduled: "#64748b",
};

export const STOP_STATUS_LABEL: Record<StopStatus, string> = {
  done: "Delivered",
  active: "On the way / arrived",
  overdue: "Late",
  scheduled: "Not started",
};

/** Minutes after midnight of the END of a free-text window ("9-12", "09:00–12:00",
 *  "2pm-5pm", "after 3pm" -> null when no end can be read). */
export function windowEndMinutes(timeRange: string | null | undefined): number | null {
  if (!timeRange) return null;
  const parts = timeRange.toLowerCase().split(/\s*(?:-|–|—|to)\s*/);
  if (parts.length < 2) return null;
  const end = parts[parts.length - 1]!.trim();
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(end);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3] || (/(am|pm)/.exec(parts[0] || "")?.[1] ?? null);
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

export type StopStatusRow = {
  delivery_orders?: Array<{ status?: string | null }> | null;
  customer_delivered_date?: string | null;
  arrival_at?: string | null;
  departure_at?: string | null;
  time_range?: string | null;
};

export type StopProgress = { departed_at?: string | null; arrived_at?: string | null; completed_at?: string | null } | null;

export function stopStatusOf(
  row: StopStatusRow,
  progress: StopProgress,
  /** The day the stop is run (YYYY-MM-DD), today, and the clock now (minutes). */
  when: { day: string; today: string; nowMinutes: number },
): StopStatus {
  const dos = row.delivery_orders ?? [];
  const doStatus = (dos.length ? dos[dos.length - 1]!.status ?? "" : "").toUpperCase();
  const done = progress?.completed_at != null || DO_DELIVERED_STATUSES.includes(doStatus) || !!row.customer_delivered_date;
  if (done) return "done";
  if (progress?.arrived_at || progress?.departed_at || row.arrival_at || row.departure_at || doStatus === "IN_TRANSIT") return "active";
  if (when.day && when.day < when.today) return "overdue";
  if (when.day === when.today) {
    const end = windowEndMinutes(row.time_range);
    if (end != null && when.nowMinutes > end) return "overdue";
  }
  return "scheduled";
}

/** Malaysia's date and clock (UTC+8, no daylight saving) for a moment. */
export function mytClock(now: Date): { today: string; nowMinutes: number } {
  const myt = new Date(now.getTime() + 8 * 3600_000);
  return { today: myt.toISOString().slice(0, 10), nowMinutes: myt.getUTCHours() * 60 + myt.getUTCMinutes() };
}

/** Every stop of a day's run, keyed by its board ref (so_doc_no). */
export function stopStatusByRef<R extends StopStatusRow & { so_doc_no: string }>(
  rows: R[],
  progressOf: (row: R) => StopProgress,
  day: string,
  now: Date,
): Map<string, StopStatus> {
  const clock = mytClock(now);
  const out = new Map<string, StopStatus>();
  for (const r of rows) out.set(r.so_doc_no, stopStatusOf(r, progressOf(r), { day, ...clock }));
  return out;
}
