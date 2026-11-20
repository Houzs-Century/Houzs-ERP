/* Pure overtime-claim rules (HC-0125). A worker reports OT as one or more
 * windows on a work date ("20:30-21:30 rushed an order"); a supervisor confirms.
 * Paid OT for a day is the sum of the CONFIRMED windows' minutes. Tested without
 * a database. */
import { hhmmToMin } from "../../scm/shared/hr-pay-rules";

export type OtStatus = "PENDING" | "CONFIRMED" | "REJECTED";
const MAX_SEGMENT_MIN = 16 * 60;

/** Parse a worker's "HH:MM" overtime window into minutes from midnight of the
 *  work date. An end at or before the start crosses midnight (e.g. 23:30-00:30),
 *  so it rolls to the next day and end_min exceeds 1440. */
export function parseOtSegment(
  startHHMM: string,
  endHHMM: string,
): { ok: true; startMin: number; endMin: number } | { ok: false; message: string } {
  const s = hhmmToMin(startHHMM);
  const eRaw = hhmmToMin(endHHMM);
  if (s == null || !Number.isFinite(s)) return { ok: false, message: "Start time is HH:MM, e.g. 20:30." };
  if (eRaw == null || !Number.isFinite(eRaw)) return { ok: false, message: "End time is HH:MM, e.g. 21:30." };
  if (s >= 1440) return { ok: false, message: "Start time must be on the work date." };
  const e = eRaw <= s ? eRaw + 1440 : eRaw;
  if (e - s < 1) return { ok: false, message: "End time must be after the start time." };
  if (e - s > MAX_SEGMENT_MIN) return { ok: false, message: "One overtime block is at most 16 hours. Split it into separate blocks." };
  return { ok: true, startMin: s, endMin: e };
}

/** Minutes in one stored segment (end_min already rolled past 1440 if overnight). */
export const segmentMinutes = (seg: { start_min: number; end_min: number }): number => seg.end_min - seg.start_min;

/** Total CONFIRMED overtime minutes across claim rows (e.g. for one employee-day). */
export function confirmedOtMinutes(rows: ReadonlyArray<{ status: string; start_min: number; end_min: number }>): number {
  let total = 0;
  for (const r of rows) if (r.status === "CONFIRMED") total += r.end_min - r.start_min;
  return total;
}
