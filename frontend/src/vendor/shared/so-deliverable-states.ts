/* ----------------------------------------------------------------------------
   so-deliverable-states — the ONE declaration of "may a Delivery Order be
   raised from this Sales Order".

   WHY THIS FILE EXISTS. The rule was written TWICE, in two shapes that are not
   equivalent, and the two disagreed about the single most important status in
   the set.

     SERVER  routes/delivery-orders-mfg.ts held SO_UNDELIVERABLE_STATUSES — a
             DENY-list of {DRAFT, CANCELLED, ON_HOLD}, with its own comment
             stating the intent in full: "The block set is a DENY-list (not an
             allow-list) so any legitimate forward status (CONFIRMED,
             IN_PRODUCTION, DELIVERED, ...) stays deliverable."

     CLIENT  MfgSalesOrdersListV2.tsx's row-drawer CTA switched on
             `if (s === 'confirmed')` — an ALLOW-list of exactly one value.

   A deny-list of three and an allow-list of one are not the same rule, and the
   gap is every forward status. The one that cost the business is READY_TO_SHIP.

   WHAT IT DID, in the owner's terms. READY_TO_SHIP is not typed by anyone — it
   is written AUTOMATICALLY by recomputeSoStockAllocation the moment the stock
   for an order is all in (so-stock-allocation.ts is its only writer). So the
   sequence was:

     the goods arrive -> the system promotes the order to READY_TO_SHIP
                      -> "Transfer to Delivery Order" DISAPPEARS from the row

   The button was absent at exactly the moment the order was most ready to ship,
   and it went absent by itself, with nothing on screen saying why. The server
   would have accepted the delivery the whole time. Reported by the owner
   2026-08-21 as "why does 2990 have Transfer to DO and Houzs Century does
   not" — it was never a company difference: he happened to be looking at a
   CONFIRMED order in one tenant and a READY_TO_SHIP one in the other, and the
   predicate carries no company term.

   The desktop SO DETAIL page offers no transfer at all, so for a READY_TO_SHIP
   order the only remaining desktop routes were the Delivery Planning board's
   context menu and the delivery-order side's own from-SO picker.

   THE DENY-LIST IS THE RULE, and it stays a deny-list. An allow-list has to be
   extended every time a status is added and is silently wrong until someone
   notices; a deny-list names the three states that genuinely cannot ship and
   lets everything else through, which is this system's standing posture (see
   do-shipped-states.ts on the owner's 不要拦 —— 人自己知道 ruling).

   ON_HOLD is a deliberate member. delivery-orders-mfg.ts flagged it when the
   deny-list was written: an order paused mid-flight should not ship until it is
   taken off hold.

   Pure constants, no imports. frontend/src/vendor/shared/so-deliverable-states.ts
   is a byte-identical vendored copy for the browser, refereed by
   so-deliverable-states.canonical.test.ts on the frontend side.
   ---------------------------------------------------------------------------- */

/** Sales-Order statuses from which a Delivery Order may NOT be raised: a DRAFT
 *  is not committed, a CANCELLED order is dead, and an ON_HOLD order is paused
 *  on purpose. Everything else — CONFIRMED, IN_PRODUCTION, READY_TO_SHIP,
 *  SHIPPED, DELIVERED, INVOICED, CLOSED — is deliverable. */
export const SO_UNDELIVERABLE_STATUSES = ['DRAFT', 'CANCELLED', 'ON_HOLD'] as const;

/** May a Delivery Order be raised from a Sales Order in this status?
 *
 *  Case-insensitive and null-safe, because both callers read a nullable text
 *  column and the list payload has been observed handing back "Draft" /
 *  "draft" / "DRAFT" for the same row.
 *
 *  A BLANK OR UNREADABLE STATUS RETURNS TRUE, and that is the same
 *  never-over-block choice the server makes (firstUndeliverableSo lets a row
 *  with no readable status fall through). The server is the gate; this
 *  predicate decides whether to OFFER the action, and offering an action the
 *  server then refuses with a plain-language 409 is strictly better than hiding
 *  one it would have accepted. Hiding is what this file exists to stop. */
export function soCanRaiseDo(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return !(SO_UNDELIVERABLE_STATUSES as readonly string[]).includes(s);
}

export type SoUndeliverableStatus = (typeof SO_UNDELIVERABLE_STATUSES)[number];
