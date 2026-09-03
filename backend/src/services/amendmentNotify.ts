// ─────────────────────────────────────────────────────────────────────────
// amendmentNotify.ts — in-app notices for the SO / PO amendment workflow.
//
// Owner 2026-09-02: "在 erp 有 amendment 的话需要让相关人员收到 notice, 需要有
// 红色号码 notice." Until now an amendment was raised in silence: the row
// appeared in Sales Order Amendment and sat there until somebody happened to
// open the screen. The approver is the ONE person who has to act, and they were
// the one person nothing told.
//
// SAME DELIVERY MODEL AS assrNotify — a PRIVATE announcement per audience
// (postPersonalNotice), which surfaces on the notification bell's system slice
// (?scope=system) and its red unread count. No new table, no push, no email.
//
// WHO GETS WHAT (owner-picked audience, 2026-09-02):
//   raised   → the lane's approvers + each approver's reporting upline, and
//              separately the Sales Order's salesperson (whose order changed).
//   resolved → the person who raised it + the salesperson.
// Nobody is notified of their OWN action. Withdraw stays silent on purpose: the
// requester cancelling their own request is not news to people who were told
// about it — the row simply leaves the queue.
//
// Approvers are resolved from the LANE key (LINES → purchasing, DELIVERY →
// logistics), so this can never notify the wrong desk: the same key the gate
// checks is the key the audience comes from.
//
// NEVER THROWS. Every entry point is wrapped — a notify failure must not fail
// (or roll back) the amendment write that triggered it. postPersonalNotice is
// itself fail-soft; the try/catch here guards the audience lookups.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { uplineUserIds } from "./orgScope";
import { usersHoldingPermission } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";

/** announcements.source tags — non-null keeps these out of the office composer
 *  list and the pop-up banner, and inside the bell's system slice. */
const SO_SOURCE = "so_amendment";
const PO_SOURCE = "po_amendment";

type Ids = Array<number | null | undefined>;

const cleanIds = (ids: Ids): number[] =>
  Array.from(
    new Set(ids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)),
  );

/** Self + every manager above each seed, de-duped. Mirrors assrNotify's rule:
 *  the desk that must act, plus the line that answers for it. */
async function withUpline(env: Env, seeds: number[]): Promise<number[]> {
  const out = new Set<number>();
  for (const id of seeds) {
    for (const up of await uplineUserIds(env, id)) out.add(up);
  }
  return [...out];
}

/** `reason` flattened to one line and clipped — an operator's free text lands
 *  in a notice body, and a 2000-character paste would make the card unreadable. */
function shortReason(reason: string | null | undefined): string {
  const r = (reason ?? "").replace(/\s+/g, " ").trim();
  if (!r) return "";
  return r.length > 200 ? `${r.slice(0, 199)}…` : r;
}

/* ── SO amendments ───────────────────────────────────────────────────────── */

export type SoAmendmentLane = "LINES" | "DELIVERY";

/** Lane wording for the notice copy. */
const LANE_NOTICE_LABEL: Record<SoAmendmentLane, string> = {
  LINES: "product lines",
  DELIVERY: "delivery / customer info",
};

/** Permission key that signs each lane. MUST stay identical to the gate's own
 *  table (scm/shared/amendment-lane.ts LANE_APPROVE_KEY) — a drift here would
 *  notify a desk that cannot sign. Held as a literal rather than imported so a
 *  Houzs-side service does not pull in the SCM bundle; amendmentNotify.test.ts
 *  asserts the two tables agree. */
const LANE_APPROVE_PERM: Record<SoAmendmentLane, string> = {
  LINES: "scm.amendment.approve_lines",
  DELIVERY: "scm.amendment.approve_delivery",
};

export async function notifySoAmendmentRaised(
  env: Env,
  opts: {
    amendmentNo: string;
    soDocNo: string;
    lane: SoAmendmentLane | null;
    companyId?: number | string | null;
    reason?: string | null;
    requesterName?: string | null;
    /** users.id of the SO's salesperson, when it resolves. */
    salespersonUserId?: number | null;
    /** users.id of the person who raised it — excluded from every audience. */
    requesterUserId?: number | null;
  },
): Promise<void> {
  try {
    const laneLabel = opts.lane ? LANE_NOTICE_LABEL[opts.lane] : "amendment";
    const by = (opts.requesterName ?? "").trim();
    const raisedBy = by ? ` by ${by}` : "";
    const reason = shortReason(opts.reason);
    const tail = reason ? ` Reason: ${reason}` : "";
    const requester = Number(opts.requesterUserId) || 0;

    // 1. The desk that has to sign, plus its upline. A LEGACY (lane-null) row
    //    keeps the pre-rework key so the surviving chains still reach someone;
    //    mig 0225 is why Purchaser + Logistic hold it.
    const approvePerm = opts.lane
      ? LANE_APPROVE_PERM[opts.lane]
      : "scm.amendment.approve_so";
    const approvers = await usersHoldingPermission(env, approvePerm, {
      companyId: opts.companyId ?? null,
    });
    const approverAudience = cleanIds(await withUpline(env, approvers)).filter(
      (id) => id !== requester,
    );
    if (approverAudience.length > 0) {
      await postPersonalNotice(env, {
        userIds: approverAudience,
        category: "GENERAL",
        title: `SO amendment ${opts.amendmentNo} needs approval`,
        body:
          `Amendment ${opts.amendmentNo} on Sales Order ${opts.soDocNo} was raised${raisedBy} ` +
          `and is waiting for ${laneLabel} approval.${tail}`,
        source: SO_SOURCE,
      });
    }

    // 2. The salesperson whose order it is — informational, not a to-do, so it
    //    is a SEPARATE notice rather than the approver's card sent wider.
    const salesAudience = cleanIds([opts.salespersonUserId]).filter(
      (id) => id !== requester && !approverAudience.includes(id),
    );
    if (salesAudience.length > 0) {
      await postPersonalNotice(env, {
        userIds: salesAudience,
        category: "GENERAL",
        title: `Amendment ${opts.amendmentNo} raised on your Sales Order`,
        body:
          `Amendment ${opts.amendmentNo} was raised${raisedBy} on Sales Order ${opts.soDocNo} ` +
          `(${laneLabel}) and is waiting for approval.${tail}`,
        source: SO_SOURCE,
      });
    }
  } catch (e) {
    console.error("[amendment-notify] SO raised notify failed:", (e as Error).message);
  }
}

export async function notifySoAmendmentResolved(
  env: Env,
  opts: {
    amendmentNo: string;
    soDocNo: string;
    outcome: "approved" | "rejected";
    /** Rejection reason — the reject route requires one, so it is always set there. */
    reason?: string | null;
    actorName?: string | null;
    requesterUserId?: number | null;
    salespersonUserId?: number | null;
    /** users.id of whoever pressed the button — never notified of their own act. */
    actorUserId?: number | null;
  },
): Promise<void> {
  try {
    const actor = Number(opts.actorUserId) || 0;
    const audience = cleanIds([opts.requesterUserId, opts.salespersonUserId]).filter(
      (id) => id !== actor,
    );
    if (audience.length === 0) return;

    const byWhom = (opts.actorName ?? "").trim();
    const by = byWhom ? ` by ${byWhom}` : "";
    const reason = shortReason(opts.reason);
    await postPersonalNotice(env, {
      userIds: audience,
      // A rejection is the one that needs chasing — it rides the WARNING
      // category so the card reads as something to deal with, not an FYI.
      category: opts.outcome === "approved" ? "GENERAL" : "WARNING",
      title:
        opts.outcome === "approved"
          ? `SO amendment ${opts.amendmentNo} approved`
          : `SO amendment ${opts.amendmentNo} rejected`,
      body:
        opts.outcome === "approved"
          ? `Amendment ${opts.amendmentNo} was approved${by}. Sales Order ${opts.soDocNo} has been revised.`
          : `Amendment ${opts.amendmentNo} on Sales Order ${opts.soDocNo} was rejected${by}.` +
            (reason ? ` Reason: ${reason}` : ""),
      source: SO_SOURCE,
    });
  } catch (e) {
    console.error("[amendment-notify] SO resolved notify failed:", (e as Error).message);
  }
}

/* ── PO amendments ───────────────────────────────────────────────────────── */

export async function notifyPoAmendmentRaised(
  env: Env,
  opts: {
    amendmentNo: string;
    poNumber: string;
    companyId?: number | string | null;
    reason?: string | null;
    requesterName?: string | null;
    requesterUserId?: number | null;
    /** Set when the row was AUTO-raised by an approved SO amendment. */
    sourceSoAmendmentNo?: string | null;
  },
): Promise<void> {
  try {
    const requester = Number(opts.requesterUserId) || 0;
    const approvers = await usersHoldingPermission(env, "scm.po_amendment.approve", {
      companyId: opts.companyId ?? null,
    });
    const audience = cleanIds(await withUpline(env, approvers)).filter(
      (id) => id !== requester,
    );
    if (audience.length === 0) return;

    const src = (opts.sourceSoAmendmentNo ?? "").trim();
    const by = (opts.requesterName ?? "").trim();
    const reason = shortReason(opts.reason);
    await postPersonalNotice(env, {
      userIds: audience,
      category: "GENERAL",
      title: `PO amendment ${opts.amendmentNo} needs confirmation`,
      body: src
        ? `Approved SO amendment ${src} raised amendment ${opts.amendmentNo} on Purchase Order ` +
          `${opts.poNumber}. Confirming it applies the revised Sales Order to this PO.`
        : `Amendment ${opts.amendmentNo} on Purchase Order ${opts.poNumber} was raised` +
          `${by ? ` by ${by}` : ""} and is waiting for your confirmation.` +
          (reason ? ` Reason: ${reason}` : ""),
      source: PO_SOURCE,
    });
  } catch (e) {
    console.error("[amendment-notify] PO raised notify failed:", (e as Error).message);
  }
}

export async function notifyPoAmendmentResolved(
  env: Env,
  opts: {
    amendmentNo: string;
    poNumber: string;
    outcome: "approved" | "rejected";
    reason?: string | null;
    actorName?: string | null;
    requesterUserId?: number | null;
    actorUserId?: number | null;
  },
): Promise<void> {
  try {
    const actor = Number(opts.actorUserId) || 0;
    const audience = cleanIds([opts.requesterUserId]).filter((id) => id !== actor);
    if (audience.length === 0) return;

    const byWhom = (opts.actorName ?? "").trim();
    const by = byWhom ? ` by ${byWhom}` : "";
    const reason = shortReason(opts.reason);
    await postPersonalNotice(env, {
      userIds: audience,
      category: opts.outcome === "approved" ? "GENERAL" : "WARNING",
      title:
        opts.outcome === "approved"
          ? `PO amendment ${opts.amendmentNo} approved`
          : `PO amendment ${opts.amendmentNo} rejected`,
      body:
        opts.outcome === "approved"
          ? `Amendment ${opts.amendmentNo} was approved${by}. Purchase Order ${opts.poNumber} has been revised.`
          : `Amendment ${opts.amendmentNo} on Purchase Order ${opts.poNumber} was rejected${by}.` +
            (reason ? ` Reason: ${reason}` : ""),
      source: PO_SOURCE,
    });
  } catch (e) {
    console.error("[amendment-notify] PO resolved notify failed:", (e as Error).message);
  }
}
