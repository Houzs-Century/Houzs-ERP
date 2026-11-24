// ----------------------------------------------------------------------------
// own-lorry-do-run — which delivery orders our own lorries ran, and on which
// day. ONE rule, two readers: Trip Pay pays the crew for these runs
// (routes/lib/hr-trip-store.ts) and the Own fleet tab prices them on the own
// fleet rate card (own-fleet-load.ts), so a run a driver is paid for is the
// run that is costed. PURE.
// ----------------------------------------------------------------------------
import { doCountsAsDelivered } from '../shared/do-shipped-states';

/** What the rule reads of a delivery order, its crew record and the lorry that
 *  crew names. */
export type OwnLorryDoFacts = {
  do_id: string;
  do_status: string | null;
  /** The SO's due date (amended, else the customer's): the day Last Mile puts it on the lorry. */
  so_due_date: string | null;
  /** This is its SO's newest live DO (not cancelled, newest created_at, ties by id), the one Last Mile shows. */
  is_latest_live: boolean | null;
  /** The Malaysia date of delivered_at. */
  delivered_day: string | null;
  do_date: string | null;
  is_dropship: boolean | null;
  /** A 3PL carrier billed this DO (scm.threepl_do_charges). */
  has_3pl: boolean | null;
  /** A stop on a trip that is not cancelled carries this DO: that stop is its row. */
  on_live_trip: boolean | null;
  /** The plate typed on the crew record, and the lorry master it resolves to. */
  crew_plate: string | null;
  lorry_plate: string | null;
  lorry_internal: boolean | null;
};

const ymdOf = (v: string | null): string | null => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);

/** The day a DO ran, the day Last Mile shows it on its lorry: an SO assigned to a
 *  lorry with no trip sits on the lorry's card on the SO's due date (amended, else
 *  the customer's; lorry-day-runs.ts, isAssignedNoTripRow), shown with its newest
 *  live DO. An older DO of the SO (a partial delivery Last Mile no longer shows)
 *  ran the day it was delivered (Malaysia date), else its DO date. Pure. */
export function doRunDate(d: Pick<OwnLorryDoFacts, 'so_due_date' | 'is_latest_live' | 'delivered_day' | 'do_date'>): string | null {
  const due = ymdOf(d.so_due_date);
  if (d.is_latest_live === true && due) return due;
  return ymdOf(d.delivered_day) ?? ymdOf(d.do_date);
}

/** Does this DO count as a run of one of our own lorries? Shipped (not draft,
 *  not cancelled), a run date, not drop-shipped, not billed by a 3PL, a lorry on
 *  its crew that is not an outsourced lorry, and on no live trip stop (`stopDoIds`
 *  or `on_live_trip`: that stop is its row). Pure. */
export function isOwnLorryDoRun(d: OwnLorryDoFacts, stopDoIds: ReadonlySet<string>): boolean {
  if (!doCountsAsDelivered(d.do_status) || !doRunDate(d)) return false;
  if (d.is_dropship === true || d.has_3pl === true || d.lorry_internal === false) return false;
  if (!(d.lorry_plate || d.crew_plate || '').trim()) return false;
  return d.on_live_trip !== true && !stopDoIds.has(d.do_id);
}
