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
       → INVOICED → CLOSED, plus the side states CANCELLED and ON_HOLD.
   Conservative by owner rule: reject ONLY an UNKNOWN target and a clearly-illegal
   BACKWARD jump; every forward move, idempotent no-op, ON_HOLD pause/resume and
   known regression is allowed. */
export const SO_STATUSES = new Set([
  'DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED',
  'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED', 'ON_HOLD',
]);
export const SO_STATUS_RANK: Record<string, number> = {
  DRAFT: 0, CONFIRMED: 1, IN_PRODUCTION: 2, READY_TO_SHIP: 3,
  SHIPPED: 4, DELIVERED: 5, INVOICED: 6, CLOSED: 7,
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
  /* Pause / resume. ON_HOLD is deliberately UNRANKED — an order can be paused
     from anywhere and resumed to wherever the operator needs it, and the rank
     table has nothing useful to say about that.
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
  if (from === 'ON_HOLD' && to === 'DRAFT') {
    return {
      error: 'illegal_status_transition',
      reason: 'A paused order cannot be resumed into Draft. Cancel it instead if it must not proceed.',
      code: 409,
    };
  }
  if (to === 'ON_HOLD' || from === 'ON_HOLD') return null;       // pause / resume
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
