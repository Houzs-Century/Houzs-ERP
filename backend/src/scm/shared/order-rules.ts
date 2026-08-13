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

/** Inputs to the Processing-Date gate. `paid` / `total` must share a unit
 *  (whole-MYR on the POS, centi on the server) — only their ratio is used, so
 *  either side may pass its own representation. */
export interface ProceedGateInput {
  hasCustomerName: boolean;
  /** Delivery address line 1 present. A "Fill in later" handover leaves this
   *  (and the postcode) blank, so the gate fails — exactly the case that must
   *  keep an order in Order Placed. */
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  paid: number;
  total: number;
  /** Active company ('HOUZS' | '2990') — picks the deposit fraction. */
  companyCode?: CompanyCode | string | null;
}

/** THE gate. One rule, one name — owner 2026-07-31, verbatim: *"不要又 Processing
 *  Date,又 Proceed,全系统直接统一一个叫 Processing Date... Processing Date 就是当天
 *  Proceed 的意思。如果分两个的话,会不会很乱?"*
 *
 *  It answers ONE question — may this order start production? — and every path
 *  that used to ask its own version now asks this: setting `processing_date`
 *  (the date the user picks), auto-stamping `proceeded_at` at create, and the two
 *  manual proceed paths. `proceeded_at` remains a separate COLUMN because it is a
 *  timestamp the system writes, not a date the user picks; what is unified is the
 *  RULE, not the storage.
 *
 *  WHAT CHANGED, and why each way:
 *   - **Threshold is per company** (HOUZS 30% / 2990 50%). Previously two
 *     constants, both applied to everyone; see processingDateThresholdFor.
 *   - **Email is NO LONGER required** (owner 2026-07-31: "不需要email"). It was
 *     the ONLY completeness condition anything was actually missing —
 *     check-processing-date-gate-impact.mjs on prod: of 63 live SOs carrying a
 *     Processing Date, 12 lack an email and ZERO lack a name, address, postcode
 *     or delivery date. Dropping it is what makes unification cost nothing.
 *   - **Name / address / postcode / delivery date are now required to set a
 *     Processing Date**, which they were not before (that gate was money-only).
 *     Free by the same measurement: all 63 already have them.
 *
 *  This LOOSENS the two proceed paths by one condition (an emailless order can
 *  now proceed) and TIGHTENS the processing-date path by four. Both are the
 *  owner's stated intent, both measured before shipping. */
export const meetsProceedGate = (i: ProceedGateInput): boolean =>
  i.hasCustomerName &&
  i.hasAddress &&
  i.hasPostcode &&
  i.hasDeliveryDate &&
  (i.total <= 0 || i.paid / i.total >= processingDateThresholdFor(i.companyCode));

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
