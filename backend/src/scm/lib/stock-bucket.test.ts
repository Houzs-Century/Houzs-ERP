/* Which closing stock a warehouse's goods belong to (owner 2026-09-21;
   2026-09-30: showroom and others their own, showroom 和 display 分开).
   Pinned: the type's default, the row's override first, an unknown row as
   customer. */
import { describe, expect, it } from 'vitest';
import { STOCK_BUCKETS, emptyBuckets, isStockBucket, stockBucketOf } from './stock-bucket';

describe('stockBucketOf', () => {
  it('reads the type by default: each type its own bucket, warehouse as customer stock', () => {
    expect(stockBucketOf({ type: 'warehouse' })).toBe('customer');
    expect(stockBucketOf({ type: 'display' })).toBe('display');
    expect(stockBucketOf({ type: 'service' })).toBe('service');
    expect(stockBucketOf({ type: 'showroom' })).toBe('showroom');
    expect(stockBucketOf({ type: 'others' })).toBe('others');
  });

  it('the override wins over the type; a blank or unknown override falls back; no row at all is customer', () => {
    expect(stockBucketOf({ type: 'display', stock_bucket: 'customer' })).toBe('customer'); // the Cash & Carry segment
    expect(stockBucketOf({ type: 'others', stock_bucket: 'customer' })).toBe('customer'); // the Cash & Carry K.J
    expect(stockBucketOf({ type: 'warehouse', stock_bucket: 'display' })).toBe('display');
    expect(stockBucketOf({ type: 'warehouse', stock_bucket: 'showroom' })).toBe('showroom');
    expect(stockBucketOf({ type: 'warehouse', stock_bucket: 'others' })).toBe('others');
    expect(stockBucketOf({ type: 'showroom', stock_bucket: '' })).toBe('showroom');
    expect(stockBucketOf({ type: 'showroom', stock_bucket: 'nonsense' })).toBe('showroom');
    expect(stockBucketOf(null)).toBe('customer');
    expect(stockBucketOf({ type: null })).toBe('customer');
  });

  it('knows its five names, in account-code order, and an empty split', () => {
    expect(STOCK_BUCKETS).toEqual(['customer', 'display', 'service', 'showroom', 'others']);
    expect(isStockBucket('showroom')).toBe(true);
    expect(isStockBucket('DISPLAY')).toBe(false);
    expect(emptyBuckets()).toEqual({ customer: 0, display: 0, service: 0, showroom: 0, others: 0 });
  });
});
