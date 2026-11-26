
import { AMENDMENT_APPROVER_LABEL, soAmendmentApprover } from './amendment-approver';

/** What the operator's in-flight edit adds up to. */
export type AmendmentSubmitPlan =
  | 'NOTHING'
  | 'DIRECT_ONLY'
  | 'AMENDMENT';

export type AmendmentSubmitInput = {
  hasLineChanges: boolean;
  hasFrozenHeaderChanges: boolean;
  hasDirectHeaderChanges: boolean;
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

/** The reason prompt's validation message, shared by both surfaces (owner
    2026-09-15: the reason is REQUIRED; the server refuses 400 reason_required
    without one). */
export const AMENDMENT_REASON_REQUIRED =
  'A reason is required — the approver reads it before the changes.';

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
  const res = createdRes as {
    amendments?: Array<{ amendment_no?: string | null; lane?: string | null }>;
    autoApplied?: number;
  } | null | undefined;
  const created = res?.amendments ?? [];
  /* Applied on the spot, no signature waiting (owner 2026-09-24): the Logistic
     desk changing a delivery date / customer detail on a locked order. Say it
     APPLIED — 'submitted, waiting for Logistic' would send them looking for a
     queue row that is already signed. A partial (one half applied, the other
     still with its desk) falls through to the split message below, which names
     both halves and is true of it. */
  const applied = res?.autoApplied ?? 0;
  if (applied > 0 && applied === created.length) {
    return {
      title: created.length > 1 ? 'Changes applied' : 'Change applied',
      body: 'Applied to the order straight away — the delivery desk signs its own changes, so no approval was needed.',
    };
  }
  const lane = (l?: string | null) =>
    (l === 'LINES' || l === 'DELIVERY' ? AMENDMENT_APPROVER_LABEL[soAmendmentApprover(l)] : '');
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
    "save straight away" — the exact opposite of what the server now does.
    Customer name / phone / email made the same move on 2026-08-21 and the
    banner kept promising they saved directly for three weeks (HC-SO-013497).
    The list of what saves straight away is the FREE set in so-field-policy —
    keep it in step with that table, not with memory. */
export const AMENDMENT_MODE_BANNER =
  'This order is already ordered from the supplier. Edit the lines, dates, delivery '
  + 'address or customer name, phone and email as usual — your request goes to the '
  + 'coordinator and supplier to confirm before the order is revised. The note, '
  + 'customer type and emergency contact save straight away.';
