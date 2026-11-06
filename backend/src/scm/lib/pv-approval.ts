// ----------------------------------------------------------------------------
// pv-approval — the owner's four layers (2026-09-02), as a pure table.
//
// His design, his words: draft 就是 raw draft… prepare 后会多两层 checking,
// 一层是 checked，一层是 approved, 当 approved 了才会进 gl. Whether the money
// truly left the bank is bank reconciliation's question, never this table's.
//
// The voucher's STATUS stays DRAFT through the whole cycle (markers, not
// statuses — the 0324 lesson); these questions are the entire state machine,
// and every route answers them here so the screen, the post gate and the
// tests can never disagree:
//
//   Draft     (no markers)     -> editable, preparable; nothing else
//   Prepared  (submitted_at)   -> STILL editable (owner: prepare 还可以改),
//                                 checkable, withdrawable; not approvable
//   Checked   (checked_at)     -> LOCKED (owner: checked 的人就不可以改了),
//                                 approvable / rejectable only; its words alone
//                                 may still change (owner 2026-11-06)
//   Approved  (approved_at)    -> the approve route posts the GL itself;
//                                 a voucher seen in this state without a JE
//                                 is a post that failed halfway — approve
//                                 again to finish it
//   POSTED / CANCELLED         -> read-only history
//
// A reject at EITHER layer clears every marker back to Draft (一律退回
// Draft), with the why on the audit trail. Check and approve are separate
// keys but the same person may hold both (可以同一个人，可以不同人). There is
// no fast path — the owner refused one; everyone walks the layers.
//
// Every refusal is a sentence for the operator, not a code for a programmer.
// ----------------------------------------------------------------------------

export type PvApprovalShape = {
  status: string;
  submitted_at?: string | null;
  checked_at?: string | null;
  approved_at?: string | null;
};

type Verdict = { ok: true } | { ok: false; error: string; message: string };

const notDraft = (pv: PvApprovalShape): Verdict | null => {
  if (pv.status === 'POSTED') {
    return { ok: false, error: 'already_posted', message: 'This voucher is already posted — it is history now.' };
  }
  if (pv.status === 'CANCELLED') {
    return { ok: false, error: 'cancelled', message: 'This voucher is cancelled.' };
  }
  return null;
};

/** May this voucher be edited (PATCH)? Draft AND Prepared say yes — the
    owner kept Prepared editable; the first yes (checked) is what locks it. */
export function pvCanEdit(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (pv.approved_at) {
    return {
      ok: false, error: 'already_approved',
      message: 'This voucher is approved — what was approved is what gets paid. It must be rejected back to draft to change.',
    };
  }
  if (pv.checked_at) {
    return {
      ok: false, error: 'already_checked',
      message: 'This voucher has been checked — it is locked. Reject it back to draft to change it.',
    };
  }
  return { ok: true };
}

/** May its words change — the notes and the lines' descriptions, nothing else
    (owner 2026-11-06: 有时我要改 description)? They move no money, so the first
    yes does not lock them. Approving writes the journal, which carries the lines'
    words, so the second yes does. */
export function pvCanEditText(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (pv.approved_at) {
    return { ok: false, error: 'already_approved', message: 'This voucher is approved — its journal carries these words, so they stay as they are.' };
  }
  return { ok: true };
}

/** May it be prepared (declared ready, into the checker's queue)? */
export function pvCanPrepare(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (pv.submitted_at) {
    return { ok: false, error: 'already_prepared', message: 'This voucher is already prepared.' };
  }
  return { ok: true };
}

/** May it be checked (the first yes)? Only a prepared, unchecked voucher. */
export function pvCanCheck(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.submitted_at) {
    return { ok: false, error: 'not_prepared', message: 'This voucher was never prepared — there is nothing to check yet.' };
  }
  if (pv.checked_at) {
    return { ok: false, error: 'already_checked', message: 'This voucher is already checked — it is waiting for approval.' };
  }
  return { ok: true };
}

/** May it be approved? Only after the first yes. Approving IS posting. */
export function pvCanApprove(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.checked_at) {
    return {
      ok: false, error: 'not_checked',
      message: pv.submitted_at
        ? 'This voucher has not been checked yet — the first yes comes before yours.'
        : 'This voucher was never prepared — there is nothing to approve.',
    };
  }
  if (pv.approved_at) {
    return { ok: false, error: 'already_approved', message: 'This voucher is already approved.' };
  }
  return { ok: true };
}

/** May it be rejected back to Draft? At either checking layer. */
export function pvCanReject(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.submitted_at) {
    return { ok: false, error: 'not_prepared', message: 'This voucher was never prepared — there is nothing to reject.' };
  }
  return { ok: true };
}

/** May the preparer pull it back themselves? Only before the first yes —
    after checked it is the checkers' document; ask for a reject instead. */
export function pvCanWithdraw(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.submitted_at) {
    return { ok: false, error: 'not_prepared', message: 'This voucher is not in the cycle.' };
  }
  if (pv.checked_at) {
    return { ok: false, error: 'already_checked', message: 'This voucher has been checked — it can only be rejected back, not withdrawn.' };
  }
  return { ok: true };
}

/** The gate on the one door money leaves through. The approve route walks
    through it in the same breath; it also stands alone so a post that died
    between approval and JE can be finished (idempotently) by approving
    again — and so nothing else can ever post an unapproved voucher. */
export function pvCanPost(pv: PvApprovalShape): Verdict {
  if (!pv.approved_at) {
    return {
      ok: false, error: 'not_approved',
      message: pv.checked_at
        ? 'This voucher is checked and awaiting approval — it posts the moment someone with approval permission says yes.'
        : 'This voucher has not been through the checking layers. Prepare it, have it checked, then approved.',
    };
  }
  return { ok: true };
}

/** May the approver be reminded of it (Remind approver, the redesign's e8)?
    Only while it waits for the second yes: checked and not posted — an
    approval that died before its post included, since approving again
    finishes it. A reminder changes nothing on the voucher. */
export function pvCanRemind(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.checked_at) {
    return {
      ok: false, error: 'not_checked',
      message: pv.submitted_at
        ? 'This voucher is not checked yet — only a checked voucher waits for the approver.'
        : 'This voucher was never prepared — nothing waits for the approver yet.',
    };
  }
  return { ok: true };
}
