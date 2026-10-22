/* postgrest-js `.in()` quotes a value holding `,()` but leaves a double quote
   inside it unescaped, so `GENERASI 5" MATT (S)` closed the quoted value early
   and the rest of its batch matched nothing - 233 open order lines missing from
   the Procurement dead-stock demand (2026-10-19). `inList` escapes it. */
import { describe, expect, test } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
import { inList } from '../src/scm/lib/paginate-all';

const CODES = ['DUNLOPILLO GENERASI 5" MATT (S)', 'CELENE 2.0 (A)(F)-(Q)', 'PLAIN', 'BACK\\SLASH'];

describe('inList', () => {
  test('every value quoted; a double quote and a backslash inside are escaped', () => {
    expect(inList(CODES)).toBe('("DUNLOPILLO GENERASI 5\\" MATT (S)","CELENE 2.0 (A)(F)-(Q)","PLAIN","BACK\\\\SLASH")');
  });

  test('postgrest-js .in() leaves the inner quote bare; .filter(col, "in", inList(...)) does not', () => {
    const c = new PostgrestClient('http://x/rest/v1');
    const bare = decodeURIComponent(c.from('t').select('id').in('item_code', CODES).url.search);
    expect(bare).toContain('"DUNLOPILLO+GENERASI+5"+MATT');
    const safe = decodeURIComponent(c.from('t').select('id').filter('item_code', 'in', inList(CODES)).url.search);
    expect(safe).toContain('5\\"+MATT');
  });
});
