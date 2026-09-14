// ----------------------------------------------------------------------------
// payment-reason — WHEN a payment action asks for a reason, and in what words.
//
// Shared by the desktop payments table and the mobile recorded-payments list,
// which have diverged on this predicate before (the delete path vs the edit
// path, 2026-07-19): one home, one wording, one reading of the key.
//
// Two rules, from two rulings:
//   amend  — a correction the amend right opened after the day the payment
//            was keyed owes a reason (owner 2026-09-10: 靠权限改的来决定). The
//            predicate says so: `paymentRowMutable(...).via === 'amend'`.
//   holder — a ROLE that holds `scm.so_payment.amend` LITERALLY owes a reason
//            on EVERY payment action — record, change, remove, attach proof —
//            same day or not (owner 2026-09-14, docs/bugs/0888: 只要是有关
//            collection payment 的，我或有权限的用户做的动作都要记录写 reason).
//            Read through `holdsPermissionLiterally`, so the Owner's wildcard
//            alone is not a holder; the server reads the key the same way
//            (holdsHouzsPermLiterally) and refuses a holder's write without.
// ----------------------------------------------------------------------------

import { holdsPermissionLiterally, type PermissionHolder } from '../../../auth/literalPermission';
import type { PaymentChangeVia } from './so-field-policy';

export const SO_PAYMENT_AMEND = 'scm.so_payment.amend';

/** Does every payment action by this user owe a reason and land on
    Accounting › Corrections? */
export const owesPaymentReason = (user: PermissionHolder): boolean =>
  holdsPermissionLiterally(user, SO_PAYMENT_AMEND);

export type ReasonWhy = 'amend' | 'holder';

/** Why a reason is owed on THIS row, or null when none is: the holder rule
    first — it covers every row — else the amend right when it is what opened
    the door. */
export const reasonWhyFor = (via: PaymentChangeVia, holder: boolean): ReasonWhy | null =>
  (holder ? 'holder' : via === 'amend' ? 'amend' : null);

export type PaymentAction = 'add' | 'edit' | 'delete' | 'proof' | 'proof-replace';

export const AMEND_ASK_BODY = 'Finance keeps a record of every correction made after the day it was keyed in.';
export const HOLDER_ASK_BODY = 'Your role holds the payment-correction right, so every payment you record, '
  + 'change, remove or attach proof to is listed on Accounting › Corrections with its reason.';

/** What the shared prompt is asked with — `usePrompt` returns the trimmed
    text on confirm and null on cancel, and a REQUIRED input cannot be
    confirmed blank, so a non-null answer is never empty. */
export type PaymentReasonAsk = {
  title: string;
  body: string;
  input: { label: string; placeholder: string; required: true };
  confirmLabel: string;
  danger?: boolean;
};

const TITLE: Record<PaymentAction, string> = {
  add: 'Why is this payment being recorded?',
  edit: 'Why is this payment being corrected?',
  delete: 'Why is this payment being removed?',
  proof: 'Why is this proof being attached?',
  'proof-replace': 'Why is this proof being replaced?',
};
const PLACEHOLDER: Record<PaymentAction, string> = {
  add: 'Balance collected on delivery, slip received today',
  edit: 'Sales keyed RM 1,990 — receipt shows RM 1,991',
  delete: 'Keyed twice — duplicate of the RM 500 on 29/08',
  proof: 'Customer sent the slip by WhatsApp today',
  'proof-replace': 'The first photo was the wrong slip',
};
const CONFIRM: Record<PaymentAction, string> = {
  add: 'Save payment', edit: 'Save changes', delete: 'Continue', proof: 'Attach', 'proof-replace': 'Replace',
};

/** The prompt for one action, asked BEFORE the write; the answer rides the
    write as `reason`, and a dismissed prompt (null) abandons the write. */
export function paymentReasonAsk(action: PaymentAction, why: ReasonWhy): PaymentReasonAsk {
  return {
    title: TITLE[action],
    body: why === 'holder' ? HOLDER_ASK_BODY : AMEND_ASK_BODY,
    input: { label: 'Reason', placeholder: PLACEHOLDER[action], required: true },
    confirmLabel: CONFIRM[action],
    ...(action === 'delete' ? { danger: true } : {}),
  };
}
