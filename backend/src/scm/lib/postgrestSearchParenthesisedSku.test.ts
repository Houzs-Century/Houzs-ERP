import { describe, expect, it } from 'vitest';
import { escapeForOr } from './postgrest-search';

function ilike(value: string, pattern: string): boolean {
  const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '[\\s\\S]*')
    .replace(/_/g, '[\\s\\S]');
  return new RegExp(`^${rx}$`, 'i').test(value);
}

const RESERVED = /[,(){}]/;

describe('escapeForOr — the pattern must be safe AND still match', () => {
  const codes = [
    '2376-1A(RHF)',
    '2376-1A(LHF)',
    'BOOQIT-1A(LHF)',
    '2379-L(RHF)',
    'A,B',
    'X{1}',
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
