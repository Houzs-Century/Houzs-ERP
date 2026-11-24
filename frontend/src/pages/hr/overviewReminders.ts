/* Overview reminders built from the employee master's two compliance dates
 * (work permit expiry, confirmation due). Kept pure and apart from OverviewPage
 * so the "expiring" window and the merge with holidays are tested without the
 * React harness. Dates are YMD strings, compared as strings (they sort right). */

/** Flag the employees whose work permit lapses soon. Active employees only,
 *  and only the ones with a permit date filled. Counts the permits expiring on
 *  or before today + windowDays (so already-lapsed permits are included), and
 *  says whether any have already passed today, which the Overview shows red. */
export function permitAlert(
  employees: ReadonlyArray<{ status: string; workPermitExpiry: string }>,
  today: string,
  windowDays: number,
): { count: number; anyExpired: boolean } {
  const cutoff = addDaysYmd(today, windowDays);
  let count = 0;
  let anyExpired = false;
  for (const e of employees) {
    if (e.status !== "ACTIVE") continue;
    const x = e.workPermitExpiry;
    if (!x || x > cutoff) continue;
    count++;
    if (x < today) anyExpired = true;
  }
  return { count, anyExpired };
}

export type UpcomingKind = "Holiday" | "Permit" | "Confirm";
export type UpcomingItem = { date: string; label: string; kind: UpcomingKind };

/** The dated things coming up, oldest first: public holidays, plus each active
 *  employee's work-permit expiry and confirmation-due day. Only dates today or
 *  later; the caller shows the first few. A stable tiebreak keeps the order the
 *  same for two events on one day. */
export function buildUpcoming(
  holidays: ReadonlyArray<{ date: string; name: string | null }>,
  employees: ReadonlyArray<{ name: string; status: string; workPermitExpiry: string; confirmDueOn: string }>,
  today: string,
): UpcomingItem[] {
  const out: UpcomingItem[] = [];
  for (const h of holidays) {
    if (h.date >= today) out.push({ date: h.date, label: h.name ?? "Public holiday", kind: "Holiday" });
  }
  for (const e of employees) {
    if (e.status !== "ACTIVE") continue;
    if (e.workPermitExpiry && e.workPermitExpiry >= today) out.push({ date: e.workPermitExpiry, label: `${e.name} · work permit`, kind: "Permit" });
    if (e.confirmDueOn && e.confirmDueOn >= today) out.push({ date: e.confirmDueOn, label: `${e.name} · confirmation`, kind: "Confirm" });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  return out;
}

/** today + days, as a YMD string. UTC so it never shifts by one near midnight. */
function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
