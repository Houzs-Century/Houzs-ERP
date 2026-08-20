/* ----------------------------------------------------------------------------
   do-shipped-states — the ONE declaration of "this delivery has moved stock".

   WHY THIS FILE EXISTS. Two related status sets were hand-typed into eleven
   files — four under src/ (delivery-orders-mfg, consignment-notes,
   lib/reconcile-ledger, agents/delivery-agent) and seven under scripts/ — and
   they had already split into two spellings that answer the SAME question
   differently:

     5 states  DISPATCHED IN_TRANSIT SIGNED DELIVERED INVOICED
     6 states  ... + COMPLETED

   delivery-orders-mfg.ts held both, correctly named and correctly related
   (`DO_STOCK_OUT_STATUSES = [...SHIPPED_STATES, 'COMPLETED']`). Every other
   file picked one spelling by hand and lost the distinction: on 2026-08-13
   check-stock-truth.mjs measured delivered COGS over the 5-state list while
   check-doc-line-vs-movement.mjs measured lines-vs-movements over the 6, so a
   COMPLETED delivery order was invisible to one audit and in scope for the
   other, with nothing in either output saying so.

   THE TWO SETS ARE NOT INTERCHANGEABLE — that is exactly why they both live
   here rather than being "simplified" into one:

   DO_SHIPPED_STATES is the WRITE trigger. The first transition into any of
   these fires the inventory OUT (deductInventoryForDo).

   DO_STOCK_OUT_STATES is the READ predicate: "has this DO's stock already
   gone out?" It is what stops a shipped DO falling back to DRAFT and orphaning
   its OUT movement, and what an audit must scan if it is not to skip a shipped
   delivery. The two are CO-EXTENSIVE today (see COMPLETED below) and are still
   two names, because they answer two questions and a future post-INVOICED state
   would belong to the read set and not the write one.

   ── COMPLETED IS NOT A DELIVERY-ORDER STATUS. Removed 2026-08-18. ────────────

   This module used to carry COMPLETED in DO_STOCK_OUT_STATES and in DO_STATUSES,
   with the settled-sounding claim that "COMPLETED sits past INVOICED, so a
   COMPLETED DO has certainly shipped". No evidence was ever attached to it, and
   it was mirrored into three more comment blocks from here.

   What is actually known, and HOW:

     · POSTGRES REFUSES THE LABEL. On 2026-08-17
       `GET /api/scm/delivery-orders-mfg?status=delivered` returned, in BOTH
       tenants, 500 `{"error":"load_failed","reason":"invalid input value for
       enum do_status: \"COMPLETED\""}`. The database is the authority on its own
       enum and it says the value does not exist.
     · THE TREE AGREES. `scm.do_status` is created with seven labels in
       backend/scripts/scm-schema/2990s-full-schema.sql:5 (LOADED, DISPATCHED,
       IN_TRANSIT, SIGNED, DELIVERED, INVOICED, CANCELLED); mig 0040 adds DRAFT.
       `grep -rn "do_status" backend --include='*.sql'` finds no other ALTER TYPE
       — nothing ever added COMPLETED.
     · NOTHING WRITES IT. `grep -rn "'COMPLETED'" backend/src backend/scripts`
       returns no delivery-order write path: every DO occurrence was a read
       predicate or a whitelist. The other hits are different enums entirely
       (trip_status, purchase_return_status, work-order state, sales-invoice
       `paid` bucket).

   So it belonged in NEITHER set: as a read predicate it made Postgres throw, and
   in DO_STATUSES it let PATCH /:id/status accept a value that then 500'd at the
   UPDATE. A status no writer produces and the enum rejects is not a status.

   The claim survived because it was asserted rather than measured, in a comment,
   and then copied. That is the lesson worth keeping: this block now says what is
   known and names the observation that established it, so the next reader can
   re-run it instead of inheriting it.

   Pure constants, no imports. scripts/lib/do-shipped-states.mjs mirrors this
   file for the .mjs audits (which cannot import TypeScript) and
   tests/doShippedStatesMirror.test.ts pins the two together.
   ---------------------------------------------------------------------------- */

/** Statuses whose FIRST entry writes the inventory OUT. Not a "has shipped"
 *  test — use DO_STOCK_OUT_STATES for that. */
export const DO_SHIPPED_STATES = [
  'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED',
] as const;

/** Statuses in which the OUT has already been written — the "has this stock
 *  left our hands?" question. Was DO_SHIPPED_STATES + COMPLETED until
 *  2026-08-18; COMPLETED is not a member of scm.do_status (header), so the two
 *  sets are now equal. Kept as its own name because it is a different QUESTION,
 *  and a real post-INVOICED state would join this one and not the write set. */
export const DO_STOCK_OUT_STATES = [...DO_SHIPPED_STATES] as const;

/** EVERY legal delivery_orders.status value — the pre-ship states, the shipped
 *  states and CANCELLED. These are exactly the eight labels of the scm.do_status
 *  enum. The PATCH /:id/status guard refuses anything outside this set, so it is
 *  the vocabulary, not a selection from it — and a value IN it that the enum
 *  does not have is worse than one that is missing: the guard passes the request
 *  and the UPDATE then 500s. That is what COMPLETED did until 2026-08-18.
 *
 *  Second declaration removed 2026-08-13: services/agents/delivery-agent.ts
 *  held its own eight-value copy of this list. It was described at the time as
 *  having "lost COMPLETED"; on the evidence in the header it was the only copy
 *  that had it right. */
export const DO_STATUSES = [
  'DRAFT', 'LOADED', ...DO_SHIPPED_STATES, 'CANCELLED',
] as const;

/** Pre-ship: no stock has left our hands yet. */
export const DO_PRESHIP_STATES = ['DRAFT', 'LOADED'] as const;

/* ── "HAS THIS DELIVERY COUNTED?" — one home, added 2026-08-20 ───────────────

   Every engine that sums what a Sales Order has already been delivered wrote
   the same rule by hand, and every one of them wrote it as {CANCELLED, DRAFT}:
   do-unlinked-coverage (twice), so-delivery-sync, so-stock-allocation,
   routes/inventory, do-line-remaining, and check-do-integrity.mjs. LOADED is a
   PRE-SHIP state — it is in the set two lines above, and the inventory OUT only
   fires on ENTRY to a shipped state — so all of them counted a delivery that is
   still on the lorry.

   The cost was a delivery that could not be dispatched. The confirm gate admits
   DRAFT and LOADED, so a LOADED DO's own lines were already inside the delivered
   sum its remaining figure was computed from, and the over-delivery check
   refused it against ITSELF whenever 2 x own_qty > ordered_qty — every full
   delivery. Because the OUT had not fired, stock on hand read too high, MRP did
   not reorder, and the operator's way out was cancel-and-re-raise: the exact
   path that minted the DO-005 duplicate delivery.

   `unbilled-deliveries.ts` is the tell — a second consumer of the same engine
   that had to add LOADED to its own list by hand, with a comment saying a
   LOADED DO is still on the lorry. One list beside the rule now, not seven.

   PROVEN 2026-08-20 (run 32368212535, `check-do-integrity.mjs` R4 against
   production): ZERO delivery orders are in LOADED today, in either company, and
   zero would be refused. Nothing is stuck right now. That is not proof the
   state is unreachable — `delivery_orders.status` is DEFAULT 'LOADED' NOT NULL
   and `PATCH /:id/status` accepts every DO_STATUSES member — so this is a blind
   spot closed before it costs a dispatch, not after. */

/** A delivery order in one of these has NOT put stock in the customer's hands:
 *  the pre-ship states plus CANCELLED. The complement of DO_STOCK_OUT_STATES
 *  over DO_STATUSES, written from DO_PRESHIP_STATES so the two cannot drift. */
export const DO_NOT_DELIVERED_STATES = [...DO_PRESHIP_STATES, 'CANCELLED'] as const;

/** Do this delivery order's lines COUNT as delivered? Case-insensitive and
 *  null-safe, because the callers read a nullable text column. */
export function doCountsAsDelivered(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return !(DO_NOT_DELIVERED_STATES as readonly string[]).includes(s);
}

/** The same set as a PostgREST `.not('status', 'in', ...)` literal, BUILT from
 *  the array rather than typed out — a hand-typed copy is what this whole block
 *  exists to end. */
export const DO_NOT_DELIVERED_IN_LIST =
  `(${DO_NOT_DELIVERED_STATES.map((s) => `"${s}"`).join(',')})`;

export type DoShippedState = (typeof DO_SHIPPED_STATES)[number];
export type DoStockOutState = (typeof DO_STOCK_OUT_STATES)[number];
export type DoStatus = (typeof DO_STATUSES)[number];
