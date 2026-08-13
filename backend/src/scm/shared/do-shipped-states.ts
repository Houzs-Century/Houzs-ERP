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
   these fires the inventory OUT (deductInventoryForDo). COMPLETED is absent
   deliberately: nothing ships INTO completion — a DO reaches COMPLETED from a
   state that already deducted, so listing it here would arm a second deduction
   on that hop.

   DO_STOCK_OUT_STATES is the READ predicate: "has this DO's stock already
   gone out?" COMPLETED sits past INVOICED, so a COMPLETED DO has certainly
   shipped and MUST answer yes — it is what stops a shipped DO falling back to
   DRAFT and orphaning its OUT movement, and what an audit must scan if it is
   not to skip completed deliveries.

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
 *  left our hands?" question. Superset of DO_SHIPPED_STATES by COMPLETED. */
export const DO_STOCK_OUT_STATES = [...DO_SHIPPED_STATES, 'COMPLETED'] as const;

/** EVERY legal delivery_orders.status value — the pre-ship states, the shipped
 *  states, COMPLETED and CANCELLED. The PATCH /:id/status guard refuses
 *  anything outside this set, so it is the vocabulary, not a selection from it.
 *
 *  Second declaration removed 2026-08-13: services/agents/delivery-agent.ts
 *  held its own eight-value copy (comment: "the DO lifecycle
 *  (delivery-orders-mfg.ts state machine)") that had lost COMPLETED, so the
 *  Delivery Agent's DO pipeline counted every bucket except completed
 *  deliveries and said nothing about the omission. */
export const DO_STATUSES = [
  'DRAFT', 'LOADED', ...DO_SHIPPED_STATES, 'COMPLETED', 'CANCELLED',
] as const;

/** Pre-ship: no stock has left our hands yet. */
export const DO_PRESHIP_STATES = ['DRAFT', 'LOADED'] as const;

export type DoShippedState = (typeof DO_SHIPPED_STATES)[number];
export type DoStockOutState = (typeof DO_STOCK_OUT_STATES)[number];
export type DoStatus = (typeof DO_STATUSES)[number];
