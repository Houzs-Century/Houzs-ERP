// ----------------------------------------------------------------------------
// pos-kpi-split — the Products / Service / KPI money split behind the POS
// My-Orders tiles. PURE: no I/O, no client, no env.
//
// The rule (Loo 2026-06-20), for ONE scope's set of orders:
//
//   Service  = total − goods            (delivery + every SERVICE line)
//   KPI      = the item-KPI-flagged portion of goods
//   Products = goods − KPI              (the commission threshold base)
//
// so the three rows sum back to the headline total. Products is the threshold
// base precisely BECAUSE the KPI portion is carved out of it: a flagged item
// earns a fixed bonus INSTEAD of percentage commission (hr-commission.ts), so
// counting it in Products would pay for it twice.
//
// Extracted from routes/pos.ts rather than left inline for two reasons: the
// arithmetic is the part worth testing (the reducer is trivial, the clamps are
// not), and /hr/commission applies the same carve-out — one home means the
// dashboard and the commission run cannot answer differently.
// ----------------------------------------------------------------------------

import { unitKpiExcludedSen, type ItemKpiFlag, type KpiUnit } from '../shared/hr-commission';

/** Σ the item-KPI-excluded amount across every unit of every listed order.
 *
 *  A doc with no units contributes 0 — that is the ordinary case (nothing on
 *  the order is flagged), not an error. Unknown doc numbers are simply absent
 *  from the map and likewise contribute nothing. */
export const kpiSenForDocs = (
  docNos: readonly string[],
  unitsByDoc: ReadonlyMap<string, KpiUnit[]>,
  flags: readonly ItemKpiFlag[],
): number =>
  docNos.reduce(
    (sum, doc) =>
      sum
      + (unitsByDoc.get(doc) ?? []).reduce(
        (u, unit) => u + unitKpiExcludedSen(unit, flags as ItemKpiFlag[]),
        0,
      ),
    0,
  );

export interface ScopeRevenueSen {
  /** total_revenue_sen summed over the scope's orders. */
  totalSen: number;
  /** mattress_sofa + bedframe + accessories + others, summed. */
  goodsSen: number;
  /** The item-KPI portion, from kpiSenForDocs. */
  kpiSen: number;
}

export interface ScopeRevenueMyr {
  total: number;
  products: number;
  service: number;
  kpi: number;
}

const toMyr = (sen: number): number => Math.round(Number(sen) / 100);

/** The three tile rows, in whole MYR.
 *
 *  Every branch is clamped at 0, and KPI is additionally clamped to `goodsSen`:
 *  the KPI portion is carved OUT of goods, so a flag mis-set larger than the
 *  order's own goods must never drive Products negative or make the rows sum
 *  past the headline total. A negative input (a credit-note-shaped order) reads
 *  as 0 for the same reason — these tiles are a month's sales pipeline, not a
 *  ledger. */
export const splitScopeRevenue = (r: ScopeRevenueSen): ScopeRevenueMyr => {
  const total = Math.max(0, Number(r.totalSen) || 0);
  const goods = Math.max(0, Number(r.goodsSen) || 0);
  const kpi = Math.min(Math.max(0, Number(r.kpiSen) || 0), goods);
  return {
    total: toMyr(total),
    products: toMyr(Math.max(0, goods - kpi)),
    service: toMyr(Math.max(0, total - goods)),
    kpi: toMyr(kpi),
  };
};
