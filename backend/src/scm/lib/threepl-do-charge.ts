/* HC-0031: tally a 3PL's invoice against the rate card, PER DELIVERY ORDER.
 *
 * Prod has no trips (3PL work is not planned in Delivery Planning), so each DO
 * is priced on its own: one drop, one customer, its own set/item count and
 * zone. The FIXED per-trip outstation fee (OUTSTATION_TRIP) is left out on
 * purpose: with no trip there is nothing to charge it once against, and
 * charging it on every DO would overstate the expected cost. Its absence shows
 * up as variance, which is the honest place for it. PURE. */
import { computeDeliveryCost, type DeliveryFacts, type RateCardSpec } from './delivery-rate-card';
import { deriveSetCount, type SetLine } from './set-count';

export function doFacts(lines: readonly SetLine[], zone: string | null, address: string | null): DeliveryFacts {
  const live = lines.filter((l) => !l.cancelled);
  const itemCount = live
    .filter((l) => String(l.category).toUpperCase() !== 'SOFA')
    .reduce((n, l) => n + Math.max(0, Math.round(Number(l.qty) || 0)), 0);
  return {
    setCount: deriveSetCount(live).sets,
    itemCount,
    dropCount: 1,
    customerCount: 1,
    destinationZone: zone,
    destinationZones: zone ? [zone] : [],
    addressText: address,
  };
}

/** The system amount for one DO, or null when the carrier has no card. */
export function expectedSen(card: RateCardSpec | null, facts: DeliveryFacts): number | null {
  return card ? computeDeliveryCost(card, facts).totalSen : null;
}

/** billed - expected: positive = the carrier billed MORE than the card says. */
export function varianceSen(billed: number, expected: number | null): number | null {
  return expected == null ? null : billed - expected;
}

export interface ChargeRowForTotal {
  carrierId: string;
  invoiceNo: string | null;
  billedSen: number;
  expectedSen: number | null;
}

/** One line per (carrier, invoice no): what the invoice says vs what the card
 *  says, summed over its DOs. expected/variance are null if ANY DO on it could
 *  not be priced - a partial sum would read as a real shortfall. */
export function invoiceTotals(rows: readonly ChargeRowForTotal[]) {
  const by = new Map<string, { carrierId: string; invoiceNo: string | null; dos: number; billedSen: number; expectedSen: number | null }>();
  for (const r of rows) {
    const k = `${r.carrierId}|${r.invoiceNo ?? ''}`;
    const t = by.get(k) ?? { carrierId: r.carrierId, invoiceNo: r.invoiceNo, dos: 0, billedSen: 0, expectedSen: 0 };
    t.dos += 1;
    t.billedSen += r.billedSen;
    t.expectedSen = t.expectedSen == null || r.expectedSen == null ? null : t.expectedSen + r.expectedSen;
    by.set(k, t);
  }
  return [...by.values()].map((t) => ({ ...t, varianceSen: varianceSen(t.billedSen, t.expectedSen) }));
}
