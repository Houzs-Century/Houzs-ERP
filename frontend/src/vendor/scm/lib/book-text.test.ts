// Regression test for stripBookText — the migrated AutoCount "账本原文" book
// text must be hidden on customer-facing PDFs, and genuine remark text must be
// left untouched. See book-text.ts.
import { describe, expect, test } from 'vitest';
import { stripBookText } from './book-text';

describe('stripBookText', () => {
  test('a pure book-text remark is hidden', () => {
    expect(stripBookText('账本原文: (2+L)30inch/Col: *Back Rest change 8030')).toBe('');
    expect(stripBookText('账本原文: tbc')).toBe('');
    // no colon, no space — still the same internal marker
    expect(stripBookText('账本原文tbc')).toBe('');
  });

  test('a normal customer remark is untouched', () => {
    expect(stripBookText('Deliver Monday morning')).toBe('Deliver Monday morning');
    // a genuinely multi-line note keeps all of its lines
    expect(stripBookText('Line one\nLine two')).toBe('Line one\nLine two');
  });

  test('a mixed remark keeps the genuine text and drops only the book text', () => {
    // book text on its own line (how the migration stamps it)
    expect(stripBookText('Deliver Monday\n账本原文: tbc')).toBe('Deliver Monday');
    // genuine text before the marker on the same line survives
    expect(stripBookText('Fragile 账本原文: (2+L)30inch')).toBe('Fragile');
    // book text between two genuine lines
    expect(stripBookText('Top note\n账本原文: x\nBottom note')).toBe('Top note\nBottom note');
  });

  test('null / undefined / empty return empty string', () => {
    expect(stripBookText(null)).toBe('');
    expect(stripBookText(undefined)).toBe('');
    expect(stripBookText('')).toBe('');
    expect(stripBookText('   ')).toBe('');
  });
});
