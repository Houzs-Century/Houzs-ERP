/* A parenthesised sofa code must be findable by its full code.
 *
 * Reproduced on production 2026-08-22 (Houzs Century, Products list):
 *
 *   search          sent as            products found
 *   2376-1A         %2376-1A%          6
 *   2376-1A(        %2376-1A%          6    <- trailing, so DELETING happened to work
 *   2376-1A(RHF)    %2376-1ARHF%       0    <- the SKU exists
 *
 * escapeForOr DELETED the PostgREST `.or()` grammar characters, on the stated
 * reasoning that "`ilike` still matches via the surrounding `%...%` wildcards".
 * That only holds when the deleted character is at an END. Delete one from the
 * MIDDLE and the term stops being a substring of the stored value.
 *
 * `(LHF)` / `(RHF)` is how this catalogue spells a left- or right-hand facing
 * piece, so this was every parenthesised sofa code in every list that searches.
 *
 * The cases below assert the two halves that matter together: the pattern is
 * still SAFE inside the `.or()` grammar (no reserved character survives), and
 * it still MATCHES the code it came from. The match is checked with a real
 * SQL-LIKE evaluation rather than a restatement of the rule.
 */
import { describe, expect, it } from 'vitest';
import { escapeForOr } from './postgrest-search';

/** Evaluate `value ILIKE pattern` with SQL semantics: `%` any run, `_` exactly
 *  one character. Everything else is literal. */
function ilike(value: string, pattern: string): boolean {
  const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '[\\s\\S]*')
    .replace(/_/g, '[\\s\\S]');
  return new RegExp(`^${rx}$`, 'i').test(value);
}

const RESERVED = /[,(){}]/;

describe('escapeForOr — the pattern must be safe AND still match', () => {
  const codes = [
    '2376-1A(RHF)',      // the live case
    '2376-1A(LHF)',
    'BOOQIT-1A(LHF)',    // the example the module header always carried
    '2379-L(RHF)',
    'A,B',               // comma: the .or() separator
    'X{1}',              // braces: PostgREST array syntax
  ];

  for (const code of codes) {
    it(`finds ${code} by its full code`, () => {
      const s = escapeForOr(code);
      expect(s).not.toMatch(RESERVED);
      expect(ilike(code, `%${s}%`)).toBe(true);
    });
  }

  it('leaves an ordinary term byte-for-byte unchanged', () => {
    expect(escapeForOr('2376-1A')).toBe('2376-1A');
    expect(escapeForOr('  SOFA 2379 2NA  ')).toBe('SOFA 2379 2NA');
  });

  it('keeps a partial term working — the prefix case that always worked', () => {
    const s = escapeForOr('2376-1A');
    expect(ilike('2376-1A(RHF)', `%${s}%`)).toBe(true);
  });

  it('a trailing reserved char still matches, as it did before', () => {
    const s = escapeForOr('2376-1A(');
    expect(ilike('2376-1A(RHF)', `%${s}%`)).toBe(true);
  });

  it('preserves length, which is what makes the match possible', () => {
    expect(escapeForOr('2376-1A(RHF)')).toHaveLength('2376-1A(RHF)'.length);
  });

  it('handles null/undefined without throwing', () => {
    expect(escapeForOr(null as unknown as string)).toBe('');
    expect(escapeForOr(undefined as unknown as string)).toBe('');
  });
});
