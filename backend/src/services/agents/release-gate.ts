
import type { DataQuality } from './governance';
import { fmtSen } from '../../scm/shared/format';

export type ReleaseDecision =
  | 'RELEASE'
  | 'RELEASE_WITH_COLLECTION'
  | 'HOLD';

export interface ReleasePolicy {
  minPaidFractionToRelease: number;
}

/** The B2C default: no pre-dispatch payment floor. Delivery is not blocked by an
 *  outstanding balance; POD collects it. Matches how the DO path works today,
 *  where deposit is explicitly NOT gated at the DO. */
export const DEFAULT_RELEASE_POLICY: ReleasePolicy = { minPaidFractionToRelease: 0 };

export interface ReleaseGateInput {
  totalSen: number;
  paidSen: number;
  policy?: ReleasePolicy;
  dataQuality?: DataQuality;
}

export interface ReleaseGate {
  totalSen: number;
  paidSen: number;
  remainingSen: number;
  paidFraction: number;
  decision: ReleaseDecision;
  collectOnDeliverySen: number;
  reason: string;
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
  const totalSen = Math.max(0, Math.round(input.totalSen || 0));
  const paidSen = Math.max(0, Math.round(input.paidSen || 0));
  const remainingSen = Math.max(0, totalSen - paidSen);
  const paidFraction = totalSen <= 0 ? 1 : clampFraction(paidSen / totalSen);
  const dq = input.dataQuality ?? 'GREEN';
  const floor = input.policy?.minPaidFractionToRelease ?? DEFAULT_RELEASE_POLICY.minPaidFractionToRelease;

  if (dq === 'RED') {
    return {
      totalSen, paidSen, remainingSen, paidFraction,
      decision: 'HOLD', collectOnDeliverySen: 0, needsEscalation: true,
      reason: 'payment figures are unreconciled (data-quality RED) — hold and escalate, do not dispatch on an untrusted balance',
    };
  }

  if (totalSen > 0 && paidFraction < floor) {
    return {
      totalSen, paidSen, remainingSen, paidFraction,
      decision: 'HOLD', collectOnDeliverySen: 0, needsEscalation: false,
      reason: `paid ${(paidFraction * 100).toFixed(0)}% is below the ${(floor * 100).toFixed(0)}% required before dispatch — human approval required`,
    };
  }

  if (remainingSen <= 0) {
    return {
      totalSen, paidSen, remainingSen, paidFraction,
      decision: 'RELEASE', collectOnDeliverySen: 0, needsEscalation: false,
      reason: 'fully paid — clear to dispatch',
    };
  }

  return {
    totalSen, paidSen, remainingSen, paidFraction,
    decision: 'RELEASE_WITH_COLLECTION', collectOnDeliverySen: remainingSen, needsEscalation: false,
    reason: `clear to dispatch; POD to collect the ${fmtSen(remainingSen)} balance on delivery`,
  };
}
