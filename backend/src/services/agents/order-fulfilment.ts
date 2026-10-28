// ---------------------------------------------------------------------------
// order-fulfilment.ts — the OF-001 readiness assessment, as pure policy.
//
// docs/agents/operating-spec.md §3 (Order Fulfilment Agent): "checks that every
// Sales Order has complete commercial and fulfilment information, determines
// sourcing/production/stock readiness … Identify the precise blocker, responsible
// owner and next required action … present one truthful order status." §3.7
// required outputs: an order readiness score + blocker list, a next-action task
// with owner, and an achievable delivery-ready date.
//
// The signals ALL exist already, scattered — this composes them into ONE verdict
// so no screen has to re-derive "is this order ready, and if not, who owns the
// fix":
//   • stock       — scm/lib/so-readiness.ts (summariseReadiness → isMainReady)
//   • payment      — services/agents/release-gate.ts (RELEASE / HOLD)
//   • order data   — scm/shared/order-rules.ts (the meetsProceedGate inputs)
//   • SO status    — delivery-orders-mfg.ts SO_UNDELIVERABLE_STATUSES
//   • supply date  — mrp.ts computeMrp (achievable ready date; the CS agent's Job A)
//
// Pure: no DB, no LLM. It takes primitive signals (not table rows) so it stays
// decoupled from every caller's query shape, and every branch is unit-testable.
// It COMPUTES readiness; it does not release delivery, change price, create the
// task, or move a date — those are other agents' authority (spec §3.6 exclusions).
// ---------------------------------------------------------------------------

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
  /** What is wrong, in the office's language. */
  message: string;
  /** The single next action that clears it — the spec's "next required action". */
  nextAction: string;
}

export interface FulfilmentInput {
  /** mfg_so_status: CONFIRMED / IN_PRODUCTION / READY_TO_SHIP / … / ON_HOLD / DRAFT / CANCELLED. */
  status: string;
  /** mfg_sales_orders.on_hold — the mig-0324 hold MARKER. REQUIRED, and `null`
   *  only where the caller genuinely could not read the column: a held order
   *  keeps its real status, so `status` alone can no longer say. */
  onHold: boolean | null;
  /** From summariseReadiness: every MAIN product line allocated. */
  isMainReady: boolean;
  /** Every MAIN and accessory line allocated. */
  isFullyReady: boolean;
  /** From computeReleaseGate: HOLD means a payment gate is not met. */
  releaseDecision: ReleaseDecision;
  /** The meetsProceedGate completeness signals. */
  hasCustomerName: boolean;
  hasEmail: boolean;
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  /** From MRP: at least one line is an uncovered shortage (no stock, no PO ETA).
   *  Optional — omit when supply has not been computed (a cheaper caller). */
  supplyShortage?: boolean;
  /** From MRP + transit: the earliest date the SO could be delivery-ready, or
   *  null when a shortage makes it unknowable. Passed through unchanged. */
  achievableReadyDate?: string | null;
}

export interface FulfilmentReadiness {
  /** 0..100. 100 = clear to fulfil. Each blocker subtracts a weight. */
  score: number;
  /** True when nothing BLOCK-severity remains. */
  ready: boolean;
  /** Most-severe first, then in the order a person would resolve them. */
  blockers: Blocker[];
  /** The top blocker's next action, or null when ready. The spec's
   *  "next-action task with owner and deadline" — owner is on the blocker. */
  nextAction: string | null;
  /** Passed through from MRP; null when a shortage makes it unknowable. */
  achievableReadyDate: string | null;
}

const WEIGHT: Record<BlockerSeverity, number> = { BLOCK: 34, WARN: 8 };

/** A terminal / paused status is the ONE blocker that makes the rest moot — a
 *  cancelled order's missing address is noise. Returned alone when present. */
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

/* THE HOLD MARKER (mig 0324) — the same blocker, reached from a column instead
   of from the status. It is a separate function rather than an extra argument
   to statusBlocker because the caller composes blockers in a deliberate ORDER
   and this one belongs exactly where the status stop belongs: first, because it
   makes the rest moot.

   A held order now keeps its real status, so `statusBlocker` alone stopped
   being able to see a hold — it would have returned null for every held order
   and the agent would have reported an order somebody stopped as ready. */
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

  // A cancelled/draft/held order: report that alone. Everything else is noise
  // until the status is resolved.
  const status = holdBlocker(input.onHold) ?? statusBlocker(input.status);
  if (status) {
    return {
      score: 0, ready: false, blockers: [status],
      nextAction: status.nextAction, achievableReadyDate: passThroughDate,
    };
  }

  const blockers: Blocker[] = [];

  // Missing order data — the SO cannot be produced or delivered without it, and
  // Sales owns the SO. Split so the office sees exactly which field is missing.
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

  // Payment gate not met (only when the owner has turned a hard hold on; the
  // default release policy never HOLDs on balance alone).
  if (input.releaseDecision === 'HOLD') {
    blockers.push({ code: 'PAYMENT_HOLD', severity: 'BLOCK', owner: 'FINANCE',
      message: 'the payment gate is not met', nextAction: 'collect the required payment or approve a release exception' });
  }

  // Supply: an uncovered shortage means neither stock nor an incoming PO can meet
  // a line — production/procurement own it. Only when supply was computed.
  if (input.supplyShortage === true) {
    blockers.push({ code: 'SUPPLY_SHORTAGE', severity: 'BLOCK', owner: 'PROCUREMENT',
      message: 'a line has no stock and no incoming purchase order', nextAction: 'raise or expedite a purchase order for the short line' });
  }

  // Stock allocation: MAIN products not all allocated. Distinct from a shortage —
  // the stock may exist but is not yet allocated to this SO.
  if (!input.isMainReady) {
    blockers.push({ code: 'STOCK_NOT_READY', severity: 'BLOCK', owner: 'WAREHOUSE',
      message: 'the main products are not all allocated', nextAction: 'allocate stock to the order lines' });
  } else if (!input.isFullyReady) {
    // Main is ready; only accessories pending. B2C rule: this does NOT hold a
    // ship, so it is a WARN, not a BLOCK.
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
