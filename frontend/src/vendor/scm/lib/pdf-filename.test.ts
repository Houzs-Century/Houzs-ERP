// The document filename is customer-facing: it is what lands in Downloads, what
// gets attached to a mail, and (via the named preview tab) what the browser
// suggests on Save. It used to be scrubbed to `[A-Za-z0-9_-]`, which turned a
// Chinese customer into a row of underscores on the file sent to that customer.
// These pin the replacement so nobody "tidies" the regex back.
import { describe, expect, test } from 'vitest';
import { safeName } from './pdf-common';

describe('safeName', () => {
  test('keeps a non-Latin name intact', () => {
    expect(safeName('家具世界')).toBe('家具世界');
    expect(safeName('佛山市南海区宜家家具')).toBe('佛山市南海区宜家家具');
  });

  test('keeps ordinary Latin punctuation a business name really has', () => {
    expect(safeName('Ali & Sons Sdn. Bhd.')).toBe('Ali & Sons Sdn. Bhd.');
    expect(safeName("O'Brien (KL)")).toBe("O'Brien (KL)");
  });

  test('strips only what a filesystem refuses', () => {
    expect(safeName('A/B\\C')).toBe('A B C');
    expect(safeName('Inv: "2990" <draft>')).toBe('Inv 2990 draft');
    expect(safeName('what?*')).toBe('what');
  });

  test('never returns something a path can break on', () => {
    // Trailing space: Windows silently drops it. A trailing dot is fine — the
    // caller appends ".pdf" — and keeping it is what saves "Sdn. Bhd.".
    expect(safeName('Foo   ')).toBe('Foo');
    expect(safeName('  ')).toBe('doc');
    expect(safeName('')).toBe('doc');
    expect(safeName('///')).toBe('doc');
  });

  test('truncates without leaving a dangling separator', () => {
    const long = 'Kuala Lumpur Furniture Trading Company Limited';
    const cut = safeName(long, 20);
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut).not.toMatch(/[\s-]$/);
  });

  test('a doc number passes through unchanged', () => {
    // Guards the range-vs-list mistake: `[ -<...]` would eat digits and hyphens.
    expect(safeName('2990-DO-2608-006')).toBe('2990-DO-2608-006');
    expect(safeName('PO-2606-001_R2')).toBe('PO-2606-001_R2');
  });
});
