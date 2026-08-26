// The Products / Service / KPI split behind the POS My-Orders tiles.
//
// Reported 26 Aug 2026: "KPI item sales revenue" read RM 0 for every
// salesperson, on both the Showroom and the Personal card, in both companies.
// It was a hardcoded `kpi: 0` in routes/pos.ts, left behind a comment saying
// the HR commission machinery had "no Houzs home yet" — which had stopped being
// true when hr.ts and lib/kpi-units.ts were ported. Nothing computed it, so
// tracing from the POS could never find a source.
//
// These pin the arithmetic the route now delegates here: the carve-out (KPI
// comes OUT of Products, not on top), the clamps, and that a zero answer means
// "nothing is flagged" rather than "not implemented".

import { describe, expect, it } from 'vitest';
import { kpiSenForDocs, splitScopeRevenue } from './pos-kpi-split';
import type { ItemKpiFlag, KpiUnit } from '../shared/hr-commission';

/* Loo's worked example, reused from hr-commission.test.ts: a sofa at RM 3,125
   whose RM 125 is a fabric Δ, with fabric 'fab-D' flagged. */
const sofa: KpiUnit = {
  itemCodes: ['ANNSA-3S'],
  qty: 1,
  category: 'SOFA',
  fabricId: 'fab-D',
  specialCodes: [],
  lineTotalSen: 312_500,
  fabricAddonUnitSen: 12_500,
  specialSurchargeUnitSen: 0,
};
const fabricFlag: ItemKpiFlag[] = [{ flagType: 'fabric', ref: 'fab-D', bonusSen: 5_000 }];

describe('kpiSenForDocs', () => {
  it('sums the excluded portion across the scope’s orders', () => {
    const units = new Map([['SO-1', [sofa]], ['SO-2', [sofa]]]);
    expect(kpiSenForDocs(['SO-1', 'SO-2'], units, fabricFlag)).toBe(25_000); // 2 × RM 125
  });

  /* The ordinary case. Nothing on the order is flagged, so the row reads RM 0 —
     which is a real answer, not the missing implementation it used to be. */
  it('is 0 when no flag is configured', () => {
    expect(kpiSenForDocs(['SO-1'], new Map([['SO-1', [sofa]]]), [])).toBe(0);
  });

  it('counts a doc with no units as 0 rather than throwing', () => {
    expect(kpiSenForDocs(['SO-1', 'SO-ABSENT'], new Map([['SO-1', [sofa]]]), fabricFlag)).toBe(12_500);
  });

  it('an empty scope is 0', () => {
    expect(kpiSenForDocs([], new Map(), fabricFlag)).toBe(0);
  });
});

describe('splitScopeRevenue', () => {
  /* The headline case: RM 3,125 goods + RM 250 delivery, RM 125 of it flagged.
     Products loses the flagged portion; the three rows still sum to the total. */
  it('carves KPI OUT of Products, and the rows sum to the total', () => {
    const r = splitScopeRevenue({ totalSen: 337_500, goodsSen: 312_500, kpiSen: 12_500 });
    expect(r.total).toBe(3_375);
    expect(r.products).toBe(3_000);  // 3,125 − 125
    expect(r.service).toBe(250);
    expect(r.kpi).toBe(125);
    expect(r.products + r.service + r.kpi).toBe(r.total);
  });

  /* The behaviour every salesperson has seen until now — still correct when
     genuinely nothing is flagged. Products keeps the whole goods figure. */
  it('with no KPI, Products is the whole goods figure', () => {
    const r = splitScopeRevenue({ totalSen: 337_500, goodsSen: 312_500, kpiSen: 0 });
    expect(r.products).toBe(3_125);
    expect(r.kpi).toBe(0);
    expect(r.products + r.service + r.kpi).toBe(r.total);
  });

  /* A flag mis-set larger than the order's own goods must not drive Products
     negative or push the rows past the headline. */
  it('clamps KPI to goods, so Products never goes negative', () => {
    const r = splitScopeRevenue({ totalSen: 337_500, goodsSen: 312_500, kpiSen: 999_999 });
    expect(r.kpi).toBe(3_125);
    expect(r.products).toBe(0);
    expect(r.products + r.service + r.kpi).toBe(r.total);
  });

  it('a service-only order is all Service', () => {
    const r = splitScopeRevenue({ totalSen: 25_000, goodsSen: 0, kpiSen: 0 });
    expect(r).toEqual({ total: 250, products: 0, service: 250, kpi: 0 });
  });

  it('an empty scope is all zeroes, not NaN', () => {
    const r = splitScopeRevenue({ totalSen: 0, goodsSen: 0, kpiSen: 0 });
    expect(r).toEqual({ total: 0, products: 0, service: 0, kpi: 0 });
  });

  /* goods > total should not manufacture negative Service. */
  it('never reports negative Service when goods exceed the total', () => {
    const r = splitScopeRevenue({ totalSen: 100_000, goodsSen: 312_500, kpiSen: 0 });
    expect(r.service).toBe(0);
  });

  it('survives NaN inputs rather than propagating them to the tile', () => {
    const r = splitScopeRevenue({ totalSen: Number.NaN, goodsSen: Number.NaN, kpiSen: Number.NaN });
    expect(r).toEqual({ total: 0, products: 0, service: 0, kpi: 0 });
  });
});
