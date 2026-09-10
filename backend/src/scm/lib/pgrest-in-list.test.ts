// THE NEW SERIALISER MUST BE A NO-OP FOR EVERYTHING THAT ALREADY WORKS.
//
// `pgrestInList` replaces `.in()` at the reads that lost 38 item codes in
// production (docs/bugs/0780). Every OTHER code in those same batches was being
// read correctly, and a change that quietly moved one of them would trade a
// visible bug for an invisible one. So the parity assertion here is against the
// REAL `@supabase/postgrest-js`, not against a copy of its source: build the
// same filter both ways and compare the query strings byte for byte.
//
// The comparison uses the library through `createClient`, the same call
// `src/db/supabase.ts` makes, so a library upgrade that changes the quoting rule
// fails HERE rather than in production. That is the point of pinning parity to
// the library instead of to a literal.
import { describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { pgrestInList, parsePgrestInList } from './pgrest-in-list';

/** The `item_code=` query-string value the library builds for `.in()`. */
function libraryFilter(values: readonly string[]): string {
  let seen = '';
  const sb = createClient('http://postgrest.test', 'k', {
    global: {
      fetch: (async (input: RequestInfo | URL) => {
        seen = new URL(String(input)).searchParams.get('item_code') ?? '';
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sb.from('t').select('item_code').in('item_code', values as string[])
    .then(() => seen) as unknown as string;
}

/** Same, for the escaped payload this module builds. */
function ourFilter(values: readonly string[]): string {
  let seen = '';
  const sb = createClient('http://postgrest.test', 'k', {
    global: {
      fetch: (async (input: RequestInfo | URL) => {
        seen = new URL(String(input)).searchParams.get('item_code') ?? '';
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sb.from('t').select('item_code').filter('item_code', 'in', pgrestInList(values))
    .then(() => seen) as unknown as string;
}

/* Real item codes off company 1's catalogue, chosen to cover every branch of the
   library's quoting rule: plain, parenthesised, spaced, dotted, and one with a
   comma. NONE of them carries a `"` or a `\`, which is exactly the population
   this change must not disturb. */
const UNAFFECTED = [
  '9058-1NA',
  '9058-1A(RHF)',
  'LONG PILLOW',
  'DUNLOPILLO COOLSILK 2.0 NANO-G WINTER FLOW MATT (Q)',
  'TRION (A) (HB STR)-(Q)',
  'A,B',
];

describe('pgrestInList — parity with the library where the library is correct', () => {
  test('byte-identical to .in() for a list with no double quote and no backslash', async () => {
    const theirs = await libraryFilter(UNAFFECTED);
    const ours = await ourFilter(UNAFFECTED);
    expect(ours).toBe(theirs);
  });

  test('de-duplicates the same way .in() does, preserving first appearance', async () => {
    const dupes = ['9058-1NA', 'LONG PILLOW', '9058-1NA'];
    expect(await ourFilter(dupes)).toBe(await libraryFilter(dupes));
  });

  test('the library and this module DISAGREE only where the library is unusable', async () => {
    const withQuote = ['9058-1NA', 'DUNLOPILLO GENERASI 5" MATT (S)', '9058-1S'];
    const theirs = await libraryFilter(withQuote);
    const ours = await ourFilter(withQuote);
    expect(ours).not.toBe(theirs);
    /* What the library emits does not name the codes it was given — the third
       one is gone entirely and the second is garbled. That is the defect, stated
       as an assertion so it cannot be re-introduced by "simplifying" back. */
    expect(parsePgrestInList(theirs.slice('in.'.length)))
      .toEqual(['9058-1NA', 'DUNLOPILLO GENERASI 5 MATT (S']);
    expect(parsePgrestInList(ours.slice('in.'.length))).toEqual(withQuote);
  });
});

describe('pgrestInList / parsePgrestInList — the grammar round-trips', () => {
  test.each([
    [['plain', 'two']],
    [['has,comma']],
    [['has(paren)']],
    [['has"quote']],
    [['has\\backslash']],
    [['has"quote,and(paren)\\too']],
    [['', 'after empty']],
  ])('%j survives a write and a read', (values) => {
    expect(parsePgrestInList(pgrestInList(values))).toEqual(values);
  });

  test('an empty list is an empty list, not a list holding one empty string', () => {
    expect(pgrestInList([])).toBe('()');
    expect(parsePgrestInList('()')).toEqual([]);
  });

  test('numbers pass through unquoted, as the library sends them', () => {
    expect(pgrestInList([1, 2, 3])).toBe('(1,2,3)');
  });
});
