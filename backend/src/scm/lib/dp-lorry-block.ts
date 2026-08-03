// ---------------------------------------------------------------------------
// dp-lorry-block.ts — the availability window a scheduled LORRY_SERVICE job
// writes against the lorry it takes off the road.
//
// WHY THIS EXISTS. A lorry service (job type 9, mig 0250) is the only DP job
// whose SUBJECT is one of our own lorries: it spends that day at a workshop and
// cannot carry anything. Scheduling one without saying so would leave the fleet
// board offering a lorry that is not there — the single most expensive kind of
// wrong answer a planning board can give.
//
// scm.lorry_maintenance (mig 0053) is already the availability table both
// readers consult: fleet-availability.ts asks "is this lorry out today" and
// lorry-capacity.ts counts repair days out of it. So a scheduled service writes
// ONE window there, and cancelling the job takes it back out.
//
// THE REASON STRING IS THE KEY, and that is deliberate. lorry_maintenance has no
// link back to whatever caused a window; the Repair Days dashboard already
// solved the same problem by tagging its own rows with a fixed sentinel reason
// and deleting only those (lorry-capacity.ts:72, :414). This follows that
// precedent one step further: the reason carries the DP NUMBER, so a cancel
// removes exactly the window its own job created and can never take out a
// hand-entered repair window, another DP job's window, or the dashboard's.
// ---------------------------------------------------------------------------

/** Prefix every DP-owned window shares — the family name a human scanning the
 *  maintenance list can recognise, and the thing to grep for. */
export const DP_LORRY_BLOCK_PREFIX = 'DP lorry service';

/** The exact `reason` a scheduled lorry-service job writes and its cancel
 *  deletes. One job, one string, one row. */
export function dpLorryBlockReason(dpNo: string): string {
  return `${DP_LORRY_BLOCK_PREFIX} — ${dpNo}`;
}

/** Does this window belong to a DP job? Used nowhere yet by production code —
 *  it exists so a future reader of the maintenance list can tell DP-owned
 *  windows from hand-entered ones without re-deriving the format. */
export function isDpLorryBlock(reason: string | null | undefined): boolean {
  return (reason ?? '').startsWith(`${DP_LORRY_BLOCK_PREFIX} `);
}
