// ─────────────────────────────────────────────────────────────────────────
// amendment-raised-effects — the two things that happen once an SO amendment
// row has LANDED: its request is written to the Sales Order's history, and the
// people it now waits on are told.
//
// Both are per-raise side effects of the same event, and neither belongs in the
// create route's body: that route (mfg-sales-orders.ts POST /:docNo/amendments)
// is 300 lines of guards, lane classification and inserts, and the file it
// lives in is over the size ceiling — new behaviour has to arrive as its own
// module or not at all.
//
// ORDERING IS NOT AN ACCIDENT. The audit row is written per lane INSIDE the
// insert loop (a rolled-back half must not leave a history row behind); the
// notice fires AFTER every half has landed, because announcing a split
// submission before its second document exists tells one desk their work is
// already someone else's problem.
//
// Neither function throws for its own reasons: recordSoAudit is the existing
// audit sink, and notifySoAmendmentRaised swallows its failures by design —
// a notification outage must never turn a created amendment into a 500.
// ─────────────────────────────────────────────────────────────────────────

import { recordSoAudit } from './so-audit';
import { resolveUserIdByStaffId } from './salesScope';
import { activeCompanyId } from './companyScope';
import {
  notifySoAmendmentRaised,
  type SoAmendmentLane,
} from '../../services/amendmentNotify';

/**
 * The AMENDMENT_REQUESTED history row for ONE lane document.
 *
 * `headerChanges` is audited at REQUEST time, not just at apply, so the History
 * timeline shows what was asked for even when the amendment is later rejected —
 * a refused request is part of the order's story.
 */
export async function recordAmendmentRequested(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree; a typed signature here would describe a contract nothing else keeps.
  sb: any,
  args: {
    docNo: string;
    amendmentNo: string;
    lane: string;
    actorId: string;
    actorName: string | null;
    reason?: string | null;
    /** This lane's requested header keys, their new values, and the SO values
     *  they replace — mapped to audit rows here so the route does not carry a
     *  second copy of the payloadKey -> column vocabulary. */
    headerKeys: string[];
    headerChanges: Record<string, string | null>;
    oldHeaderSnapshot: Record<string, string | null>;
    columnOf: Record<string, string>;
  },
): Promise<void> {
  await recordSoAudit(sb, {
    docNo: args.docNo,
    action: 'AMENDMENT_REQUESTED',
    actorId: args.actorId,
    actorName: args.actorName,
    fieldChanges: [
      { field: 'amendment', from: null, to: args.amendmentNo },
      { field: 'lane', to: args.lane },
      ...args.headerKeys.map((k) => ({
        field: `requested_${args.columnOf[k]}`,
        from:  args.oldHeaderSnapshot[k],
        to:    args.headerChanges[k],
      })),
    ],
    note: args.reason ?? undefined,
  });
}

/**
 * One notice PER LANE for a submission that has fully landed.
 *
 * The salesperson lookup runs ONCE for the whole submission (both halves share
 * a Sales Order), and an unlinked staff row simply resolves to null — the
 * notice then reaches the approvers alone rather than nobody.
 */
export async function notifyAmendmentsRaised(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see recordAmendmentRequested; `c` is Hono's context, `sb` the SCM client, both untyped across this tree.
  c: any, sb: any,
  args: {
    docNo: string;
    salespersonStaffId: string | null | undefined;
    reason?: string | null;
    created: Array<{ amendment_no: string; lane: SoAmendmentLane }>;
  },
): Promise<void> {
  const salespersonUserId = await resolveUserIdByStaffId(sb, args.salespersonStaffId);
  for (const a of args.created) {
    await notifySoAmendmentRaised(c.env, {
      amendmentNo: a.amendment_no,
      soDocNo: args.docNo,
      lane: a.lane,
      companyId: activeCompanyId(c),
      reason: args.reason ?? null,
      requesterName: c.get('houzsUser')?.name ?? null,
      requesterUserId: c.get('houzsUser')?.id ?? null,
      salespersonUserId,
    });
  }
}
