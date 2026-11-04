import { describe, expect, it } from 'vitest';
import { printedText } from './scan-gr-check';

describe('printedText', () => {
  it('shortens the Dorsettloft row to what the paper says about the goods', () => {
    expect(printedText({ itemCode: 'DSL 8075(28")-2+1', description: 'DSL 8075(28") -2+1 COL:M2402-4-EZ002 SAND *2+1 *FABRIC B *LEG 6.5" *2990-SO-2609-045 *****' }))
      .toBe('DSL 8075(28") -2+1 COL:M2402-4-EZ002 SAND *2+1 *FABRIC B *LEG 6.5"');
  });
  it('keeps a code the description does not start with', () => {
    expect(printedText({ itemCode: 'T1MAMJA0MK', description: 'Mattress Akemi' })).toBe('T1MAMJA0MK · Mattress Akemi');
  });
  it('a code alone stands alone', () => {
    expect(printedText({ itemCode: 'A1', description: null })).toBe('A1');
  });
});
