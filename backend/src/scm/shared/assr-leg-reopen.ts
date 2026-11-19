/* A cancelled Service Case leg drops off Delivery Planning (assrBoardLegs). Giving
   that leg a NEW date books it again, so the write clears its cancel stamp (HC-0246).
   Every date column of a leg maps to that leg's stamp: Service's requested date on
   the case and Logistics' confirmed date. Emptying a date, or re-saving the same
   one (a whole-form save), leaves the stamp alone. No imports: services/assr.ts and
   the sheet write-back both use it. */
const CANCEL_COL_OF_DATE: Record<string, string> = {
  customer_pickup_at: 'pickup_cancelled_at', sched_pickup_date: 'pickup_cancelled_at',
  inspection_visit_at: 'inspection_cancelled_at', sched_inspection_date: 'inspection_cancelled_at',
  do_date: 'delivery_cancelled_at', sched_delivery_date: 'delivery_cancelled_at',
};

const day = (v: unknown) => String(v ?? '').trim().slice(0, 10);

/** The `<leg>_cancelled_at = NULL` assignments a date write needs. */
export function reopenedLegSets(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): string[] {
  const cols = new Set<string>();
  for (const [dateCol, cancelCol] of Object.entries(CANCEL_COL_OF_DATE)) {
    if (!(dateCol in after)) continue;
    const next = day(after[dateCol]);
    if (next && next !== day(before?.[dateCol])) cols.add(cancelCol);
  }
  return [...cols].map((c) => `${c} = NULL`);
}
