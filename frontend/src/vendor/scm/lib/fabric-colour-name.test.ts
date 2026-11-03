import { describe, expect, it } from 'vitest';
import { fabricColourMeta, fabricColourName } from './fabric-colour-name';

describe('fabricColourName', () => {
  it('keeps a plain name', () => {
    expect(fabricColourName('NICCA-04', 'OLIVE')).toBe('OLIVE');
  });

  it('a label that is only the code has no name', () => {
    expect(fabricColourName('NICCA-07', 'NICCA-07')).toBeNull();
    expect(fabricColourName('NX003', 'nx003')).toBeNull();
    expect(fabricColourName('NICCA-07', null)).toBeNull();
    expect(fabricColourName('NICCA-07', '  ')).toBeNull();
  });

  it('strips the code off the front of the label', () => {
    expect(fabricColourName('NICCA-02', 'NICCA-02 OAT GLOW')).toBe('OAT GLOW');
    expect(fabricColourName('GD2502-14', 'GD2502#14 SILVER')).toBe('SILVER');
    expect(fabricColourName('ZL-11', 'ZL-11 (ZANO LEATHER)')).toBe('ZANO LEATHER');
    expect(fabricColourName('NINJA 06', 'NINJA 06 GREY')).toBe('GREY');
  });

  it('leaves a label that only starts like the code alone', () => {
    expect(fabricColourName('HR805-30', 'HR805-3 SAND')).toBe('HR805-3 SAND');
    expect(fabricColourName('CG-002', 'Sand Beige')).toBe('Sand Beige');
  });
});

describe('fabricColourMeta', () => {
  it('series and name, or says the name is missing', () => {
    expect(fabricColourMeta('NICCA', 'NICCA-04', 'OLIVE')).toBe('NICCA · OLIVE');
    expect(fabricColourMeta('NICCA', 'NICCA-02', 'NICCA-02 OAT GLOW')).toBe('NICCA · OAT GLOW');
    expect(fabricColourMeta('NICCA', 'NICCA-07', 'NICCA-07')).toBe('NICCA · no colour name');
    expect(fabricColourMeta('', 'NICCA-07', 'NICCA-07')).toBe('no colour name');
  });
});
