import { describe, expect, test } from 'vitest';
import { fabricAllowedByPool, inFabricPool } from './fabric-pool';

/* The pool values below are shapes measured on production (docs/bugs/0814):
   fabric_library ids (series), the odd colour id, and "TARONI " with the
   trailing space every company-1 sofa Model carried. */
const POOL = ['BO315', 'GD2034', 'CG-002-11', 'TARONI '];

describe('fabricAllowedByPool', () => {
  test('an empty or absent pool restricts nothing', () => {
    expect(fabricAllowedByPool([], 'GD2502-11', 'GD2502')).toBe(true);
    expect(fabricAllowedByPool(null, 'GD2502-11', 'GD2502')).toBe(true);
    expect(fabricAllowedByPool(undefined, 'GD2502-11', null)).toBe(true);
  });

  test('a SERIES in the pool admits every colour of that series', () => {
    expect(fabricAllowedByPool(POOL, 'BO315-23', 'BO315')).toBe(true);
  });

  test('a COLOUR in the pool admits that colour, even with its series absent', () => {
    expect(fabricAllowedByPool(POOL, 'CG-002-11', 'CG-002')).toBe(true);
  });

  test('a colour whose colour and series are both absent is refused', () => {
    expect(fabricAllowedByPool(POOL, 'GD2502-11', 'GD2502')).toBe(false);
  });

  test('an unknown series cannot widen the answer', () => {
    expect(fabricAllowedByPool(POOL, 'BO315-23', null)).toBe(false);
    expect(fabricAllowedByPool(POOL, 'BO315-23', '')).toBe(false);
  });

  test('a trailing space in the pool does not hide the fabric', () => {
    expect(fabricAllowedByPool(POOL, 'TARONI-05', 'TARONI')).toBe(true);
  });

  test('a series LABEL is not a series id', () => {
    expect(fabricAllowedByPool(['GD2034 (HIVE)'], 'GD2034-01', 'GD2034')).toBe(false);
  });
});

describe('inFabricPool', () => {
  test('exact first, then folded quotes and space', () => {
    expect(inFabricPool(['17"'], '17"')).toBe(true);
    expect(inFabricPool(['17“'], '17"')).toBe(true);
    expect(inFabricPool(['  BO315 '], 'BO315')).toBe(true);
    expect(inFabricPool(['BO315'], 'BO31')).toBe(false);
  });
});
