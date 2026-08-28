import { describe, expect, test } from 'vitest';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
/* `?raw`, NOT node:fs / require — backend/tsconfig.json types Workers only, so
   either one typechecks red even though vitest runs them fine. */
import convertSrc from './autocount-convert-lines.ts?raw';
import { readWarehouseCode, withLocations } from './autocount-read';
import { LOCATION_MAP } from '../../services/autocount-master-maps';

/* ---------------------------------------------------------------------------
   THE WAREHOUSE A CONVERSION SENDS MUST BE THE BOOK'S SPELLING.

   Measured on the host's own log, 2026-08-25, on a PO -> GR carrying
   KL WAREHOUSE:

     set skipped: Cannot set column 'Location'. The value violates the
                  MaxLength limit of this column.

   AutoCount SKIPS the assignment and saves the document anyway. The goods
   received landed in a licensed book with no warehouse on it, and nothing said
   so — not the outbox row, not the page, not the ERP log. A silent wrong answer
   is worse than a refusal, which is why this is pinned rather than left to the
   next reader to rediscover from a Windows log file.
   ------------------------------------------------------------------------ */
describe('the conversion header sends the book spelling of a warehouse', () => {
  const AC_LOCATION_MAX = 8;

  test('every value the map can send fits the account book column', () => {
    /* The ceiling is not typed here from a manual; it is READ OFF the map,
       which is the book's own set of location codes. If someone adds a longer
       one this fails, which is the moment to check the column rather than the
       moment a document silently loses its warehouse. */
    for (const [ours, theirs] of Object.entries(LOCATION_MAP)) {
      expect(theirs.length, `${ours} -> ${theirs} is ${theirs.length} chars`)
        .toBeLessThanOrEqual(AC_LOCATION_MAX);
    }
  });

  test('the ERP warehouse code that broke it now maps to the book code', () => {
    /* `warehouses.code` on production really is the long form — the owner's own
       list reads CODE: KL WAREHOUSE / NAME: BALAKONG WAREHOUSE. */
    expect(bookSpellingOrOwn('KL WAREHOUSE', LOCATION_MAP)).toBe('KL');
    expect(bookSpellingOrOwn('PG WAREHOUSE', LOCATION_MAP)).toBe('PG');
    expect('KL WAREHOUSE'.length).toBeGreaterThan(AC_LOCATION_MAX);
  });

  test('a warehouse the map does not know still travels as its own code', () => {
    /* UNCHANGED BEHAVIOUR, and deliberately so: inventing a book spelling for a
       warehouse nobody has mapped would put a location in the account book that
       nobody chose. The mapped ones are fixed; the rest keep the old answer. */
    expect(bookSpellingOrOwn('SOME NEW PLACE', LOCATION_MAP)).toBe('SOME NEW PLACE');
    expect(bookSpellingOrOwn(null, LOCATION_MAP)).toBeNull();
  });

  test('the conversion composer runs the warehouse through the map', () => {
    /* Asserted on the SOURCE, because the composer needs a Supabase client and
       a warehouse row to run, and what matters is that it cannot go back to
       sending the raw code without this failing. */
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
  /** The one `warehouses` read `readWarehouseCode` makes, with a canned row. */
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
    /* `??`, so only a NULL code falls back — a blank one is a blank answer, not
       a missing one. That is the contract `withLocations` already had and this
       function already matched; the mapping is added AFTER the fallback, so
       neither side's answer to "which warehouse" changes, only its spelling. */
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
    /* `withLocations` moved next to `readWarehouseCode` in this change, which is
       what makes it reachable from a test at all — it used to be private to the
       outbox. One `in` query, so the fake answers with the whole set. */
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
