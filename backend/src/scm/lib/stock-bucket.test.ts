/* Which closing stock a warehouse's goods belong to (owner 2026-09-21).
   Pinned: the type's default, the row's override first, an unknown row as
   customer. */
import { describe, expect, it } from 'vitest';
import { STOCK_BUCKETS, emptyBuckets, isStockBucket, stockBucketOf } from './stock-bucket';

describe('stockBucketOf', () => {
  it('reads the type by default: warehouse and others are customer stock, showroom and display are display stock, service is service stock', () => {
    expect(stockBucketOf({ type: 'warehouse' })).toBe('customer');
    expect(stockBucketOf({ type: 'others' })).toBe('customer');
    expect(stockBucketOf({ type: 'showroom' })).toBe('display');
    expect(stockBucketOf({ type: 'display' })).toBe('display');
    expect(stockBucketOf({ type: 'service' })).toBe('service');
  });

  it('the override wins over the type; a blank or unknown override falls back; no row at all is customer', () => {
    expect(stockBucketOf({ type: 'display', stock_bucket: 'customer' })).toBe('customer'); // the Cash & Carry segment
    expect(stockBucketOf({ type: 'warehouse', stock_bucket: 'display' })).toBe('display');
    expect(stockBucketOf({ type: 'showroom', stock_bucket: '' })).toBe('display');
    expect(stockBucketOf({ type: 'showroom', stock_bucket: 'nonsense' })).toBe('display');
    expect(stockBucketOf(null)).toBe('customer');
    expect(stockBucketOf({ type: null })).toBe('customer');
  });

  it('knows its three names and an empty split', () => {
    expect(STOCK_BUCKETS).toEqual(['customer', 'display', 'service']);
    expect(isStockBucket('display')).toBe(true);
    expect(isStockBucket('DISPLAY')).toBe(false);
    expect(emptyBuckets()).toEqual({ customer: 0, display: 0, service: 0 });
  });
});
