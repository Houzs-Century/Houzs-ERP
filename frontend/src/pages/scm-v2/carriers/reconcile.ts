// The sums the 3PL invoices and Reconciliation tabs show over the DO charges.
// Pure, so the money is tested without rendering.
import type { ChargeRow } from '../ThreePLInvoices';

/* Per 3PL, from what its bills say (the 3PL invoices tab), against the rate card.
   The trip table reads trips.three_pl_cost_sen, which nothing on screen writes
   and which 3PL work rarely has (it is not planned as trips). The billed cost
   that IS recorded is per DO. */
export type CarrierRecon = {
  carrierId: string; carrierName: string; dos: number; billedSen: number; billedPricedSen: number;
  expectedSen: number; priced: number; off: number; noCard: number;
};
export const carrierRecon = (rows: readonly ChargeRow[]): CarrierRecon[] => {
  const by = new Map<string, CarrierRecon>();
  for (const r of rows) {
    const t = by.get(r.carrierId) ?? { carrierId: r.carrierId, carrierName: r.carrierName ?? '—', dos: 0, billedSen: 0, billedPricedSen: 0, expectedSen: 0, priced: 0, off: 0, noCard: 0 };
    t.dos += 1;
    t.billedSen += r.billedSen;
    if (r.expectedSen == null) t.noCard += 1;
    else { t.expectedSen += r.expectedSen; t.billedPricedSen += r.billedSen; t.priced += 1; if (r.varianceSen) t.off += 1; }
    by.set(r.carrierId, t);
  }
  return [...by.values()].sort((a, b) => a.carrierName.localeCompare(b.carrierName));
};

export interface ChargeTotals {
  dos: number; billedSen: number;
  /** Over the DOs a rate card prices only: a DO with no card has nothing to differ from. */
  expectedSen: number; diffSen: number | null;
  priced: number; over: number; under: number; noCard: number;
}
export const chargeTotals = (rows: readonly ChargeRow[]): ChargeTotals => {
  const t: ChargeTotals = { dos: 0, billedSen: 0, expectedSen: 0, diffSen: null, priced: 0, over: 0, under: 0, noCard: 0 };
  let billedPriced = 0;
  for (const r of rows) {
    t.dos += 1;
    t.billedSen += r.billedSen;
    if (r.expectedSen == null) { t.noCard += 1; continue; }
    t.priced += 1;
    t.expectedSen += r.expectedSen;
    billedPriced += r.billedSen;
    if ((r.varianceSen ?? 0) > 0) t.over += 1;
    else if ((r.varianceSen ?? 0) < 0) t.under += 1;
  }
  t.diffSen = t.priced ? billedPriced - t.expectedSen : null;
  return t;
};
