// ----------------------------------------------------------------------------
// pv-approval — accounting phase 3, the rules as a pure table.
//
// Money leaves only after a yes. The voucher's STATUS stays DRAFT through the
// whole cycle (markers, not statuses — the 0324 lesson); these four questions
// are the entire state machine, and every route answers them here so the
// screen, the post gate and the tests can never disagree:
//
//   DRAFT, unsubmitted   -> editable, submittable, not approvable, not postable
//   DRAFT, submitted     -> frozen (withdraw to edit), approvable, not postable
//   DRAFT, approved      -> frozen, postable; withdraw/reject sends it back
//   POSTED / CANCELLED   -> none of these; the document is read-only history
//
// Every refusal is a sentence for the operator, not a code for a programmer.
// ----------------------------------------------------------------------------

export type PvApprovalShape = {
  status: string;
  submitted_at?: string | null;
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

/** May this voucher be edited (PATCH)? Only before it enters the queue. */
export function pvCanEdit(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (pv.approved_at) {
    return {
      ok: false, error: 'awaiting_post',
      message: 'This voucher is approved — what was approved is what gets paid. Withdraw it to edit, and it will need approval again.',
    };
  }
  if (pv.submitted_at) {
    return {
      ok: false, error: 'awaiting_approval',
      message: 'This voucher is in the approval queue. Withdraw it to edit.',
    };
  }
  return { ok: true };
}

/** May it be submitted for approval? */
export function pvCanSubmit(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (pv.submitted_at) {
    return { ok: false, error: 'already_submitted', message: 'This voucher is already in the approval queue.' };
  }
  return { ok: true };
}

/** May it be approved / rejected? Only while it is actually in the queue. */
export function pvCanDecide(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.submitted_at) {
    return { ok: false, error: 'not_submitted', message: 'This voucher was never submitted for approval — there is nothing to decide.' };
  }
  if (pv.approved_at) {
    return { ok: false, error: 'already_approved', message: 'This voucher is already approved.' };
  }
  return { ok: true };
}

/** May it be withdrawn (back to editable)? Any time it is in the cycle. */
export function pvCanWithdraw(pv: PvApprovalShape): Verdict {
  const dead = notDraft(pv);
  if (dead) return dead;
  if (!pv.submitted_at && !pv.approved_at) {
    return { ok: false, error: 'not_submitted', message: 'This voucher is not in the approval queue.' };
  }
  return { ok: true };
}

/** The gate on the one door money leaves through. */
export function pvCanPost(pv: PvApprovalShape): Verdict {
  if (!pv.approved_at) {
    return {
      ok: false, error: 'not_approved',
      message: pv.submitted_at
        ? 'This voucher is awaiting approval — it posts once someone with approval permission says yes.'
        : 'This voucher has not been through approval. Submit it, get it approved, then post.',
    };
  }
  return { ok: true };
}
