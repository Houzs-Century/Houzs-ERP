import productsSrc from './mfg-products.ts?raw';
import mergeRoute from './mfg-product-merge.ts?raw';
import mergeRun from '../../../scripts/lib/duplicate-sku-merge-run.mjs?raw';
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

describe('merge router mount order', () => {
  it('mounts after supabaseAuth, which is the only thing that sets houzsUser for the permission gate', () => {
    expect(productsSrc.indexOf("mfgProducts.use('*', supabaseAuth)")).toBeGreaterThan(-1);
    expect(productsSrc.indexOf("mfgProducts.use('*', supabaseAuth)")).toBeLessThan(productsSrc.indexOf("mfgProducts.route('/merge'"));
  });
});

describe('merge queries on the Worker client', () => {
  // The Worker's postgres client has fetch_types off (db/pg.ts), so a JS array bound as a parameter reaches
  // Postgres as the text "a,b" and the plan call 500s. Arrays go in as JSON text cast to jsonb.
  it('binds no raw array to ANY()', () => {
    expect(/ANY\(\$\{(?!JSON)/.test(mergeRun)).toBe(false);
    expect(/ANY\(\$\{(?!JSON)/.test(mergeRoute)).toBe(false);
  });
});
