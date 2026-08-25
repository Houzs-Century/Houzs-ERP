import { describe, expect, test } from 'vitest';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
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
    const src = new URL('./autocount-convert-lines.ts', import.meta.url).pathname;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const body: string = require('node:fs').readFileSync(src, 'utf8');
    const line = body.split('\n').find((l) => l.includes('locationCode = '));
    expect(line, 'locationCode assignment not found').toBeTruthy();
    expect(line).toContain('bookSpellingOrOwn');
  });
});
