import { describe, expect, test } from 'vitest';
import { printedSize } from './scan-word-match';

describe('the size a row prints', () => {
  test('W and L in front of the numbers (ERGOTEX)', () => {
    expect(printedSize('ERGOTEX FLEXICARE-S MATT - W152 X L190 X H30CM')).toBe('Q');
    expect(printedSize('ERGOTEX FLEXICARE-S MATT - W107 X L190 X H30CM')).toBe('SS');
    expect(printedSize('ERGOTEX SPINECARE-C MATT - W183 X L190 X H35.5CM')).toBe('K');
  });
  test('the spellings it read before still read', () => {
    expect(printedSize('DUN CS2 PURE BREEZE MAT 190X152X30CM')).toBe('Q');
    expect(printedSize('FABRIC 3 DIVAN BED SEATER:6 FTS')).toBe('K');
  });
});
