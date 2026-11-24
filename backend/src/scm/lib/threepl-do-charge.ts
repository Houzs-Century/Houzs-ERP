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

type OrderRow = Record<string, unknown>;
const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** One sales order line as the set count reads it: its group decides frame /
 *  mattress / sofa, and its ordered quantity counts. Shared with the Own fleet
 *  tab (own-fleet-load.ts), so our lorries and a 3PL count a DO's sets alike. */
export function setLineOf(line: OrderRow): SetLine {
  const g = String(line.item_group ?? '').toUpperCase();
  return {
    category: g.includes('BEDFRAME') ? 'BEDFRAME' : g.includes('SOFA') ? 'SOFA' : g.includes('MATTRESS') ? 'MATTRESS' : 'OTHERS',
    qty: Number(line.qty ?? 1), cancelled: line.cancelled === true,
  };
}

/** The words a town surcharge or a rate card area is found by: the order's whole address and its city. */
export function orderAddressText(so: OrderRow): string {
  return [text(so.address1), text(so.address2), text(so.address3), text(so.address4), text(so.city), text(so.postcode)].filter(Boolean).join(' ');
}

/** An order's goods value in sen: its goods by category on the order (mattress
 *  and sofa, bedframe, accessories, others), its service lines left out. What
 *  the Singapore carriers charge their shares of: 30 of 30 orders on their
 *  bills since September 2026 are exactly this figure. */
export function orderGoodsSen(so: OrderRow): number {
  const part = (v: unknown) => Math.max(0, Math.round(Number(v ?? 0)) || 0);
  return part(so.mattress_sofa_sen) + part(so.bedframe_sen) + part(so.accessories_sen) + part(so.others_sen);
}

/** A DO's goods value: its order's, in the DO's share of the order's total when
 *  the order goes out in more than one DO (a follow-up DO of RM 0 carries none). */
export function doGoodsSen(orderGoods: number, orderTotalSen: number, doTotalSen: number | null): number {
  if (orderGoods <= 0) return 0;
  if (doTotalSen == null || orderTotalSen <= 0) return orderGoods;
  return Math.round(orderGoods * Math.min(1, Math.max(0, doTotalSen / orderTotalSen)));
}

export function doFacts(lines: readonly SetLine[], zone: string | null, address: string | null, goodsValueSen: number | null): DeliveryFacts {
  const live = lines.filter((l) => !l.cancelled);
  const itemCount = live
    .filter((l) => String(l.category).toUpperCase() !== 'SOFA')
    .reduce((n, l) => n + Math.max(0, Math.round(Number(l.qty) || 0)), 0);
  return {
    setCount: deriveSetCount(live).sets,
    itemCount,
    dropCount: 1,
    customerCount: 1,
    goodsValueSen,
    destinationZone: zone,
    destinationZones: zone ? [zone] : [],
    addressText: address,
    /* The one address, with its postcode zone: a town on the card counts only
       inside its own zone (Delivery Zones places). */
    stops: [{ zone, addressText: address }],
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
