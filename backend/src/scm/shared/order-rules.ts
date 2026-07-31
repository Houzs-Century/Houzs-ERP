// Order-state pure functions. Lifted from prototype per PORT_DESIGN.md §11.2.
// Implementations TODO — port during Phase 3 (order lifecycle).

export interface LaneCondition { lane: string; require: ('paid_full' | 'slip_verified' | 'driver_assigned' | 'do_signed')[] }

/** True if the order satisfies all conditions to enter the target lane. */
export const checkConditions = (_order: unknown, _conditions: LaneCondition): boolean => {
  throw new Error('checkConditions: not yet implemented (Phase 3)');
};

/** 0..100 — what fraction of total has been paid across all payments. */
export const paidPct = (paid: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((paid / total) * 100));
};

/** Minimum paid fraction (of the order total) to advance an order to Proceed. */
export const PROCEED_PAID_THRESHOLD = 0.5;

/** Minimum paid fraction to SET a Processing Date. Houzs requires only 30%
 *  (owner 2026-07-14) — the ≥50% PROCEED_PAID_THRESHOLD is a 2990 rule and must
 *  NOT gate the Houzs processing date. Kept as its own constant so the two gates
 *  can never be conflated again. */
export const PROCESSING_DATE_PAID_THRESHOLD = 0.30;

/** Inputs to the "ready to Proceed" gate. `paid` / `total` must share a unit
 *  (whole-MYR on the POS, centi on the server) — only their ratio is used, so
 *  either side may pass its own representation. */
export interface ProceedGateInput {
  hasCustomerName: boolean;
  hasEmail: boolean;
  /** Delivery address line 1 present. A "Fill in later" handover leaves this
   *  (and the postcode) blank, so the gate fails — exactly the case that must
   *  keep an order in Order Placed. */
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  paid: number;
  total: number;
}

/** The single source of truth for "may this SO move to Proceed?". Used by BOTH
 *  the POS "Move to Proceed" button (manual) and the server's create handler
 *  (auto-stamp proceeded_at when the handover already arrives complete) so the
 *  two can never drift. Mirrors the four checklist ticks in the POS drawer:
 *  customer info (name + email), delivery address (line 1 + postcode), a
 *  delivery date, and ≥ 50% paid. */
export const meetsProceedGate = (i: ProceedGateInput): boolean =>
  i.hasCustomerName &&
  i.hasEmail &&
  i.hasAddress &&
  i.hasPostcode &&
  i.hasDeliveryDate &&
  (i.total <= 0 || i.paid / i.total >= PROCEED_PAID_THRESHOLD);

/** May a Processing Date (factory-start / 开工日期) be SET on a Sales Order, given
 *  collection so far? Owner/Loo 2026-06-30 — the Processing Date is production's
 *  "ready to build" signal: once it is set, the backend treats the SO as a go and
 *  orders materials / starts the build when the date arrives. So it must NOT be
 *  set until the customer has paid the ≥30% deposit Houzs requires
 *  (PROCESSING_DATE_PAID_THRESHOLD — owner 2026-07-14; the 50% Proceed threshold
 *  is a 2990 rule). UNLIKE meetsProceedGate, customer-info / address completeness is
 *  deliberately NOT gated here — an order with incomplete customer info may still
 *  carry a Processing Date (Loo: resolve customer details in Proceed). Only the
 *  money gates the date.
 *
 *  `paid` / `total` must share a unit (whole-MYR on the POS, centi on the server)
 *  — only their ratio is used. Free order (total ≤ 0, e.g. a Free Item Campaign
 *  giveaway): nothing to collect, so the gate is vacuously met (mirrors
 *  meetsProceedGate, and avoids the 0/0 = NaN a `total > 0` guard would need). */
export const meetsProcessingDatePaymentGate = (
  paid: number,
  total: number,
  companyCode?: CompanyCode | string | null,
): boolean => total <= 0 || paid / total >= processingDateThresholdFor(companyCode);

/** The companies whose deposit rule differs. Mirrors companyContext's
 *  `c.get('companyCode')`, which is the only producer of these strings. */
export type CompanyCode = 'HOUZS' | '2990';

/** The deposit fraction THIS company requires before a Processing Date may be set.
 *
 *  Owner 2026-07-31, stated plainly: **Houzs 30%, 2990 50%** — and the Processing
 *  Date IS the Proceed signal, so one rule governs both.
 *
 *  Until now the split existed ONLY in prose. PROCESSING_DATE_PAID_THRESHOLD was
 *  documented as the Houzs number and PROCEED_PAID_THRESHOLD as "a 2990 rule",
 *  while `grep -c company` on this file returned ZERO: both constants were applied
 *  to every company, so a 2990 order was gated at the Houzs 30%. That is what the
 *  owner hit on 2026-07-31 — a 2990 SO refused with "Deposit RM 0 of RM 1,663
 *  needed (30%)" where the 2990 rule is 50%.
 *
 *  UNKNOWN COMPANY FALLS BACK TO THE LOOSER 30%, deliberately. A future company
 *  code, or a caller that has not been threaded through yet, must not silently
 *  start refusing orders — that failure is invisible until someone cannot save.
 *  Under-gating is recoverable (the money still has to be collected before
 *  delivery); over-gating blocks the shop floor with no signal.
 *
 *  MEASURED BEFORE SHIPPING (check-processing-date-gate-impact.mjs on prod,
 *  2026-07-31): of 63 live SOs carrying a Processing Date, 51 are 2990 and 12 are
 *  HOUZS, and moving 2990 to 50% newly refuses **ZERO** of them — no 2990 order
 *  sits in the 30-49% band. This change is a rule correction with no blast radius,
 *  which is exactly why it ships alone. */
export const processingDateThresholdFor = (companyCode?: CompanyCode | string | null): number =>
  String(companyCode ?? '').trim().toUpperCase() === '2990'
    ? PROCEED_PAID_THRESHOLD
    : PROCESSING_DATE_PAID_THRESHOLD;

/** Total physical pieces in an order (for delivery slot allocation). */
export const pieceCount = (_orderItems: unknown[]): number => {
  throw new Error('pieceCount: not yet implemented (Phase 3)');
};
