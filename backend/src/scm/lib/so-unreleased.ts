// HC-0159: a CONFIRMED order with no Processing Date is never released for purchasing, so its
// lines stay PENDING and nothing flags it. Allowed by design (shared/so-processing-date.ts); this
// is the visible flag. The overview query pre-filters; this re-checks so the rule is testable.
const DAY = 86400000;
export const SO_UNRELEASED_AFTER_DAYS = 30;

export type UnreleasedRow = { so_date: string | null; status: string | null; processing_date: string | null; on_hold: boolean | null };

export function unreleasedOrders(rows: UnreleasedRow[], today: string): { count: number; oldestDays: number } {
  let count = 0; let oldestDays = 0;
  for (const r of rows) {
    if (r.status !== 'CONFIRMED' || r.processing_date || r.on_hold || !r.so_date) continue;
    const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(r.so_date).slice(0, 10)}T00:00:00Z`)) / DAY);
    if (age <= SO_UNRELEASED_AFTER_DAYS) continue;
    count += 1; oldestDays = Math.max(oldestDays, age);
  }
  return { count, oldestDays };
}
