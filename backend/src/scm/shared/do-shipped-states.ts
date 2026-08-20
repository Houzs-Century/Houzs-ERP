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

/* ----------------------------------------------------------------------------
 * WHICH DELIVERIES MAY BE INVOICED — the owner's ruling, 2026-08-18:
 *   "DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED — 这些 status 都可以转 SI"
 *
 * SUPERSEDED ON MEMBERSHIP, 2026-08-19, and LOADED joined the set. PR #2485
 * carries the owner's next-day decision: a Sales Invoice may be raised from
 * EVERY confirmed delivery order — anything past DRAFT that is not CANCELLED —
 * with no "Mark signed" step in front of it. That is the broader ruling and it
 * is the one in force.
 *
 * It is also the one the SERVER has always enforced, which is why it wins on
 * evidence and not only on date. The SI-from-DO create refuses exactly one
 * source status — `if (doHeader.status === 'CANCELLED') -> 409 do_cancelled`,
 * routes/sales-invoices.ts — and has never refused an un-signed or un-dispatched
 * one. A four-state list here would have made this file the first thing in the
 * system to REFUSE a LOADED delivery its invoice, which is a new restriction
 * wearing the clothes of a de-duplication.
 *
 * What did NOT change with it is the reason this constant exists at all: the
 * rule has ONE home. The 2026-08-18 work moved it out of two hand-typed
 * frontend lists into this file, put the frontend twin under
 * check-shared-mirrors.mjs --strict, and made the server ENFORCE it rather than
 * letting each screen decide. Membership is the owner's to set; having a single
 * place for him to set it is what stops the next screen disagreeing.
 *
 * A SEPARATE declaration from DO_SHIPPED_STATES on purpose, because the two
 * answer different questions and only one of them is about money-in:
 *   DO_SHIPPED_STATES     — has the stock left our hands? (drives DO_STOCK_OUT_STATES,
 *                           which reconcile-ledger.ts and the money audits read)
 *   SI_TRANSFERABLE_DO_STATES — may a Sales Invoice be raised from it?
 *
 * The difference is INVOICED, and folding it in would have been the expensive
 * kind of tidy: DO_STOCK_OUT_STATES is `[...DO_SHIPPED_STATES]`, so dropping
 * INVOICED from the shipped set would tell the ledger that an INVOICED delivery's
 * stock never left. INVOICED is a legal scm.do_status enum label, so a row can
 * carry it even though routes/unbilled-deliveries.ts:13 measured that NOTHING in
 * this codebase writes it.
 *
 * This is the system's ONLY definition of invoice-transferable. It replaced a
 * hand-typed ['signed','delivered'] that was the narrowest of three live
 * spellings, and — the part worth remembering — that narrowness was a
 * MULTI-ORGANISATION defect, not a status one. The predicate carries no company
 * term and never did; it fired on one organisation because of DATA. 2990's source
 * system has no "delivered" step, so its imported deliveries sit at DISPATCHED,
 * while the HOUZS AutoCount carry-overs came in as literal 'DELIVERED'. One
 * build, one permission set, and 2990 was told the transfer did not exist.
 * See docs/modules/document-conversion.md.
 * -------------------------------------------------------------------------- */
export const SI_TRANSFERABLE_DO_STATES = [
  'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED',
] as const;

export type SiTransferableDoState = (typeof SI_TRANSFERABLE_DO_STATES)[number];

export type DoShippedState = (typeof DO_SHIPPED_STATES)[number];
export type DoStockOutState = (typeof DO_STOCK_OUT_STATES)[number];
export type DoStatus = (typeof DO_STATUSES)[number];
