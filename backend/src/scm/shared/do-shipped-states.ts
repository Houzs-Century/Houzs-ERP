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

/* ── LOADED JOINED THIS SET ON 2026-08-22 — the owner's ruling ───────────────

   「once confirmed就代表出货了 就是直接扣库存」
   「draft 没出货，Confirmed就代表出货了 然后delivered只是记录而已，记录送到了」

   LOADED is what the screens call **Confirmed** (vendor/scm/lib/status-pill.ts).
   Until this date it was a PRE-SHIP state: the document was real, the goods were
   packed, and the inventory OUT waited for DISPATCHED. He moved the deduction to
   the confirm step, so Confirmed now means the stock has left and DELIVERED is a
   record that it arrived rather than the thing that moves anything.

   THIS IS A WRITE TRIGGER MOVING, so the safety question is whether it can
   re-deduct a delivery that already shipped. It cannot, twice over:

     · NOTHING IS IN LOADED. PROVEN 2026-08-22, run 32573972467 against
       production: 44 delivery orders — 30 DISPATCHED, 12 DELIVERED, 2 CANCELLED,
       and ZERO in DRAFT / LOADED / IN_TRANSIT / SIGNED / INVOICED. Promoting a
       state nothing occupies cannot retroactively deduct anything, and the 30
       DISPATCHED rows are not touched by this change at all — the OUT fires on a
       TRANSITION, and none of them transitions.
     · THE DEDUCTION IS IDEMPOTENT, and both halves were verified rather than
       assumed. In the application, deductInventoryForDo opens with an existence
       check — count of inventory_movements where source_doc_type='DO' AND
       source_doc_id=<this DO> AND movement_type='OUT'; any row at all and it
       returns without writing. In the database, PROVEN 2026-08-22 (run
       32574476216, check-duplicate-movements.mjs section 0, read from
       pg_indexes): uq_inv_mov_do_source_v2 is live on scm.inventory_movements,
       UNIQUE over (source_doc_type, source_doc_id, item_code, variant_key,
       COALESCE(correction_seq,0)) WHERE source_doc_type='DO'. movement_type is
       NOT in the key, so a second PRIMARY posting of a bucket is refused by
       Postgres even if the existence check were bypassed. The same run reports
       ZERO multi-row DO buckets in production today.

   WHAT ELSE MOVED WITH IT, because a set this file exports is read by others:
   DO_PRESHIP_STATES loses LOADED and is now DRAFT alone, which makes
   DO_NOT_DELIVERED_STATES {DRAFT, CANCELLED} — a Confirmed delivery now COUNTS
   as delivered everywhere the SO coverage engines look, which is the same
   sentence as "its stock is out" and therefore correct rather than incidental.
   The shipped→pre-ship regression guard in PATCH /:id/status follows: LOADED can
   no longer fall back to DRAFT, because doing so would orphan the OUT. */

/** Statuses whose FIRST entry writes the inventory OUT. Not a "has shipped"
 *  test — use DO_STOCK_OUT_STATES for that. LOADED leads the list because it is
 *  the first rung: Confirm is where the stock leaves (owner, 2026-08-22). */
export const DO_SHIPPED_STATES = [
  'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED',
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
  'DRAFT', ...DO_SHIPPED_STATES, 'CANCELLED',
] as const;

/** The hop that means "confirmed — this is on its way", and so the one the
 *  customer email fires on when a delivery order leaves a pre-ship state.
 *
 *  LOADED is the live answer: every confirm control in the product — the office
 *  button, the row menu, the phone's action bar, and the non-draft CREATE, which
 *  IS a confirm — now lands there.
 *
 *  DISPATCHED IS KEPT DELIBERATELY, and not because a caller still writes it.
 *  It is here because `PATCH /:id/status` accepts any DO_STATUSES member from
 *  any client, so a DRAFT can still be moved straight to DISPATCHED by an
 *  integration or an old cached bundle. That IS a confirm — the goods are
 *  leaving — and the customer should hear about it. Erring wide costs nothing:
 *  do_email_sent_at is claimed atomically, so at most one email per delivery
 *  order exists either way.
 *
 *  Naming the pair here rather than testing a literal in the route is what stops
 *  the next move of the confirm step silently ENDING the email instead of moving
 *  it — which is exactly what putting the stock-out on LOADED would have done on
 *  2026-08-22. */
export const CONFIRM_HOP_STATES = ['LOADED', 'DISPATCHED'] as const;

/** Pre-ship: no stock has left our hands yet. DRAFT alone since 2026-08-22 —
 *  LOADED (= Confirmed) moved into DO_SHIPPED_STATES, see the block above. This
 *  is the set the PATCH /:id/status guard uses to refuse a shipped DO falling
 *  BACK to un-shipped, so shrinking it TIGHTENS that guard rather than loosening
 *  it: LOADED→DRAFT is now refused, which is what stops a Confirmed delivery
 *  orphaning its inventory OUT. */
export const DO_PRESHIP_STATES = ['DRAFT'] as const;

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
   spot closed before it costs a dispatch, not after.

   ── AND ON 2026-08-22 THE PREMISE CHANGED, WHICH IS WHY THIS BLOCK STAYS ─────

   Every paragraph above argues from "LOADED is a PRE-SHIP state, its OUT has not
   fired". That is no longer true: the owner moved the deduction to the confirm
   step, so LOADED is in DO_SHIPPED_STATES and this set is now {DRAFT, CANCELLED}
   by derivation. The history is kept rather than deleted because the FIX it
   describes is what makes today's answer safe. The nine hand-written copies are
   gone; the rule is derived from DO_PRESHIP_STATES; so the premise moving
   re-computed every consumer in one edit instead of leaving eight of them behind.
   A LOADED delivery now counts as delivered BECAUSE its stock has left, which is
   the same sentence read twice — not a second, independent decision.

   The over-delivery self-refusal that block describes cannot come back either,
   and for a structural reason rather than a lucky one: the confirm gate runs on
   the pre-ship→shipped hop, and after this change that hop is DRAFT→LOADED. A
   DRAFT is excluded from the delivered sum, so the document is still not inside
   the total it is measured against. */

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

/* ── "MAY THIS BE INVOICED?" — the owner's ruling, 2026-08-20 ────────────────

   A DIFFERENT QUESTION FROM THE ONE ABOVE, and the difference is exactly LOADED.
   "Has this delivery counted?" is about stock: a LOADED DO is on the lorry, its
   inventory OUT has not fired, and counting it as delivered is what refused a
   full delivery its own dispatch (#2557). "May this be invoiced?" is about
   PAPERWORK, and the owner settled it himself:

     「发票是invoice？等送完货了我们才自己convert to invoice啊」
     「我们自己开啊 manually开的不是吗」

   Asked directly whether the system should REFUSE a LOADED delivery its invoice,
   he chose 不要拦 —— 人自己知道 ("don't block it — the person knows"). The
   invoice is raised by hand, by someone who knows whether the goods arrived, so
   the system does not second-guess them. That is his standing posture for this
   system: loosen as far as possible, a hard wall is the last resort.

   READ THIS BEFORE "TIDYING" THE TWO SETS TOGETHER — AND SINCE 2026-08-22 THEY
   HAVE THE SAME MEMBERS, so the temptation is now maximal and the answer has not
   changed. LOADED was the one status they disagreed on; the stock deduction
   moving to the confirm step made a Confirmed delivery both DELIVERED and
   INVOICEABLE, and the two sets converged on {DRAFT, CANCELLED}. That is a
   COINCIDENCE OF MEMBERSHIP, not a merger of questions. Fold them into one
   constant and the next ruling on either — the owner has already reversed this
   one twice — silently moves the other, which is precisely the bug both sets
   were split to prevent. Equal today, separate on purpose:
     · #2485 (owner, 2026-08-19) opened the invoice to every confirmed delivery,
       LOADED included, by deleting a guard that named it.
     · #2557 (2026-08-20) closed it again as a side effect of the stock fix.
     · This (owner, 2026-08-20) re-opens it, deliberately and on his word.

   The 2026-08-19 argument for it did NOT cover LOADED, and saying so is still
   the point: #2485 justified itself with "stock was already deducted at
   dispatch", which was true of DISPATCHED and IN_TRANSIT and false of LOADED.
   The rule held because the owner chose it, not because that reasoning reached
   it. As of 2026-08-22 that reasoning DOES reach it — the deduction happens at
   Confirm now — and the rule is unchanged either way, which is what a rule
   grounded in a decision rather than in an argument looks like.

   NOTHING IN PRODUCTION TURNS ON THIS TODAY: check-do-integrity.mjs R4 (run
   32368212535, 2026-08-20) found ZERO delivery orders in LOADED in either
   company, and the 2026-08-22 census (run 32573972467) found the same. This is a
   rule being settled, not an incident being cleaned up. */

/** The states whose lines may NOT be invoiced: a DRAFT is not confirmed yet, and
 *  a CANCELLED delivered nothing. LOADED is deliberately absent — see above. */
export const DO_NOT_INVOICEABLE_STATES = ['DRAFT', 'CANCELLED'] as const;

/** May this delivery order's lines be invoiced? Case-insensitive and null-safe,
 *  because the callers read a nullable text column. */
export function doCountsAsInvoiceable(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return !(DO_NOT_INVOICEABLE_STATES as readonly string[]).includes(s);
}

/** The same set as a PostgREST `.not('status', 'in', ...)` literal, BUILT from
 *  the array for the same reason its delivered twin above is. */
export const DO_NOT_INVOICEABLE_IN_LIST =
  `(${DO_NOT_INVOICEABLE_STATES.map((s) => `"${s}"`).join(',')})`;

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
