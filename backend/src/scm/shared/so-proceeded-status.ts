/* ---------------------------------------------------------------------------
   PROCEEDED IS THE DATE — the OTHER half of the rule.
 
   The owner has stated it three times, most recently on 2026-09-01 looking at
   IN PRODUCTION = 0 with 108 confirmed orders on the board:
     「只要有 Processing Date, 就代表他 Proceed 了。」
     「In Production 就是当你 proceed 了订单，就要直接 show 出来在 In Production
       了呀。全套系统 而不是针对单一公式。」
 
   Only ONE direction of that rule was implemented. `PATCH /:docNo/status` to
   IN_PRODUCTION refuses without a Processing Date — so the status implies the
   date. Nothing made the date imply the STATUS, so a header save could set a
   Processing Date and leave the order sitting in CONFIRMED, invisible to the
   board the factory works from.
 
   That is not a display bug and a data repair does not close it: the repair
   moves the rows that are wrong TODAY, and the next header save makes new ones.
   This is the rule, in one place, so every writer of a Processing Date gets the
   same answer.
 
   WHAT IT DELIBERATELY WILL NOT DO
   · never moves an order that is not CONFIRMED. DRAFT has not been confirmed
     and READY_TO_SHIP / DELIVERED / INVOICED are FURTHER along — pulling one
     back to production is a demotion, not a repair, and the repair script
     refuses the same set for the same reason.
   · never moves on a date that was ALREADY there. Editing a delivery date, a
     customer address or a line on an order that has carried a Processing Date
     for months is not a proceed; only the transition null -> date is.
   · never moves a CANCELLED order, whatever it carries.
   · never moves BACKWARDS when a date is cleared. THAT DECISION HAS NOW BEEN
     MADE — see statusAfterProcessingDateCleared below — and it is a separate
     function on purpose: this one answers "did they proceed", and the other
     answers "did they un-proceed". Neither infers the other's case.
 
   Returns the status to write, or null for "leave the status alone" — so a
   caller that ignores the null is making a visible mistake rather than a silent
   one.
   --------------------------------------------------------------------------- */

/** The one status a newly-dated order may move to, and the only one it may move
 *  FROM. Exported so a test can state the pair rather than restate the strings. */
export const PROCEED_FROM_STATUS = 'CONFIRMED';
export const PROCEED_TO_STATUS = 'IN_PRODUCTION';

export function statusAfterProcessingDateSet(input: {
  /** The order's status BEFORE this save. */
  currentStatus: string | null | undefined;
  /** The Processing Date stored before this save — null when it had none. */
  storedProcessingDate: string | null;
  /** The Processing Date this save leaves behind. */
  effectiveProcessingDate: string | null;
}): string | null {
  const had = !!(input.storedProcessingDate ?? '').trim();
  const has = !!(input.effectiveProcessingDate ?? '').trim();
  /* The PROCEED is the transition, not the presence. */
  if (had || !has) return null;
  const cur = String(input.currentStatus ?? '').trim().toUpperCase();
  if (cur !== PROCEED_FROM_STATUS) return null;
  return PROCEED_TO_STATUS;
}

/* ---------------------------------------------------------------------------
   AND THE WAY BACK — the owner closed the open decision on 2026-09-03.

   He cleared the Processing Date on HC-SO-013361 and the order stayed
   IN_PRODUCTION, because only the forward half of 「只要有 Processing Date, 就代表
   他 Proceed 了」 had ever been built. Given three options he chose the symmetric
   one, guarded:

     「B 其实就看有没有 date 就知道了」

   So the date IS the answer, in both directions: a date means in production, no
   date means not. What the guard adds is the one case where that would be a
   LIE — an order somebody has already delivered or invoiced is not "not in
   production", it is further along, and pulling it back would hide a real
   document from the board. The forward rule refuses the same set for the same
   reason.
   --------------------------------------------------------------------------- */

export function statusAfterProcessingDateCleared(input: {
  /** The order's status BEFORE this save. */
  currentStatus: string | null | undefined;
  /** The Processing Date stored before this save. */
  storedProcessingDate: string | null;
  /** The Processing Date this save leaves behind — null when it was cleared. */
  effectiveProcessingDate: string | null;
  /** TRUE when a live delivery order or sales invoice exists for this order.
   *  REQUIRED, not optional: its absence would silently demote an order that has
   *  already shipped, which is the one outcome this rule must never produce. */
  hasDownstream: boolean;
}): string | null {
  const had = !!(input.storedProcessingDate ?? '').trim();
  const has = !!(input.effectiveProcessingDate ?? '').trim();
  /* The UN-PROCEED is the transition, not the absence: an order that never had
     a date is not un-proceeding by saving without one. */
  if (!had || has) return null;
  if (input.hasDownstream) return null;
  const cur = String(input.currentStatus ?? '').trim().toUpperCase();
  /* Only ever out of the status the forward rule puts it in. CANCELLED,
     READY_TO_SHIP and everything past it are left exactly alone. */
  if (cur !== PROCEED_TO_STATUS) return null;
  return PROCEED_FROM_STATUS;
}
