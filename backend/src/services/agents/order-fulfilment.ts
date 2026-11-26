
import type { ReleaseDecision } from './release-gate';

/** Who owns fixing a blocker. Matches the department JDs: Sales owns the SO
 *  (its data), the Office does DO/SI, Finance owns the money, Procurement/Production
 *  own supply, the Warehouse owns allocation. */
export type BlockerOwner = 'SALES' | 'FINANCE' | 'PROCUREMENT' | 'WAREHOUSE' | 'OFFICE';

export type BlockerCode =
  | 'SO_CANCELLED'
  | 'SO_DRAFT'
  | 'SO_ON_HOLD'
  | 'MISSING_CUSTOMER_INFO'
  | 'MISSING_ADDRESS'
  | 'MISSING_DELIVERY_DATE'
  | 'PAYMENT_HOLD'
  | 'SUPPLY_SHORTAGE'
  | 'STOCK_NOT_READY'
  | 'ACCESSORIES_PENDING';

/** BLOCK stops delivery; WARN is worth surfacing but does not (accessories, per
 *  the B2C rule that a pending accessory never holds a ship). */
export type BlockerSeverity = 'BLOCK' | 'WARN';

export interface Blocker {
  code: BlockerCode;
  severity: BlockerSeverity;
  owner: BlockerOwner;
  message: string;
  nextAction: string;
}

export interface FulfilmentInput {
  status: string;
  onHold: boolean | null;
  isMainReady: boolean;
  isFullyReady: boolean;
  releaseDecision: ReleaseDecision;
  hasCustomerName: boolean;
  hasEmail: boolean;
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  supplyShortage?: boolean;
  achievableReadyDate?: string | null;
}

export interface FulfilmentReadiness {
  score: number;
  ready: boolean;
  blockers: Blocker[];
  nextAction: string | null;
  achievableReadyDate: string | null;
}

const WEIGHT: Record<BlockerSeverity, number> = { BLOCK: 34, WARN: 8 };

function statusBlocker(status: string): Blocker | null {
  const s = status.toUpperCase();
  if (s === 'CANCELLED') {
    return { code: 'SO_CANCELLED', severity: 'BLOCK', owner: 'SALES',
      message: 'the order is cancelled', nextAction: 'reinstate the order if this delivery should proceed' };
  }
  if (s === 'DRAFT') {
    return { code: 'SO_DRAFT', severity: 'BLOCK', owner: 'SALES',
      message: 'the order is still a draft', nextAction: 'confirm the order to start fulfilment' };
  }
  if (s === 'ON_HOLD') {
    return { code: 'SO_ON_HOLD', severity: 'BLOCK', owner: 'OFFICE',
      message: 'the order is on hold', nextAction: 'resolve the hold reason, then resume the order' };
  }
  return null;
}

export function holdBlocker(onHold: boolean | null | undefined): Blocker | null {
  if (onHold !== true) return null;
  return { code: 'SO_ON_HOLD', severity: 'BLOCK', owner: 'OFFICE',
    message: 'the order is on hold', nextAction: 'resolve the hold reason, then resume the order' };
}

/**
 * Assess one SO's fulfilment readiness from its signals.
 *
 * Order of the returned blockers is deliberate: a status stop first (it makes the
 * rest moot), then the things that keep an order out of production at all
 * (missing data, payment), then supply, then stock, then the non-blocking
 * accessory warning. That order is also the order a person clears them in.
 */
export function assessFulfilment(input: FulfilmentInput): FulfilmentReadiness {
  const passThroughDate = input.achievableReadyDate ?? null;

  const status = holdBlocker(input.onHold) ?? statusBlocker(input.status);
  if (status) {
    return {
      score: 0, ready: false, blockers: [status],
      nextAction: status.nextAction, achievableReadyDate: passThroughDate,
    };
  }

  const blockers: Blocker[] = [];

  if (!input.hasCustomerName || !input.hasEmail) {
    blockers.push({ code: 'MISSING_CUSTOMER_INFO', severity: 'BLOCK', owner: 'SALES',
      message: 'customer name or email is missing', nextAction: 'complete the customer contact details' });
  }
  if (!input.hasAddress || !input.hasPostcode) {
    blockers.push({ code: 'MISSING_ADDRESS', severity: 'BLOCK', owner: 'SALES',
      message: 'delivery address or postcode is missing', nextAction: 'capture the full delivery address' });
  }
  if (!input.hasDeliveryDate) {
    blockers.push({ code: 'MISSING_DELIVERY_DATE', severity: 'BLOCK', owner: 'SALES',
      message: 'no delivery date is set', nextAction: 'agree and record a delivery date with the customer' });
  }

  if (input.releaseDecision === 'HOLD') {
    blockers.push({ code: 'PAYMENT_HOLD', severity: 'BLOCK', owner: 'FINANCE',
      message: 'the payment gate is not met', nextAction: 'collect the required payment or approve a release exception' });
  }

  if (input.supplyShortage === true) {
    blockers.push({ code: 'SUPPLY_SHORTAGE', severity: 'BLOCK', owner: 'PROCUREMENT',
      message: 'a line has no stock and no incoming purchase order', nextAction: 'raise or expedite a purchase order for the short line' });
  }

  if (!input.isMainReady) {
    blockers.push({ code: 'STOCK_NOT_READY', severity: 'BLOCK', owner: 'WAREHOUSE',
      message: 'the main products are not all allocated', nextAction: 'allocate stock to the order lines' });
  } else if (!input.isFullyReady) {
    blockers.push({ code: 'ACCESSORIES_PENDING', severity: 'WARN', owner: 'WAREHOUSE',
      message: 'accessories are not all allocated (does not hold the delivery)', nextAction: 'allocate the accessory lines when stock arrives' });
  }

  const penalty = blockers.reduce((sum, b) => sum + WEIGHT[b.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const ready = !blockers.some((b) => b.severity === 'BLOCK');
  const top = blockers[0] ?? null;

  return {
    score,
    ready,
    blockers,
    nextAction: top ? top.nextAction : null,
    achievableReadyDate: passThroughDate,
  };
}
