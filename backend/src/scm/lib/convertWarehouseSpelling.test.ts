import { describe, expect, test } from 'vitest';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import convertSrc from './autocount-convert-lines.ts?raw';
import { readWarehouseCode, withLocations } from './autocount-read';
import { LOCATION_MAP } from '../../services/autocount-master-maps';

describe('the conversion header sends the book spelling of a warehouse', () => {
  const AC_LOCATION_MAX = 8;

  test('every value the map can send fits the account book column', () => {
    for (const [ours, theirs] of Object.entries(LOCATION_MAP)) {
      expect(theirs.length, `${ours} -> ${theirs} is ${theirs.length} chars`)
        .toBeLessThanOrEqual(AC_LOCATION_MAX);
    }
  });

  test('the ERP warehouse code that broke it now maps to the book code', () => {
    expect(bookSpellingOrOwn('KL WAREHOUSE', LOCATION_MAP)).toBe('KL');
    expect(bookSpellingOrOwn('PG WAREHOUSE', LOCATION_MAP)).toBe('PG');
    expect('KL WAREHOUSE'.length).toBeGreaterThan(AC_LOCATION_MAX);
  });

  test('a warehouse the map does not know still travels as its own code', () => {
    expect(bookSpellingOrOwn('SOME NEW PLACE', LOCATION_MAP)).toBe('SOME NEW PLACE');
    expect(bookSpellingOrOwn(null, LOCATION_MAP)).toBeNull();
  });

  test('the conversion composer runs the warehouse through the map', () => {
    const body = convertSrc as string;
    const line = body.split('\n').find((l) => l.includes('locationCode = '));
    expect(line, 'locationCode assignment not found').toBeTruthy();
    expect(line).toContain('bookSpellingOrOwn');
  });
});

/* ---------------------------------------------------------------------------
   THE SAME RULE ON THE PURCHASE ORDER, which the block above did NOT cover.

   `downstreamTransferFacts` (the conversion header, fixed 2026-08-25) reads
   `warehouse_id`. A purchase order does not have one — its ship-to warehouse is
   `scm.purchase_orders.purchase_location_id`, resolved by `readWarehouseCode`,
   and the per-LINE warehouse is resolved by `withLocations`. Both were still
   sending `warehouses.code` RAW, so every `PurchaseLocation` and every line
   `Location` on a purchase order was silently dropped by the same MaxLength
   rule the block above pins — measured on the host log 2026-08-25:

     set skipped: Cannot set column 'PurchaseLocation'. The value violates the
                  MaxLength limit of this column.

   Owner 2026-08-24: 「我的 PO 明明应该是 Bintang Warehouse，但去到 AutoCount
   里面它却变成了 HQ」 — the book's default, showing because nothing was written.
   ------------------------------------------------------------------------ */
describe('a purchase order sends the book spelling of its warehouse', () => {
  const sbWith = (row: { code?: string | null; name?: string | null } | null) => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
      }),
    }),
  }) as unknown as Parameters<typeof readWarehouseCode>[0];

  test('the header warehouse is mapped, not sent raw', async () => {
    expect(await readWarehouseCode(sbWith({ code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' }), 'w1'))
      .toBe('KL');
    expect(await readWarehouseCode(sbWith({ code: 'PG WAREHOUSE', name: null }), 'w2'))
      .toBe('PG');
  });

  test('a NULL code falls back to the name, and then maps', async () => {
    expect(await readWarehouseCode(sbWith({ code: null, name: 'PG WAREHOUSE' }), 'w3')).toBe('PG');
    expect(await readWarehouseCode(sbWith({ code: '  ', name: 'PG WAREHOUSE' }), 'w3b')).toBeNull();
  });

  test('an unmapped warehouse is unchanged, and no warehouse is still null', async () => {
    expect(await readWarehouseCode(sbWith({ code: 'SOME NEW PLACE', name: null }), 'w4'))
      .toBe('SOME NEW PLACE');
    expect(await readWarehouseCode(sbWith(null), 'w5')).toBeNull();
    expect(await readWarehouseCode(sbWith({ code: 'KL WAREHOUSE' }), '')).toBeNull();
  });

  test('the LINE warehouse resolver maps every code it hands back', async () => {
    const sbLines = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({
            data: [
              { id: 'w-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
              { id: 'w-pg', code: 'PG WAREHOUSE', name: null },
              { id: 'w-new', code: 'SOME NEW PLACE', name: null },
            ],
            error: null,
          }),
        }),
      }),
    } as unknown as Parameters<typeof withLocations>[0];
    const rows = [
      { warehouse_id: 'w-kl' }, { warehouse_id: 'w-pg' },
      { warehouse_id: 'w-new' }, { warehouse_id: null },
    ];
    const out = await withLocations(sbLines, rows, rows.map(() => ({}) as never));
    expect(out.map((l) => (l as { location?: string | null }).location ?? null))
      .toEqual(['KL', 'PG', 'SOME NEW PLACE', null]);
  });
});
