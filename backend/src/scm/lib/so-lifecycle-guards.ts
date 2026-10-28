/**
 * The Sales Order's LIFECYCLE guards — which status moves are legal, and what a
 * discard has to be true of.
 *
 * Lifted out of `mfg-sales-orders.ts` (12k lines, and only shrinking) because
 * the two belong together and were being reasoned about apart: the transition
 * table let an order reach DRAFT by a route the rank check refuses, and the
 * DELETE handler authorised on the DRAFT column alone. One of those on its own
 * is a curiosity; together they are a way to destroy a delivered order's line
 * items, payment ledger and audit trail. Pure functions plus one read, so both
 * are testable without a request — see backend/tests/reviewHighFindings.test.ts.
 */
/* ── SO status legal-transition guard (FIX 1, 2026-07-16) ───────────────────
   The manual PATCH /:docNo/status endpoint used to write body.status VERBATIM:
   a garbage string (e.g. the V2 list "Confirm" button posts lowercase
   "confirmed") persisted, and an already-advanced SO could be moved backward
   with no check. Mirror the purchasing side's dedicated-status guards with an
   explicit legal-transition table. The AUTO state-machine (so-stock-allocation,
   so-delivery-sync, delivery-returns) writes the status column DIRECTLY and does
   NOT come through this route, so this table only governs MANUAL status changes.

   Status set grepped from the codebase (list/detail pills, so-stock-allocation,
   so-delivery-sync, delivery-returns, inventory SO_DONE, the amend-terminal set):
     DRAFT → CONFIRMED → IN_PRODUCTION → READY_TO_SHIP → SHIPPED → DELIVERED
       → INVOICED, plus the side states CANCELLED and ON_HOLD.
   Conservative by owner rule: reject ONLY an UNKNOWN target and a clearly-illegal
   BACKWARD jump; every forward move, idempotent no-op, ON_HOLD pause/resume and
   known regression is allowed. */

/* ── CLOSED IS BACK, AS A DIFFERENT STATUS (2026-08-22) ──────────────────────
   THE RETIREMENT BELOW WAS CORRECT AND IS NOT BEING UNDONE. What it removed was
   a vague lifecycle STEP that sat after Invoiced and that nobody used — proven
   empty at the time, and read the block below for that evidence rather than
   taking this sentence for it. What comes back is a different thing wearing the
   same enum label, and it earns its place by answering a question the old one
   never asked.

   THE MEANING, AND IT IS THE ONLY MEANING IT MAY HAVE:

       Close = STOP CHASING THE REMAINDER.
       The document STAYS. What was already delivered and invoiced STANDS.

   The case, put to the owner on 2026-08-22 — a customer orders 10 and takes 7,
   or the supplier cannot supply the last 3 — and asked whether it happens here:
   「有的」. The three that never shipped stop being chased; the seven were really
   sold, so the order must not be voided.

   IT IS NOT CANCEL, and the two are one keystroke apart in a right-click menu:

       CANCEL   voids the WHOLE document as if it never happened. Final; the
                deposit becomes customer credit; AutoCount cannot un-cancel it.
       CLOSE    keeps the document and everything already delivered against it,
                and gives up only on what is left.

   WHERE IT SITS IN THE RANK TABLE: NOWHERE, DELIBERATELY. Closing is reachable
   from wherever the order had got to — most closed orders never reach INVOICED
   at all — so a rank would state something false, that CLOSED comes after
   INVOICED. It is UNRANKED, the way CANCELLED and ON_HOLD are.

   AND THAT IS EXACTLY THE SHAPE THAT DUG THE ON_HOLD HOLE, so read the arms
   below before copying them. "Unranked" was written there as an unconditional
   `return null` on BOTH edges, which made the status a laundry — a two-step
   route to a move the rank table refuses. CLOSED is unranked on the way IN only:
   the way OUT is refused outright, because a decision to stop chasing a
   remainder is not something the next screen un-decides. CANCELLED gets the same
   asymmetry, just enforced one layer up in the route's cancel-final guard.

   NOTHING AUTOMATIC EVER WRITES IT. No machine can know that a remainder has
   been given up on; only the person talking to the customer or the supplier
   knows. It is manual-only, on purpose, and there is no sweep to add later. */

/* ── CLOSED WAS RETIRED (owner ruling, 2026-08-21) ───────────────────────────
   Kept because it is the evidence for the paragraph above, not a contradiction
   of it. The status this removed was the vague lifecycle step; the status the
   block above restores is the short-shipment decision.

   He wrote the lifecycle he actually runs and CLOSED is not in it:
     Draft → Confirm → In Production → Ready to Ship → Shipped → Delivered
       → Invoice → On Hold → Cancel
   Asked directly whether to remove it along with two others, he narrowed it to
   this one: 「照你的流程做，只删 Closed」.

   PROVEN EMPTY before removing it, not assumed. probe-so-date-xor run
   32487749630 (2026-08-21): company 1 holds 0 sales orders at all. Company 2's
   own tab counts sum to its total with CLOSED at zero —
   2 + 62 + 17 + 22 + 1 = 104 of 104. So no live document loses its status here.

   WHAT "REMOVED" CAN AND CANNOT MEAN. Postgres cannot drop a value from an
   enum, so the label `CLOSED` stays in scm.mfg_so_status for ever. Removing it
   HERE is what actually matters: this set is both the manual PATCH whitelist
   and the source the status TABS are generated from (mfg-sales-orders.ts builds
   statusCounts by walking it), so nothing offers CLOSED and the route now
   refuses it with `invalid_status`. (That last sentence described the tree
   between 2026-08-21 and 2026-08-22. The route accepts it again, for the
   meaning at the top of this file.)

   TWO PLACES IT DELIBERATELY STAYS, and taking it out of either would be a bug:
     · SO_TERMINAL_STATES (shared/so-terminal-states.ts) — a legacy CLOSED row
       must keep being terminal. Dropping it there would turn such an order back
       into live demand for MRP and the stock allocator.
     · the status-pill label map — a row that somehow carries CLOSED must still
       render a WORD. ASSR paid for this exact lesson: a status with no label
       fell through to printing its raw slug on the customer portal. */
export const SO_STATUSES = new Set([
  'DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
  'DELIVERED', 'INVOICED', 'CANCELLED', 'ON_HOLD', 'CLOSED',
]);
export const SO_STATUS_RANK: Record<string, number> = {
  DRAFT: 0, CONFIRMED: 1, IN_PRODUCTION: 2, READY_TO_SHIP: 3,
  SHIPPED: 4, DELIVERED: 5, INVOICED: 6,
};
/* Backward edges the system legitimately performs — stock regress (all-lines
   not-ready) + delivery-return re-open. Everything else backward is rejected.
   Keyed `${from}>${to}`. */
export const SO_LEGAL_REGRESSIONS = new Set([
  'IN_PRODUCTION>CONFIRMED',
  'READY_TO_SHIP>CONFIRMED', 'READY_TO_SHIP>IN_PRODUCTION',
  'SHIPPED>CONFIRMED', 'SHIPPED>IN_PRODUCTION', 'SHIPPED>READY_TO_SHIP',
  'DELIVERED>CONFIRMED', 'DELIVERED>IN_PRODUCTION',
  'DELIVERED>READY_TO_SHIP', 'DELIVERED>SHIPPED',
]);

/* null = allowed. `to` MUST already be normalised to UPPERCASE. The CANCELLED
   target/source is validated by the caller's cancel-final + downstream guards, so
   it short-circuits here. `from` unknown/blank (legacy row, brand-new SO) →
   allowed (can't judge — never OVER-block). */
export function soStatusTransitionError(
  fromRaw: string | null,
  to: string,
): { error: string; reason: string; code: 400 | 409 } | null {
  if (!SO_STATUSES.has(to)) {
    return { error: 'invalid_status', reason: `"${to}" is not a valid Sales Order status.`, code: 400 };
  }
  const from = String(fromRaw ?? '').toUpperCase();
  if (!from || !SO_STATUSES.has(from)) return null;              // status-blind → allow
  if (from === to) return null;                                  // idempotent no-op
  if (to === 'CANCELLED' || from === 'CANCELLED') return null;   // cancel guards own this
  /* CLOSE, AND DO NOT UN-CLOSE. CLOSED is UNRANKED for the reason at the top of
     this file — an order is closed from wherever it had got to — so it is
     enterable from every live status and the rank table has nothing to say.
     The way OUT is a different question and gets a different answer: closing is
     a decision that the remainder is not coming, and the next screen does not
     un-decide it.

     THIS ARM IS LOAD-BEARING ON ITS OWN, and re-checked on 2026-08-22 after the
     hold became a marker. Without it, `from = 'CLOSED'` reaches the rank block,
     `SO_STATUS_RANK.CLOSED` is `undefined`, and the function RETURNS NULL — so
     CLOSED>DRAFT would be allowed outright, and DRAFT is what unlocks the
     cascading DELETE. The two-step it was originally written against
     (CLOSED>ON_HOLD>DRAFT) is now refused twice over, because `to = 'ON_HOLD'`
     is refused for everyone below; the DIRECT move it refuses is why it stays.

     CANCELLED gets the same asymmetry, enforced one layer up by the route's
     cancel-final guard, which is why the line above can short-circuit both edges
     and this one cannot. Cancel stays reachable from CLOSED (that line runs
     first): if it turns out nothing stands, the cancel guards own that call.

     A HOLD IS ORTHOGONAL AND STAYS ORTHOGONAL. Since mig 0324 the hold is a
     MARKER, not a status, and `PATCH /:docNo/hold` never writes this column — so
     a closed order can still be marked held and a held order can still be
     closed, and neither passes through here. No gate was added for either; see
     docs/modules/document-status-vocabulary.md §1b. */
  if (to === 'CLOSED') return null;                              // closable from anywhere live
  /* Pause / resume. ON_HOLD was deliberately UNRANKED — an order could be paused
     from anywhere and resumed to wherever the operator needed it, and the rank
     table had nothing useful to say about that. Reading the paragraph below is
     the shortest argument for why the hold should never have been a status at
     all: an unranked member of a ranked set is a hole in the set.
     But "unranked" was written as an unconditional `return null` on BOTH edges,
     which made ON_HOLD a laundry: DELIVERED>DRAFT is rejected on rank and is
     absent from SO_LEGAL_REGRESSIONS, yet DELIVERED>ON_HOLD passes on `to`,
     ON_HOLD>DRAFT passes on `from`, and the two together are the move the rank
     table exists to refuse. It is not a hypothetical: reaching DRAFT is what
     unlocks DELETE /:docNo, which cascades the lines, the payments and the whole
     audit log away (see that handler).
     DRAFT is the one target that is never a legitimate resume. Nothing resumes
     INTO "not yet written": an order that must go back to the beginning is
     cancelled and re-raised, which leaves a document behind. Every other resume
     target is still allowed, so the pause/resume the states exist for is
     unchanged. */
  /* ON_HOLD IS NO LONGER A STATUS ANYONE MAY WRITE (mig 0324, owner 2026-08-22:
     「我们的hold是给我们知道一个 order hold这的」). A hold is a MARKER beside the
     status and it has its own endpoint, PATCH /:docNo/hold. Writing it here was
     the defect: it OVERWROTE the order's progress, so holding an IN_PRODUCTION
     order destroyed the only record that it was in production, and Take Off
     Hold then had nowhere to put it back to and sent everything to CONFIRMED.

     The label is refused as a TARGET and still accepted as a SOURCE. Postgres
     cannot drop an enum value, so a legacy row may still be sitting on ON_HOLD,
     and it needs a way OUT — refusing `from` as well would strand it on a status
     nothing can leave. */
  if (to === 'ON_HOLD') {
    return {
      error: 'hold_is_not_a_status',
      reason: 'Putting an order on hold no longer changes its status — use Put On Hold, '
        + 'which leaves the order exactly where it is.',
      code: 409,
    };
  }
  if (from === 'CLOSED') {
    return {
      error: 'illegal_status_transition',
      reason: 'This order was closed — the outstanding balance is no longer being chased. Raise a new sales order for anything still to be supplied, or cancel this one.',
      code: 409,
    };
  }
  if (from === 'ON_HOLD' && to === 'DRAFT') {
    return {
      error: 'illegal_status_transition',
      reason: 'A paused order cannot be resumed into Draft. Cancel it instead if it must not proceed.',
      code: 409,
    };
  }
  if (from === 'ON_HOLD') return null;                           // a legacy held row leaving
  const fromRank = SO_STATUS_RANK[from];
  const toRank = SO_STATUS_RANK[to];
  if (fromRank === undefined || toRank === undefined) return null;
  if (toRank >= fromRank) return null;                           // forward or same rank
  if (SO_LEGAL_REGRESSIONS.has(`${from}>${to}`)) return null;    // known regression
  return {
    error: 'illegal_status_transition',
    reason: `A Sales Order cannot move from ${from} back to ${to}.`,
    code: 409,
  };
}

/**
 * What a DISCARD has to be true of, beyond the status column.
 *
 * `status === 'DRAFT'` is a claim about a COLUMN, not about the document chain,
 * and the DELETE handler used to treat the two as the same thing — its own
 * header comment said so ("a DRAFT has no DO/SI"). That is not true of a row
 * that has BEEN somewhere, which is exactly what the ON_HOLD edge above used to
 * allow.
 *
 * The cascade takes mfg_sales_order_items, _payments, mfg_so_price_overrides,
 * mfg_so_status_changes and the whole mfg_so_audit_log; delivery_orders.so_doc_no
 * and sales_invoices.so_doc_no are ON DELETE SET NULL, so a real DO and a real
 * invoice survive pointing at nothing.
 *
 * Returns a refusal to hand straight back, or null. `soHasDownstream` is passed
 * in rather than imported so this module stays free of the route graph.
 */
export async function soDiscardBlocked(
  sb: any,
  docNo: string,
  soHasDownstream: (sb: any, docNo: string) => Promise<unknown>,
): Promise<{ body: unknown; code: 409 | 500 } | null> {
  /* The same lock CANCELLED consults. A genuine draft has no children. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return { body: childLock, code: 409 };

  /* Money is the other thing a cascade cannot undo, and it cannot be
     reconstructed from the DO/SI because those are gone too. A real draft CAN
     carry a deposit (the POS takes one before Confirm), so this is a refusal
     with an instruction rather than a rule that a draft may never have one.
     FAILS CLOSED: an unreadable ledger is not an empty one, and "no payments"
     is precisely what would authorise the delete. */
  /* `so_doc_no`, not `doc_no`. That table has no `doc_no` column — the FK is
     `mfg_sales_order_payments_so_doc_no_...` and every other reader in the tree
     (ar-reconciliation.ts:102, mfg-sales-orders.ts:494) uses `so_doc_no`. With
     the wrong name PostgREST answers 42703, `payErr` is set, and this guard —
     correctly failing closed — turned EVERY draft discard into a 500. The
     documented `409 so_has_payments` below was unreachable. TypeScript cannot
     see a column name inside a string, so nothing caught it. */
  const { data: payRows, error: payErr } = await sb
    .from('mfg_sales_order_payments').select('id').eq('so_doc_no', docNo).limit(1);
  if (payErr) {
    return { body: { error: 'delete_failed', reason: `Could not check this order's payments: ${payErr.message}` }, code: 500 };
  }
  if ((payRows ?? []).length > 0) {
    return {
      body: {
        error: 'so_has_payments',
        reason: 'This order has payments recorded against it. Remove the payments first, or cancel the order instead of discarding it.',
      },
      code: 409,
    };
  }
  return null;
}
