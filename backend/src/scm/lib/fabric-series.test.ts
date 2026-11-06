import { describe, expect, it } from 'vitest';
import { fabricSeriesGroups, seriesOf } from './fabric-series';

describe('seriesOf', () => {
  it('strips the colour number', () => {
    expect(seriesOf('BROWNIE-03')).toBe('BROWNIE');
    expect(seriesOf('SF-AT-01')).toBe('SF-AT');
    expect(seriesOf('KN07')).toBe('KN07');
  });
});

describe('fabricSeriesGroups', () => {
  const lib = new Set(['BROWNIE', 'KN01', 'KN02', 'CG']);
  it('groups library ids under the named series, once each', () => {
    expect(fabricSeriesGroups([
      { fabric_code: 'KN02', series: 'EMBRACE' },
      { fabric_code: 'KN01', series: 'EMBRACE' },
      { fabric_code: 'BROWNIE-01', series: 'HOMELY' },
      { fabric_code: 'BROWNIE-02', series: ' HOMELY ' },
    ], lib)).toEqual([
      { series: 'EMBRACE', refs: ['KN01', 'KN02'] },
      { series: 'HOMELY', refs: ['BROWNIE'] },
    ]);
  });
  it('drops blank series and ids a rule cannot name', () => {
    expect(fabricSeriesGroups([
      { fabric_code: 'CG-002', series: null },
      { fabric_code: 'ZZ-01', series: 'GONE' },
    ], lib)).toEqual([]);
  });
});
