import { describe, expect, it } from 'vitest';
import { parseMergeBody, MERGE_PERMISSION } from './mfg-product-merge';
import { PERMISSIONS } from '../../services/permissions';

describe('merge product codes request', () => {
  it('turns one kept code and the picked codes into pairs', () => {
    expect(parseMergeBody({ keep: ' A ', drops: ['B', ' C'] })).toEqual({
      ok: true, pairs: [{ drop: 'B', keep: 'A' }, { drop: 'C', keep: 'A' }],
    });
  });

  it('refuses a request that cannot be planned', () => {
    expect(parseMergeBody({ drops: ['B'] }).ok).toBe(false);
    expect(parseMergeBody({ keep: 'A', drops: [] }).ok).toBe(false);
    expect(parseMergeBody({ keep: 'A', drops: ['B', 'B'] }).ok).toBe(false);
    expect(parseMergeBody({ keep: 'A', drops: Array.from({ length: 21 }, (_, i) => `X${i}`) }).ok).toBe(false);
    expect(parseMergeBody(null).ok).toBe(false);
  });

  it('gates on a declared permission, so it can be granted in Team > Positions', () => {
    expect(PERMISSIONS.some((p) => p.key === MERGE_PERMISSION)).toBe(true);
  });
});
