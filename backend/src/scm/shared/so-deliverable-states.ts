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

   CLOSED IS THE FOURTH MEMBER, added 2026-08-22, and it is the one that shows
   why a deny-list still has to be maintained. Close means STOP CHASING THE
   REMAINDER — the customer took 7 of the 10, or the supplier cannot supply the
   last 3, and what already went out stands (owner, asked whether the case
   happens here: 「有的」). If the remainder is not coming, there is nothing left
   to raise a delivery order for. It reads as a forward status, so the standing
   posture above — let every forward status through — would have let it ship, and
   that is the ONE way a deny-list can be wrong: not by blocking too much, by
   never hearing about a status that genuinely cannot ship. Nothing new is
   BLOCKED that used to work: a delivery order already raised is untouched, and
   closing is the act of saying the rest is not coming.

   NOT THE SAME AS CANCELLED, and they sit next to each other in this list. A
   cancelled order is void as if it never happened; a closed one is a real sale
   that came up short. Same answer to this one question, different documents.

   THE HOLD IS NOW A SEPARATE ARGUMENT, not a status (mig 0324, owner 2026-08-22:
   「我们的hold是给我们知道一个 order hold这的」). A hold is a MARKER beside the
   status, so a held IN_PRODUCTION order reads status IN_PRODUCTION and
   on_hold true — and the status half of this deny-list would wave it straight
   through. `ON_HOLD` STAYS in the list anyway, for ever: Postgres cannot drop an
   enum label, so a legacy or mirrored row can still arrive carrying it, and
   dropping it here would make that row shippable for the first time.

   `onHold` IS A REQUIRED PARAMETER AND HAS NO DEFAULT, which is this repo's
   standing rule for an argument that DECIDES something. An optional one would
   mean every caller that says nothing keeps the OLD behaviour with no compile
   error — the exact shape of BUG CLASS optional-param-noop
   (docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md),
   and here "the old behaviour" is "the hold does not block anything".

   Pure constants, no imports. frontend/src/vendor/shared/so-deliverable-states.ts
   is a byte-identical vendored copy for the browser, refereed by
   so-deliverable-states.canonical.test.ts on the frontend side.
   ---------------------------------------------------------------------------- */

/** Sales-Order statuses from which a Delivery Order may NOT be raised: a DRAFT
 *  is not committed, a CANCELLED order is dead, an ON_HOLD order is paused on
 *  purpose, and a CLOSED order has had its remainder given up on. Everything
 *  else — CONFIRMED, IN_PRODUCTION, READY_TO_SHIP, SHIPPED, DELIVERED,
 *  INVOICED — is deliverable. */
export const SO_UNDELIVERABLE_STATUSES = ['DRAFT', 'CANCELLED', 'ON_HOLD', 'CLOSED'] as const;

/** May a Delivery Order be raised from a Sales Order in this state?
 *
 *  Case-insensitive and null-safe on the status, because both callers read a
 *  nullable text column and the list payload has been observed handing back
 *  "Draft" / "draft" / "DRAFT" for the same row.
 *
 *  `onHold` is the mig-0324 marker. `null` means "this caller could not read the
 *  column" and is treated as NOT held — the same never-over-block choice the
 *  rest of this file makes. It is spelled `boolean | null` rather than being
 *  omittable so that a caller who has the value cannot forget to pass it.
 *
 *  A BLANK OR UNREADABLE STATUS RETURNS TRUE, and that is the same
 *  never-over-block choice the server makes (firstUndeliverableSo lets a row
 *  with no readable status fall through). The server is the gate; this
 *  predicate decides whether to OFFER the action, and offering an action the
 *  server then refuses with a plain-language 409 is strictly better than hiding
 *  one it would have accepted. Hiding is what this file exists to stop. */
export function soCanRaiseDo(
  status: string | null | undefined,
  onHold: boolean | null,
): boolean {
  if (onHold === true) return false;
  const s = String(status ?? '').toUpperCase();
  return !(SO_UNDELIVERABLE_STATUSES as readonly string[]).includes(s);
}

export type SoUndeliverableStatus = (typeof SO_UNDELIVERABLE_STATUSES)[number];
