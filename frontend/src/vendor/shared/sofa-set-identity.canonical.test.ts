import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { findSofaSetSupplierSplits } from './sofa-set-identity';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/sofa-set-identity.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/sofa-set-identity.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/sofa-set-identity.ts');
    const normalize = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const backendCopy = normalize(there);
    expect(backendCopy.length).toBeGreaterThan(500);
    expect(backendCopy).toBe(normalize(here));
  });

  test('the copy answers the gate\'s question, not a stub', () => {
    expect(findSofaSetSupplierSplits([
      { soDocNo: 'SO-1', itemCode: '8030-1A(LHF)', supplierId: 'hookka' },
      { soDocNo: 'SO-1', itemCode: '8069-1A(LHF)', supplierId: 'dorsett' },
    ])).toEqual({ sameModel: [], crossModel: ['SO-1'] });
  });
});
