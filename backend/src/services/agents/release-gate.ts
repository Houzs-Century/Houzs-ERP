// ---------------------------------------------------------------------------
// release-gate.ts — the AR-005 delivery-release gate, as pure policy.
//
// docs/agents/operating-spec.md §7 (Receivables, Collection & Delivery-Release):
// the agent "supplies a payment-release gate to fulfilment/delivery. It does NOT
// move money, refund customers or post accounting entries." §7.10: "Provides
// payment gate to Fulfilment and Delivery." governance.ts already declares the
// DELIVERY_HOLD / DELIVERY_RELEASE / BALANCE_CALCULATION decision classes; this
// file is the deterministic calculation behind them.
//
// It computes, it does not decide business policy. Houzs is B2C: a deposit is
// taken on the ORDER and the balance is typically collected ON delivery (POD).
// So the default here does NOT block delivery for an outstanding balance — it
// RELEASES WITH COLLECTION, telling POD exactly what to collect. A hard hold is
// opt-in: the owner raises `minPaidFractionToRelease` (settings) and only then
// does an under-paid order HOLD. The threshold is a config value, never a number
// invented in code — the same discipline order-rules.ts follows for the 30%/50%
// gates it deliberately keeps as named constants.
//
// Pure: no DB, no LLM, integer sen throughout (the repo's money unit).
// ---------------------------------------------------------------------------

import type { DataQuality } from './governance';

export type ReleaseDecision =
  /** Nothing outstanding — dispatch is clear. */
  | 'RELEASE'
  /** Dispatch allowed, but a balance remains for POD to collect on delivery.
   *  This is the NORMAL Houzs case, not a problem — the amount is stated so the
   *  driver collects the right sum. */
  | 'RELEASE_WITH_COLLECTION'
  /** Under the configured pre-dispatch payment floor — a human must decide. */
  | 'HOLD';

export interface ReleasePolicy {
  /** Fraction of the order total (0..1) that must be paid BEFORE dispatch. The
   *  Houzs default is 0: the balance is a POD collection, not a dispatch blocker.
   *  Raise it (e.g. 0.5 to require the deposit be in) to turn on a hard hold. */
  minPaidFractionToRelease: number;
}

/** The B2C default: no pre-dispatch payment floor. Delivery is not blocked by an
 *  outstanding balance; POD collects it. Matches how the DO path works today,
 *  where deposit is explicitly NOT gated at the DO. */
export const DEFAULT_RELEASE_POLICY: ReleasePolicy = { minPaidFractionToRelease: 0 };

export interface ReleaseGateInput {
  totalCenti: number;
  paidCenti: number;
  policy?: ReleasePolicy;
  /** The freshness/integrity of the figures. RED never RELEASEs — an unreconciled
   *  or missing balance is exactly when the spec says stop and escalate (§10.2). */
  dataQuality?: DataQuality;
}

export interface ReleaseGate {
  totalCenti: number;
  paidCenti: number;
  remainingCenti: number;
  /** 0..1, clamped. A free order (total ≤ 0) is treated as fully paid. */
  paidFraction: number;
  decision: ReleaseDecision;
  /** What POD must collect on delivery. 0 unless RELEASE_WITH_COLLECTION. */
  collectOnDeliveryCenti: number;
  /** One line naming the decision, for the run summary / driver manifest. */
  reason: string;
  /** True only when the figures could not be trusted — the caller must escalate
   *  rather than dispatch on a number it cannot stand behind. */
  needsEscalation: boolean;
}

const clampFraction = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Compute the release gate for one order from its total and paid figures.
 *
 * Never throws, never moves money, never writes. The autonomy question — may the
 * agent ACT on this gate alone? — is separate and belongs to
 * governance.canSelfApprove('HZS-AR-005', 'DELIVERY_RELEASE', …); a RELEASE here
 * is a RECOMMENDATION at Stage 1, the spec's default for this class.
 */
export function computeReleaseGate(input: ReleaseGateInput): ReleaseGate {
  const totalCenti = Math.max(0, Math.round(input.totalCenti || 0));
  const paidCenti = Math.max(0, Math.round(input.paidCenti || 0));
  const remainingCenti = Math.max(0, totalCenti - paidCenti);
  const paidFraction = totalCenti <= 0 ? 1 : clampFraction(paidCenti / totalCenti);
  const dq = input.dataQuality ?? 'GREEN';
  const floor = input.policy?.minPaidFractionToRelease ?? DEFAULT_RELEASE_POLICY.minPaidFractionToRelease;

  // RED figures: never release on a balance we cannot defend. This mirrors the
  // POD rule already in the repo — "never show or collect a balance we cannot
  // defend" — surfaced here as a hold-for-escalation rather than a dispatch.
  if (dq === 'RED') {
    return {
      totalCenti, paidCenti, remainingCenti, paidFraction,
      decision: 'HOLD', collectOnDeliveryCenti: 0, needsEscalation: true,
      reason: 'payment figures are unreconciled (data-quality RED) — hold and escalate, do not dispatch on an untrusted balance',
    };
  }

  // Below the configured pre-dispatch floor → a human decides. Default floor is
  // 0, so this branch is only ever reached when the owner has turned a hard hold
  // ON. Named with the numbers so the reason is actionable.
  if (totalCenti > 0 && paidFraction < floor) {
    return {
      totalCenti, paidCenti, remainingCenti, paidFraction,
      decision: 'HOLD', collectOnDeliveryCenti: 0, needsEscalation: false,
      reason: `paid ${(paidFraction * 100).toFixed(0)}% is below the ${(floor * 100).toFixed(0)}% required before dispatch — human approval required`,
    };
  }

  if (remainingCenti <= 0) {
    return {
      totalCenti, paidCenti, remainingCenti, paidFraction,
      decision: 'RELEASE', collectOnDeliveryCenti: 0, needsEscalation: false,
      reason: 'fully paid — clear to dispatch',
    };
  }

  return {
    totalCenti, paidCenti, remainingCenti, paidFraction,
    decision: 'RELEASE_WITH_COLLECTION', collectOnDeliveryCenti: remainingCenti, needsEscalation: false,
    reason: `clear to dispatch; POD to collect the ${(remainingCenti / 100).toFixed(2)} balance on delivery`,
  };
}
