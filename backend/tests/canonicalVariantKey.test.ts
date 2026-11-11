// Canonical bucket identity (PR #5609 follow-up): for a company that tracks
// stock by variant, one physical spec is one stock bucket, however a line
// spelled it. Company 2 drift on the #5609 check: a sofa DO line's
// `legheight=default`, a bedframe line's derived `totalheight`. Company 1 binds
// lines to their PO and keeps its keys exactly as before (binding-mode.ts).
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalVariantKey, computeVariantKey, pickStockBucketKey, sameVariantBucket,
} from '../src/scm/shared/variant-key';
import {
  foldTargetsIntoOwnBuckets, groupBuckets, loadOwnBucketKeys, ownBucketKey, ownBucketKeyMap,
  resolveIncreaseKeys, stockBucketKeyFor, stockBucketKeyResolver,
} from '../src/scm/lib/stock-bucket-key';
import { HARD_BOUND_COMPANY_ID, variantTrackedCompany } from '../src/scm/lib/binding-mode';
import { adoptSoLineSpecs, adoptSoSpec } from '../src/scm/lib/do-so-spec';

const canon = (group: string, attrs: Record<string, unknown>) => canonicalVariantKey(computeVariantKey(group, attrs));

describe('canonical equality', () => {
  test('computeVariantKey itself is unchanged: the total still enters the written key', () => {
    expect(computeVariantKey('bedframe', { fabricCode: 'BF-16', gap: '4"', legHeight: '2"', totalHeight: '6"' }))
      .toBe('fabriccode=bf-16|gap=4"|legheight=2"|totalheight=6"');
    expect(computeVariantKey('sofa', { fabricCode: 'BO315-23', seatHeight: '35', legHeight: 'Default' }))
      .toBe('fabriccode=bo315-23|seatheight=35|legheight=default');
  });

  test('totalheight present or absent is the same bucket when divan, leg or gap is set', () => {
    const parts = { fabricCode: 'BF-16', gap: '4"', divanHeight: '10"', legHeight: '2"' };
    expect(canon('bedframe', { ...parts, totalHeight: '16"' })).toBe(canon('bedframe', parts));
    expect(sameVariantBucket('fabriccode=bf-16|gap=4"|divanheight=10"|legheight=2"|totalheight=16"', 'fabriccode=bf-16|gap=4"|divanheight=10"|legheight=2"')).toBe(true);
  });

  test('a total-only bedframe keeps its total', () => {
    expect(canonicalVariantKey('fabriccode=bf-16|totalheight=24"')).toBe('fabriccode=bf16|totalheight=24');
    expect(sameVariantBucket('fabriccode=bf-16|totalheight=24"', 'fabriccode=bf-16')).toBe(false);
  });

  test('legheight=default and other placeholders count as absent', () => {
    expect(sameVariantBucket('fabriccode=bo315-23|seatheight=35|legheight=default', 'fabriccode=bo315-23|seatheight=35')).toBe(true);
    expect(sameVariantBucket('fabriccode=bo315-23|seatheight=35|legheight=n/a', 'fabriccode=bo315-23|seatheight=35')).toBe(true);
  });

  test('inch marks, inch words, spaces and hyphens do not split a bucket', () => {
    expect(sameVariantBucket('fabriccode=bf-16|legheight=6"', 'fabriccode=bf16|legheight=6 inch')).toBe(true);
    expect(sameVariantBucket('fabriccode=bf 16|legheight=6\'\'', 'fabriccode=BF-16|legheight=6')).toBe(true);
    expect(sameVariantBucket('fabriccode=bf-16|legheight=6”', 'fabriccode=bf-16|legheight=6in')).toBe(true);
    expect(canonicalVariantKey('legheight=6"|fabriccode=BF-16')).toBe('fabriccode=bf16|legheight=6');
  });

  test('aliases already fold in computeVariantKey, so they compare equal', () => {
    const main = canon('sofa', { fabricCode: 'BO315-23', seatHeight: '35', legHeight: '6"' });
    expect(canon('sofa', { colourCode: 'BO315-23', depth: '35', sofaLegHeight: '6"' })).toBe(main);
    expect(canon('sofa', { fabricColor: 'BO315-23', seatHeight: '35 inch', sofaLegHeight: '6 in' })).toBe(main);
  });

  test('specials are order-independent', () => {
    expect(sameVariantBucket('special=b,A', 'special=a,B')).toBe(true);
  });

  test('a different fabric stays a different bucket', () => {
    expect(sameVariantBucket('fabriccode=bo315-23|seatheight=35', 'fabriccode=bo315-31|seatheight=35')).toBe(false);
    expect(sameVariantBucket('fabriccode=pc151-01', 'fabriccode=pc151-02')).toBe(false);
    expect(sameVariantBucket('fabriccode=bf-16|legheight=2"', 'fabriccode=bf-16|legheight=4"')).toBe(false);
  });

  test('canonicalVariantKey is idempotent', () => {
    const k = 'fabriccode=Bo315-23|seatheight=35 inch|legheight=default|special=b,A';
    expect(canonicalVariantKey(canonicalVariantKey(k))).toBe(canonicalVariantKey(k));
  });
});

describe('a company-2 write lands in the stocked bucket', () => {
  test('an exact bucket is kept (reversals stay exact)', () => {
    expect(pickStockBucketKey('a=1', [{ variantKey: 'a=1', qty: 0 }, { variantKey: 'a=1"', qty: 9 }])).toBe('a=1');
  });

  test('a canonically equal bucket wins, the fullest first; none -> the computed key', () => {
    expect(pickStockBucketKey('legheight=2', [{ variantKey: 'legheight=2"', qty: 1 }, { variantKey: 'legheight=2 inch', qty: 3 }])).toBe('legheight=2 inch');
    expect(pickStockBucketKey('legheight=4', [{ variantKey: 'legheight=2"', qty: 1 }])).toBe('legheight=4');
  });

  test('replay: a sofa DO line carrying legheight=default ships from the bucket the GRN stocked', () => {
    const stocked = 'fabriccode=bo315-23|seatheight=35';
    const buckets = groupBuckets([{ warehouse_id: 'wh-kl', item_code: '8030-2A(LHF)', variant_key: stocked, qty: 1 }]);
    const doLine = {
      item_code: '8030-2A(LHF)', item_group: 'others', warehouse_id: 'wh-kl',
      variants: { fabricCode: 'BO315-23', seatHeight: '35', legHeight: 'Default' },
    };
    // The SKU says sofa; the line's own group would have keyed it to ''.
    expect(stockBucketKeyFor(doLine, new Map([['8030-2A(LHF)', 'sofa']]), buckets)).toBe(stocked);
  });

  test('a bedframe line carrying the derived total ships from the bucket stocked without it', () => {
    const stocked = 'fabriccode=bf-16|gap=4"|divanheight=10"|legheight=2"';
    const buckets = groupBuckets([{ warehouse_id: 'w', item_code: 'BF1', variant_key: stocked, qty: 2 }]);
    const line = { item_code: 'BF1', item_group: 'bedframe', warehouse_id: 'w', variants: { fabricCode: 'BF-16', gap: '4"', divanHeight: '10"', legHeight: '2"', totalHeight: '16"' } };
    expect(stockBucketKeyFor(line, new Map(), buckets)).toBe(stocked);
  });

  test('no canonically equal bucket: the key is exactly computeVariantKey (a new bucket looks like every old one)', () => {
    const line = { item_code: 'BF1', item_group: 'bedframe', warehouse_id: 'w', variants: { fabricCode: 'BF-16', gap: '4"', totalHeight: '4"' } };
    expect(stockBucketKeyFor(line, new Map(), new Map())).toBe('fabriccode=bf-16|gap=4"|totalheight=4"');
  });

  test('a reversal finds the document\'s own bucket under its old spelling', () => {
    const own = ownBucketKeyMap([{ item_code: 'BF1', variant_key: 'fabriccode=bf-16|legheight=2"|totalheight=12"' }]);
    expect(ownBucketKey(own, 'BF1', 'fabriccode=bf-16|legheight=2"')).toBe('fabriccode=bf-16|legheight=2"|totalheight=12"');
    expect(ownBucketKey(null, 'BF1', 'x=1')).toBe('x=1');
  });

  test('a resync target equal to a bucket the DO already moved is that bucket (no re-book)', () => {
    const targets = new Map([['w::BF1::fabriccode=bf-16|legheight=2"::', { variant_key: 'fabriccode=bf-16|legheight=2"', qty: 3 }]]);
    foldTargetsIntoOwnBuckets(targets, ['w::BF1::fabriccode=bf-16|legheight=2"|totalheight=12"::'], 2);
    expect([...targets.keys()]).toEqual(['w::BF1::fabriccode=bf-16|legheight=2"|totalheight=12"::']);
    expect(targets.get('w::BF1::fabriccode=bf-16|legheight=2"|totalheight=12"::')).toEqual({ variant_key: 'fabriccode=bf-16|legheight=2"|totalheight=12"', qty: 3 });
  });
});

describe('company 1 (hard-bound to PO) keeps the exact legacy key', () => {
  const noReads = { from() { throw new Error('company 1 must not read anything for its key'); } };

  test('the switch is the hard-bound company constant', () => {
    expect(HARD_BOUND_COMPANY_ID).toBe(1);
    expect(variantTrackedCompany(1)).toBe(false);
    expect(variantTrackedCompany(null)).toBe(false);
    expect(variantTrackedCompany(2)).toBe(true);
  });

  test('the writer key is computeVariantKey(line.item_group, variants): no product read, no bucket lookup', async () => {
    const line = { item_code: 'CODY-(K)', item_group: 'bedframe', warehouse_id: 'wh-hq', variants: { fabricCode: 'BF-01', gap: '12"', divanHeight: '8"', legHeight: '4"', totalHeight: '24"' } };
    const keyOf = await stockBucketKeyResolver(noReads, 1, [line]);
    expect(keyOf(line)).toBe(computeVariantKey('bedframe', line.variants));
    const sofa = { item_code: 'X', item_group: 'others', warehouse_id: 'wh-hq', variants: { fabricCode: 'A', legHeight: 'Default' } };
    expect(keyOf(sofa)).toBe(''); // the line's own group, not the SKU's
  });

  test('no own-bucket remap, no resync fold, no adjustment re-point', async () => {
    expect(await loadOwnBucketKeys(noReads, 'GRN', 'g1', 'IN', 1)).toBeNull();
    const targets = new Map([['w::BF1::a=1::', { variant_key: 'a=1', qty: 1 }]]);
    foldTargetsIntoOwnBuckets(targets, ['w::BF1::a=1"::'], 1);
    expect([...targets.keys()]).toEqual(['w::BF1::a=1::']);
    const lines = [{ item_code: 'BF1', item_group: 'bedframe', variants: {}, variant_key: 'legheight=2"', qty: 1 }];
    await resolveIncreaseKeys(noReads, 1, 'w', lines);
    expect(lines[0]!.variant_key).toBe('legheight=2"');
  });
});

describe('DO line from an SO line takes the SO spec (company 2)', () => {
  const soVariants = { fabricCode: 'BO315-23', seatHeight: '35' };

  test('spec fields come from the SO line; other DO keys stay', () => {
    expect(adoptSoSpec({ fabricCode: 'BO315-23', seatHeight: '35', legHeight: 'Default', totalHeight: '24"', remark: 'x' }, soVariants))
      .toEqual({ remark: 'x', fabricCode: 'BO315-23', seatHeight: '35' });
  });

  test('create: a linked line is rewritten from the SO line read on the server', async () => {
    const reads: Array<{ table: string; filters: string[] }> = [];
    const sb = {
      from(table: string) {
        const rec = { table, filters: [] as string[] };
        reads.push(rec);
        const q = {
          select: () => q,
          in: (col: string) => { rec.filters.push(col); return q; },
          eq: (col: string) => { rec.filters.push(col); return q; },
          then: (r: (v: unknown) => unknown) => r({ data: [{ id: 'so-1', item_code: '8030-2A(LHF)', variants: soVariants }], error: null }),
        };
        return q;
      },
    };
    const out = await adoptSoLineSpecs(sb, [
      { soItemId: 'so-1', itemCode: '8030-2A(LHF)', variants: { ...soVariants, legHeight: 'Default' } },
      { soItemId: null, itemCode: 'FREE', variants: { legHeight: 'Default' } },
      { soItemId: 'so-1', itemCode: 'OTHER-CODE', variants: { fabricCode: 'Z' } },
    ], 2);
    expect(out[0]!.variants).toEqual(soVariants);
    expect(out[1]!.variants).toEqual({ legHeight: 'Default' });
    expect(out[2]!.variants).toEqual({ fabricCode: 'Z' }); // a substituted code keeps its own spec
    expect(reads[0]!.table).toBe('mfg_sales_order_items');
    expect(reads[0]!.filters).toContain('company_id');
    expect(computeVariantKey('sofa', out[0]!.variants as Record<string, string>)).toBe('fabriccode=bo315-23|seatheight=35');
  });

  test('the DO routes adopt the SO spec only for a variant-tracked company', () => {
    const route = readFileSync(join(__dirname, '../src/scm/routes/delivery-orders-mfg.ts'), 'utf8');
    const sites = route.split('adoptSoLineSpecs(sb').length - 1;
    expect(sites).toBe(3);
    expect(route.split('if (variantTrackedCompany(activeCompanyId(c) ?? null)) {').length - 1).toBe(2);
    expect(route).toMatch(/prev\.so_item_id && variantTrackedCompany\(co\.companyId\)/);
  });
});

test('backend and frontend copies of variant-key.ts are byte-identical', () => {
  const norm = (p: string) => readFileSync(join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
  expect(norm('../../frontend/src/vendor/shared/variant-key.ts')).toBe(norm('../src/scm/shared/variant-key.ts'));
});
