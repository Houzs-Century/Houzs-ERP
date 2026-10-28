import { describe, it, expect } from 'vitest';
import { dateOrNull, isDateColumn, coerceEmptyDates } from './date-coerce';

/* The vocabulary half of isDateColumn is pinned separately, in
   tests/dateCoerceColumns.test.ts — it reads the migration tree and the route
   files off disk, which needs node types this project's tsconfig does not
   carry. Keep the pure assertions here. */

describe('dateOrNull', () => {
  it('turns a blank date into null, never into a date', () => {
    expect(dateOrNull('')).toBeNull();
    expect(dateOrNull('   ')).toBeNull();
    expect(dateOrNull(null)).toBeNull();
    expect(dateOrNull(undefined)).toBeNull();
  });

  it('passes a real date through, trimmed', () => {
    expect(dateOrNull('2026-08-17')).toBe('2026-08-17');
    expect(dateOrNull(' 2026-08-17 ')).toBe('2026-08-17');
  });

  /* The `?? todayMyt()` sites: a blank must fall down the SAME path an absent
     key falls down, so a NOT NULL document date still gets its default. */
  it('lets a caller default a blank the way it defaults an absent key', () => {
    expect(dateOrNull('') ?? '2026-08-17').toBe('2026-08-17');
    expect(dateOrNull(undefined) ?? '2026-08-17').toBe('2026-08-17');
  });
});

describe('coerceEmptyDates', () => {
  /* The production 500: PATCH /api/scm/mfg-purchase-orders/<id> with
     supplierDeliveryDate2/3/4 sent as "" answered
     invalid input syntax for type date: "". Null is what the column accepts. */
  it('nulls a blank date column instead of sending "" to Postgres', () => {
    expect(coerceEmptyDates({
      supplier_delivery_date_2: '',
      supplier_delivery_date_3: '',
      supplier_delivery_date_4: '',
    })).toEqual({
      supplier_delivery_date_2: null,
      supplier_delivery_date_3: null,
      supplier_delivery_date_4: null,
    });
  });

  it('leaves an absent column absent — a field nobody sent stays untouched', () => {
    const row: Record<string, unknown> = { notes: 'x' };
    coerceEmptyDates(row);
    expect('po_date' in row).toBe(false);
  });

  it('leaves a real date, and a null, exactly as they were', () => {
    expect(coerceEmptyDates({ po_date: '2026-08-17', expected_at: null }))
      .toEqual({ po_date: '2026-08-17', expected_at: null });
  });

  it('does not touch a non-date column that legitimately stores an empty string', () => {
    expect(coerceEmptyDates({ notes: '', ref: '' })).toEqual({ notes: '', ref: '' });
  });

  it('does not touch a non-string value on a date column', () => {
    expect(coerceEmptyDates({ po_date: 0 })).toEqual({ po_date: 0 });
  });
});

describe('isDateColumn', () => {
  it('recognises the shapes the field maps carry', () => {
    for (const col of [
      'po_date', 'supplier_delivery_date_2', 'amend_date_from_customer',
      'expected_at', 'received_at', 'customer_birthday', 'road_tax_expiry',
    ]) expect(isDateColumn(col)).toBe(true);
  });

  it('leaves ordinary text columns alone', () => {
    for (const col of ['notes', 'ref', 'transfer_to', 'debtor_name', 'venue'])
      expect(isDateColumn(col)).toBe(false);
  });

  it('a _pattern column is a recipe for finding a date, never a date', () => {
    /* 0336's trading_date_pattern is a regex whose capture group is the
       trading day; coercing or gating it as a date is a category error the
       dateWriteCoercion gate made loudly on 2026-09-02. */
    expect(isDateColumn('trading_date_pattern')).toBe(false);
    expect(isDateColumn('some_date_pattern')).toBe(false);
    /* And the suffix rule must not eat a real date column. */
    expect(isDateColumn('trading_date')).toBe(true);
  });
});
