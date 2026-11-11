import { describe, expect, test } from 'vitest';
import { findSofaSetSupplierSplits, sofaSetKey } from './sofa-set-identity';

const pick = (soDocNo: string, itemCode: string, supplierId: string) => ({ soDocNo, itemCode, supplierId });

describe('sofaSetKey: one model on one order is one set', () => {
  test('modules of one model share a key, whatever the case', () => {
    expect(sofaSetKey('HC-SO-1', '8030-1A(LHF)')).toBe(sofaSetKey('HC-SO-1', '8030-1A(RHF)'));
    expect(sofaSetKey('HC-SO-1', 'booqit-2A')).toBe(sofaSetKey('HC-SO-1', 'BOOQIT-L(LHF)'));
  });

  test('two models of one order, or one model on two orders, are different sets', () => {
    expect(sofaSetKey('HC-SO-1', '8030-1A(LHF)')).not.toBe(sofaSetKey('HC-SO-1', '8069-1A(LHF)'));
    expect(sofaSetKey('HC-SO-1', '8030-1A(LHF)')).not.toBe(sofaSetKey('HC-SO-2', '8030-1A(LHF)'));
  });
});

describe('findSofaSetSupplierSplits', () => {
  test('HC-SO-2610-104: 8030 from Hookka and 8069 from Dorsettloft needs a confirm, not a refusal', () => {
    expect(findSofaSetSupplierSplits([
      pick('HC-SO-2610-104', '8030-1A(LHF)', 'hookka'),
      pick('HC-SO-2610-104', '8030-1A(RHF)', 'hookka'),
      pick('HC-SO-2610-104', '8069-1A(LHF)', 'dorsett'),
      pick('HC-SO-2610-104', '8069-2A(RHF)', 'dorsett'),
    ])).toEqual({ sameModel: [], crossModel: ['HC-SO-2610-104'] });
  });

  test('one model on two suppliers is refused, and the order is not also asked to confirm', () => {
    expect(findSofaSetSupplierSplits([
      pick('HC-SO-1', '8030-1A(LHF)', 'hookka'),
      pick('HC-SO-1', '8030-1A(RHF)', 'dorsett'),
      pick('HC-SO-1', '8069-1A(LHF)', 'dorsett'),
    ])).toEqual({ sameModel: ['HC-SO-1'], crossModel: [] });
  });

  test('one supplier for the whole order needs nothing', () => {
    expect(findSofaSetSupplierSplits([
      pick('HC-SO-1', '8030-1A(LHF)', 'hookka'),
      pick('HC-SO-1', '8069-1A(LHF)', 'hookka'),
      pick('HC-SO-2', '8030-1A(LHF)', 'dorsett'),
    ])).toEqual({ sameModel: [], crossModel: [] });
  });
});
