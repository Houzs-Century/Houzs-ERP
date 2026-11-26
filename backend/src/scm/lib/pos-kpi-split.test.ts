
import { describe, expect, it } from 'vitest';
import { kpiSenForDocs, splitScopeRevenue } from './pos-kpi-split';
import type { ItemKpiFlag, KpiUnit } from '../shared/hr-commission';

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
    expect(kpiSenForDocs(['SO-1', 'SO-2'], units, fabricFlag)).toBe(25_000);
  });

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
  it('carves KPI OUT of Products, and the rows sum to the total', () => {
    const r = splitScopeRevenue({ totalSen: 337_500, goodsSen: 312_500, kpiSen: 12_500 });
    expect(r.total).toBe(3_375);
    expect(r.products).toBe(3_000);
    expect(r.service).toBe(250);
    expect(r.kpi).toBe(125);
    expect(r.products + r.service + r.kpi).toBe(r.total);
  });

  it('with no KPI, Products is the whole goods figure', () => {
    const r = splitScopeRevenue({ totalSen: 337_500, goodsSen: 312_500, kpiSen: 0 });
    expect(r.products).toBe(3_125);
    expect(r.kpi).toBe(0);
    expect(r.products + r.service + r.kpi).toBe(r.total);
  });

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

  it('never reports negative Service when goods exceed the total', () => {
    const r = splitScopeRevenue({ totalSen: 100_000, goodsSen: 312_500, kpiSen: 0 });
    expect(r.service).toBe(0);
  });

  it('survives NaN inputs rather than propagating them to the tile', () => {
    const r = splitScopeRevenue({ totalSen: Number.NaN, goodsSen: Number.NaN, kpiSen: Number.NaN });
    expect(r).toEqual({ total: 0, products: 0, service: 0, kpi: 0 });
  });
});
