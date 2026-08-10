import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, the shared writer for both refresh sweeps
import { mergeVariantPatch, OWNED_SIZE_ONLY_KEYS } from '../scripts/lib/variant-merge.mjs';

/* Real PostgreSQL proof that a variant refresh cannot drop a key it does not
   own, and cannot corrupt the column while writing.

   The unit suite (tests/variantRefreshOwnedKeys.test.ts) pins the patch's key
   set and the SQL's shape. It cannot prove what the DATABASE does with that
   SQL, and this repo has already been burned twice by exactly that gap: a
   sweep that reported "APPLIED - stamped 146 sofa lines" three times while
   turning `variants` into an ARRAY, because a stringified value bound to a
   jsonb parameter lands a jsonb STRING scalar and `object || non-object`
   concatenates instead of merging (docs/jsonb-double-encoding-coe.md). So the
   merge is executed against a real postgres:16 and the ROW IS READ BACK.

   Skipped, not failed, without TEST_DATABASE_URL: locally there is no PG. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let admin: Sql;

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test')
    throw new Error('PG integration tests require the disposable houzs_test database');

  /* The columns the sweeps touch, plus custom_specials so the test can prove it
     is NOT touched. Both tables are created because the writer branches on the
     table name and each branch must be executed. */
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;

    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      variants jsonb,
      custom_specials jsonb,
      gap_inches int,
      divan_height_inches int,
      leg_height_inches int
    );

    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      variants jsonb,
      custom_specials jsonb,
      gap_inches int,
      divan_height_inches int,
      leg_height_inches int
    );
  `);
}

/* A row as production actually holds it: the keys a refresh owns, PLUS the keys
   it does not. `special` is the HOOKKA-compatible singular the picker reads
   beside the plural (SpecialOrders.tsx:91) and is the casualty BUG-HISTORY
   names; `specials` was landed by the money-guarded backfill; `seatHeight` was
   read out of production by probe run 31416469998. */
const EXISTING = {
  fabricId: 'OLD FABRIC',
  colourId: 'OLD COLOUR',
  size: '5x7',
  special: ['No bracket'],
  specials: ['Nylon Fabric', 'HB Straight'],
  seatHeight: '28',
  aThirteenthKeyAddedNextMonth: { anything: true, n: 13 },
};

const PATCH = {
  fabricId: 'GIRONA J9047',
  colourId: 'GIRONA J9047-01 BRUNETTE',
  fabricCode: 'GIRONA J9047-01 BRUNETTE',
  colourLabel: 'J9047-1-Brunette',
  fabricLabel: 'GIRONA J9047',
  gap: '2"',
  divanHeight: '10"',
  legHeight: '4"',
  totalHeight: '16"',
  size: '6x8',
};

/* Seeded through `admin.json(...)`, never `JSON.stringify` bound to a jsonb
   parameter — the fixture must not reproduce the very defect the assertions are
   here to rule out. */
async function seed(table: string, variants: unknown): Promise<string> {
  const v = variants === null ? null : admin.json(variants);
  const cs = admin.json(['LEAVE ME ALONE']);
  const [row] = table === 'mfg_sales_order_items'
    ? await admin`INSERT INTO scm.mfg_sales_order_items (variants, custom_specials)
                  VALUES (${v}, ${cs}) RETURNING id::text AS id`
    : await admin`INSERT INTO scm.purchase_order_items (variants, custom_specials)
                  VALUES (${v}, ${cs}) RETURNING id::text AS id`;
  return row.id as string;
}

async function readRow(table: string, id: string) {
  const [row] = await admin.unsafe(
    `SELECT variants, jsonb_typeof(variants) AS shape, custom_specials,
            gap_inches, divan_height_inches, leg_height_inches
       FROM scm.${table} WHERE id = $1::uuid`, [id]);
  return row;
}

describePg('variant merge against real PostgreSQL', () => {
  beforeAll(async () => { admin = postgres(url, { max: 2 }); });
  afterAll(async () => { if (admin) await admin.end(); });
  beforeEach(async () => { await resetFixture(admin); });

  for (const table of ['mfg_sales_order_items', 'purchase_order_items']) {
    test(`${table}: every key the patch does not name survives the write`, async () => {
      const id = await seed(table, EXISTING);
      const n = await mergeVariantPatch(admin, {
        table, id, patch: PATCH, geometry: { gap: 2, divan: 10, leg: 4 },
      });
      expect(n).toBe(1);

      const row = await readRow(table, id);
      // the column is still an OBJECT - not a string scalar, not an array
      expect(row.shape).toBe('object');

      const v = row.variants as Record<string, unknown>;
      expect(v.special).toEqual(['No bracket']);
      expect(v.specials).toEqual(['Nylon Fabric', 'HB Straight']);
      expect(v.seatHeight).toBe('28');
      expect(v.aThirteenthKeyAddedNextMonth).toEqual({ anything: true, n: 13 });

      // and the keys it owns did move
      expect(v.fabricId).toBe('GIRONA J9047');
      expect(v.colourId).toBe('GIRONA J9047-01 BRUNETTE');
      expect(v.totalHeight).toBe('16"');
      expect(v.size).toBe('6x8');

      expect(row.gap_inches).toBe(2);
      expect(row.divan_height_inches).toBe(10);
      expect(row.leg_height_inches).toBe(4);

      // custom_specials is derived and is no longer this sweep's to write
      expect(row.custom_specials).toEqual(['LEAVE ME ALONE']);
    });

    test(`${table}: a row whose variants is an ARRAY is skipped, not concatenated`, async () => {
      /* The shape #1938's repair owns. `object || array` would append rather
         than merge, so the guard must exclude the row and the caller must be
         told - never coerced, never half-written. */
      const id = await seed(table, [EXISTING, 'a stringified patch from the old bug']);
      const n = await mergeVariantPatch(admin, {
        table, id, patch: PATCH, geometry: { gap: 2, divan: 10, leg: 4 },
      });
      expect(n).toBe(0);

      const row = await readRow(table, id);
      expect(row.shape).toBe('array');
      expect((row.variants as unknown[]).length).toBe(2);
      expect(row.gap_inches).toBeNull();
    });

    test(`${table}: a NULL variants column becomes exactly the patch`, async () => {
      const id = await seed(table, null);
      expect(await mergeVariantPatch(admin, { table, id, patch: PATCH, geometry: null })).toBe(1);
      const row = await readRow(table, id);
      expect(row.shape).toBe('object');
      expect(Object.keys(row.variants as object).sort()).toEqual(Object.keys(PATCH).sort());
    });
  }

  test('the (SP) size-only write touches size and leaves the rest of the row alone', async () => {
    const id = await seed('mfg_sales_order_items', EXISTING);
    const n = await mergeVariantPatch(admin, {
      table: 'mfg_sales_order_items', id, patch: { size: '4x6' },
      geometry: null, owned: OWNED_SIZE_ONLY_KEYS,
    });
    expect(n).toBe(1);
    const row = await readRow('mfg_sales_order_items', id);
    const v = row.variants as Record<string, unknown>;
    expect(v.size).toBe('4x6');
    expect(v.fabricId).toBe('OLD FABRIC');       // untouched, unlike a rebuild
    expect(v.special).toEqual(['No bracket']);
    expect(v.specials).toEqual(['Nylon Fabric', 'HB Straight']);
    expect(row.gap_inches).toBeNull();
  });

  test('a patch carrying a key the sweep does not own is refused before it reaches SQL', async () => {
    const id = await seed('mfg_sales_order_items', EXISTING);
    await expect(mergeVariantPatch(admin, {
      table: 'mfg_sales_order_items', id, patch: { size: '4x6', specials: ['Nylon Fabric'] }, geometry: null,
    })).rejects.toThrow(/does not own: specials/);
    const row = await readRow('mfg_sales_order_items', id);
    expect((row.variants as Record<string, unknown>).size).toBe('5x7');
  });

  test('an unknown table name is refused', async () => {
    await expect(mergeVariantPatch(admin, {
      table: 'some_other_items', id: '00000000-0000-0000-0000-000000000000', patch: PATCH,
    })).rejects.toThrow(/unknown table/);
  });
});
