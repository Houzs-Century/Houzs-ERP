/* Pure validation for a make-up punch (补卡) request. A worker who forgot to
 * punch states the day and the in / out time they actually worked; this keeps
 * the rule — a past date, both times, out after in — out of the route so it is
 * tested without a database. Reuses correctionTimes for the HH:MM parsing the
 * HR attendance correction already uses, so a 补卡 and an HR fix read a time the
 * same way (an overnight out is carried to the next day, +1440). */
import { correctionTimes } from "./hr-attendance-view";

export type PunchFixParse = { ok: true; inMin: number; outMin: number } | { ok: false; message: string };

export function parsePunchFix(workDate: string, clockIn: string, clockOut: string, todayYmd: string): PunchFixParse {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return { ok: false, message: "Pick the day you missed." };
  if (workDate > todayYmd) return { ok: false, message: "That day hasn't happened yet." };
  const t = correctionTimes(workDate, clockIn, clockOut);
  if (!t.ok) return { ok: false, message: t.message };
  if (t.inMin == null || t.outMin == null) return { ok: false, message: "Enter both the time you clocked in and the time you clocked out." };
  return { ok: true, inMin: t.inMin, outMin: t.outMin };
}
