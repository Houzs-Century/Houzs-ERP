import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('../src/scm/routes/delivery-zones.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../src/db/migrations-pg/20261108T0900_scm_one_all_warehouse_day_lock.sql', import.meta.url), 'utf8');

describe('one all-warehouse day lock per company and day', () => {
  it('the database refuses a second all-warehouse lock of a day', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]*\(company_id, delivery_date\)[\s\S]*WHERE warehouse_id IS NULL/);
    expect(migration).toMatch(/-- REVERSAL:/);
  });
  it('locking a day for all warehouses again updates the existing lock instead of adding one', () => {
    expect(route).toMatch(/\.is\('warehouse_id', null\)\.eq\('delivery_date', p\.deliveryDate\)/);
  });
  it('zone rules are read in a fixed order, so overlapping rules of one width resolve the same way every time', () => {
    expect(route).toMatch(/from\('delivery_zone_postcodes'\)\.select\(MAP_COLS\), c\)\.order\('id'\)\.range/);
  });
});
