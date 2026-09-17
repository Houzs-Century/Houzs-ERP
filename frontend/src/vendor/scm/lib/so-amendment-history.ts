/* so-amendment-history — the ONE logic layer that turns the SO audit trail into
   an amendment's approve / reject decision record (owner ask 2026-07-18: "整个 SO
   Amendment 是不是都可以看到它的 approve 记录和 reject 记录" — the approve AND reject
   history, WHO, WHEN, and the reason, on both desktop and mobile).

   WHY this exists rather than reading the amendment's own *_by / *_at columns:
   the reject gate stores NO timestamp/actor column at all — it only flips status
   to REJECTED (backend so-amendments.ts). The reason, actor and time of a
   rejection survive ONLY in mfg_so_audit_log (action AMENDMENT_REJECTED,
   note = reason). So the column-derived timeline could never show a rejection.
   The audit log is the honest, complete source: every gate writes one
   AMENDMENT_* row through recordSoAudit. Both surfaces read it via the SAME
   vendored useSalesOrderAuditLog hook and this shared builder.

   Isolation to ONE amendment: the audit log is keyed by so_doc_no, and an SO can
   carry several amendments over its life (a rejected one, then a fresh one). The
   backend's one-open partial-unique index means only one amendment is in flight
   at a time, so a NEW amendment is always raised AFTER the prior one reached a
   terminal decision. Therefore every AMENDMENT_* row at created_at >= this
   amendment's created_at belongs to THIS amendment's lifecycle; earlier rows
   belong to earlier amendments. That time floor is the clean boundary. */

import type { SoAuditEntry } from './sales-order-queries';

export type AmendmentDecisionEvent = {
  id: string;
  action: string;
  label: string;
  /* Name snapshotted at write time (mfg_so_audit_log.actor_name_snapshot) — stays
     stable if the staff row is later renamed. Null when the writer left it blank. */
  actor: string | null;
  at: string;
  /* The reason / reference the gate recorded: the rejection reason, the supplier
     confirmation ref, or the apply summary. Null when none was given. */
  note: string | null;
};

/* AMENDMENT_* action -> plain label. Unmapped keys (e.g. a future AMENDMENT_CMD_*
   variant) fall back to a humanised form, so a new gate is never invisible. */
const AMENDMENT_ACTION_LABEL: Record<string, string> = {
  AMENDMENT_REQUESTED:          'Requested',
  AMENDMENT_SUPPLIER_CONFIRMED: 'Supplier confirmed',
  AMENDMENT_SO_APPROVED:        'SO revision approved',
  AMENDMENT_PO_APPROVED:        'PO revision approved',
  AMENDMENT_PO_REVISED:         'PO revised',
  AMENDMENT_SENT:               'Sent to supplier',
  AMENDMENT_REJECTED:           'Rejected',
  AMENDMENT_LANE_FLAGGED:       'Passed to the other approver',
  AMENDMENT_CMD_SUPPLIER_CONFIRM: 'Supplier confirm sent to 2990',
  AMENDMENT_CMD_APPROVE_SO:       'SO approval sent to 2990',
  AMENDMENT_CMD_APPROVE_PO:       'PO approval sent to 2990',
  AMENDMENT_CMD_SEND:             'Send sent to 2990',
  AMENDMENT_CMD_REJECT:           'Rejection sent to 2990',
};

export function amendmentActionLabel(action: string): string {
  return (
    AMENDMENT_ACTION_LABEL[action] ??
    action.replace(/^AMENDMENT_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase())
  );
}

/* An amendment decision is REJECTED — the surfaces tint that row (owner wants the
   rejection to read unmistakably, not blend into the approvals). */
export function isRejectDecision(action: string): boolean {
  return action === 'AMENDMENT_REJECTED' || action === 'AMENDMENT_CMD_REJECT';
}

/* Build this amendment's decision history, newest first (the endpoint already
   returns newest-first; we preserve that order). Pass the amendment's own
   created_at as the floor so earlier amendments on the same SO are excluded. A
   null/absent floor means "no isolation possible" — show every AMENDMENT_* row
   rather than hide the history entirely. */
export function buildAmendmentDecisionHistory(
  entries: SoAuditEntry[] | undefined | null,
  amendmentCreatedAt: string | null | undefined,
): AmendmentDecisionEvent[] {
  const rows = entries ?? [];
  const floor = amendmentCreatedAt ? Date.parse(amendmentCreatedAt) : NaN;
  const out: AmendmentDecisionEvent[] = [];
  for (const e of rows) {
    if (typeof e.action !== 'string' || !e.action.startsWith('AMENDMENT_')) continue;
    if (!Number.isNaN(floor)) {
      const t = Date.parse(e.created_at);
      // Keep only this amendment's lifecycle (>= floor). Unparseable timestamps
      // are kept — dropping a real decision is worse than an out-of-window one.
      if (!Number.isNaN(t) && t < floor) continue;
    }
    const note = typeof e.note === 'string' && e.note.trim() ? e.note.trim() : null;
    out.push({
      id: e.id,
      action: e.action,
      label: amendmentActionLabel(e.action),
      actor: e.actor_name_snapshot ?? null,
      at: e.created_at,
      note,
    });
  }
  return out;
}
