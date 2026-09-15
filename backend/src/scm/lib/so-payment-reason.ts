// ----------------------------------------------------------------------------
// so-payment-reason — WHEN a payment write owes a reason, and what the audit
// row then carries. One rule for the four payment routes in
// routes/mfg-sales-orders.ts (add, edit, delete, proof attach), which is why
// it is not written inline four times.
//
// Two rulings:
//   amend  — a correction the amend right opened after the day the payment
//            was keyed owes a reason (owner 2026-09-10, docs/bugs/0785):
//            `paymentMayChange(...).via === 'amend'`, which the edit and the
//            delete pass in as `viaAmend`.
//   holder — a ROLE that holds `scm.so_payment.amend` LITERALLY owes a reason
//            on EVERY payment action, same day or not (owner 2026-09-14,
//            docs/bugs/0888: 只要是有关 collection payment 的，我或有权限的用户
//            做的动作都要记录写 reason). `holdsHouzsPermLiterally`: the Owner's
//            `*` alone is not a holder, so the rule reaches exactly the roles
//            the owner named the key on (granted per ROLE under Team > Roles &
//            Permissions). It never opens a door — the window still comes from
//            `paymentMayChange` — it only decides whether a reason is owed and
//            whether the row is marked for Accounting › Corrections.
// ----------------------------------------------------------------------------

import { holdsHouzsPermLiterally } from './houzs-perms';
import { SO_PAYMENT_AMEND } from '../../acc/payment-reconciled';
import { AMEND_SOURCE, KEY_HOLDER_REASON_REQUIRED, REASON_REQUIRED } from '../../acc/payment-corrections';

type HouzsUserSource = Parameters<typeof holdsHouzsPermLiterally>[0];

/** A body reason is capped by its zod schema; a query-borne one (the DELETE)
    is capped here, the same 500. */
const MAX_REASON = 500;

export type PaymentReasonRule = {
  /** The caller's ROLE names the key — the literal reading. */
  keyHolder: boolean;
  /** A reason is owed on this write. */
  owed: boolean;
  /** The 400 body to answer with when a reason is owed and none came:
      the holder's sentence for a holder, the amend sentence otherwise. */
  refusal: typeof KEY_HOLDER_REASON_REQUIRED | typeof REASON_REQUIRED | null;
  /** What the audit row carries — the amend source and the reason — or
      nothing, so a same-day fix by a role without the key writes the row it
      always did. Empty when a reason is owed and missing: `refusal` is
      answered first. */
  audit: { source: string; note: string } | Record<string, never>;
};

export function paymentReasonRule(
  c: HouzsUserSource,
  p: { reason?: string | null; viaAmend?: boolean },
): PaymentReasonRule {
  const keyHolder = holdsHouzsPermLiterally(c, SO_PAYMENT_AMEND);
  const owed = keyHolder || p.viaAmend === true;
  const reason = String(p.reason ?? '').trim().slice(0, MAX_REASON);
  return {
    keyHolder,
    owed,
    refusal: owed && !reason ? (keyHolder ? KEY_HOLDER_REASON_REQUIRED : REASON_REQUIRED) : null,
    audit: owed && reason ? { source: AMEND_SOURCE, note: reason } : {},
  };
}
