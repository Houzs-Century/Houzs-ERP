// ----------------------------------------------------------------------------
// so-amendment-submit — what pressing the primary button on a PROCESSING-LOCKED
// SO should actually do. PURE: no React, no I/O. Desktop SalesOrderDetail and
// mobile MobileNewSO both classify through here so the answer cannot drift.
//
// WHY THIS EXISTS (2026-08-21). An edit on a locked SO has TWO halves
// (so-amendment-header.ts): FREE fields save directly, CONTROLLED fields and
// line changes ride an amendment. Both surfaces had ONE early-return covering
// BOTH halves — it asked only "is there anything for the AMENDMENT?" and
// answered "No changes to submit" when there was not. Neither surface asked
// whether the DIRECT half had anything, so each got it wrong in its own way:
//
//   * Desktop returned BEFORE handle.save() ran, so a contact-only edit was
//     silently DISCARDED — while the banner on the same screen promised those
//     details "save straight away".
//   * Mobile PATCHed the direct half BEFORE the check, so the edit landed and
//     the operator was then told "No changes to submit". Saved, reported failed.
//
// Same missing question, opposite symptoms. The rule is one line: an amendment
// is needed only for the approval half; the direct half is saved either way;
// and "nothing to submit" is true only when BOTH halves are empty.
// ----------------------------------------------------------------------------

/** What the operator's in-flight edit adds up to. */
export type AmendmentSubmitPlan =
  /** Neither half has a change — the only case that is a genuine error. */
  | 'NOTHING'
  /** Only FREE fields moved. Save them directly; raise no amendment. */
  | 'DIRECT_ONLY'
  /** Lines and/or CONTROLLED header fields moved: direct half first, then the
      amendment for approval. */
  | 'AMENDMENT';

export type AmendmentSubmitInput = {
  /** buildAmendmentLines() returned at least one ADD / EDIT / REMOVE. */
  hasLineChanges: boolean;
  /** hasAmendmentHeaderChanges(getLockedHeaderChanges()) — CONTROLLED columns. */
  hasFrozenHeaderChanges: boolean;
  /** The FREE half is dirty: customer name / phone / email / note — anything
      the header PATCH still writes directly while the SO is locked. */
  hasDirectHeaderChanges: boolean;
  /** Mobile stages payments in the same form and posts them at the end of this
      same submit. A payment needs no approval, but it IS a change: without this
      a payment-only edit on a locked SO was refused "No changes to submit" and
      could never be booked from that screen — the row survives in the form, so
      every retry hit the same wall. Desktop books payments from their own card
      and passes false. */
  hasStagedPayments?: boolean;
};

export function planAmendmentSubmit(input: AmendmentSubmitInput): AmendmentSubmitPlan {
  if (input.hasLineChanges || input.hasFrozenHeaderChanges) return 'AMENDMENT';
  if (input.hasDirectHeaderChanges || input.hasStagedPayments) return 'DIRECT_ONLY';
  return 'NOTHING';
}

/** Shown only for 'NOTHING'. Names the things that need approval, because those
    are what the button raises — the FREE half never gets this far. */
export const AMENDMENT_NOTHING_TO_SUBMIT =
  'No changes to submit — edit a line, a date or the delivery address first, then submit the amendment.';

/** Shown for 'DIRECT_ONLY'. Says the work landed AND why no approval appeared,
    so the absent amendment does not read as a failure. Deliberately does not
    enumerate the fields: desktop reaches this with contact details, mobile can
    reach it with a payment, and one wrong noun here is how the banner this PR
    also fixes went stale. */
export const AMENDMENT_DIRECT_ONLY_SAVED_TITLE = 'Saved without an amendment';
export const AMENDMENT_DIRECT_ONLY_SAVED_BODY =
  'Those changes save straight to the order, so nothing needed approval.';

/** What to tell the operator once the submit lands. Takes the RAW create
    response so the cast lives here rather than at both call sites.

    Shared because desktop and mobile each had their own copy of the two-lane
    message and the copies had already drifted — one said a split amendment
    applies "as soon as its approver signs", the other "when its approver
    signs". Same drift as the banner below, one screen over. */
export function amendmentSubmittedNotice(
  plan: AmendmentSubmitPlan,
  createdRes: unknown,
): { title: string; body: string } {
  if (plan === 'DIRECT_ONLY') {
    return { title: AMENDMENT_DIRECT_ONLY_SAVED_TITLE, body: AMENDMENT_DIRECT_ONLY_SAVED_BODY };
  }
  const created = (createdRes as {
    amendments?: Array<{ amendment_no?: string | null; lane?: string | null }>;
  } | null | undefined)?.amendments ?? [];
  const lane = (l?: string | null) =>
    l === 'LINES' ? 'Purchasing' : l === 'DELIVERY' ? 'Logistics' : '';
  if (created.length > 1) {
    return {
      title: 'Amendment split into two approvals',
      body: `${created.map((a) => `${a.amendment_no ?? ''} → ${lane(a.lane)}`).join('; ')}`
        + '. Each applies as soon as its approver signs.',
    };
  }
  if (created[0]?.lane) {
    return {
      title: 'Amendment submitted',
      body: `Waiting for ${lane(created[0].lane)} — one signature applies it to the order.`,
    };
  }
  return { title: 'Amendment submitted', body: 'It now needs approval before the order is revised.' };
}

/** The amendment-mode banner, in ONE place because it was wrong in two.
    Addresses joined the CONTROLLED set on 2026-07-27 (two-lane phase 2,
    so-field-policy) and both banners still told the operator that address lines
    "save straight away" — the exact opposite of what the server now does. */
export const AMENDMENT_MODE_BANNER =
  'This order is already ordered from the supplier. Edit the lines, dates or delivery '
  + 'address as usual — your request goes to the coordinator and supplier to confirm '
  + 'before the order is revised. Customer name, phone, email and the note save straight away.';
