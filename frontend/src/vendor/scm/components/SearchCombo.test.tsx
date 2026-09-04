/* SearchCombo — where the panel opens (owner 2026-09-04: 为什么我能选的这么少
 * / 选account 时会无法看到下面的 — the panel opened DOWN unconditionally and
 * ran off the bottom of the viewport, hiding rows AND its own scrollbar).
 *
 * Pinned:
 *   1. NO ROW CAP — every hit renders into the listbox; "few options" must
 *      never be a truncation.
 *   2. Room below → opens downward at the full height (the historic shape).
 *   3. Cramped below, room above → opens UP, capped to the space above.
 *   4. Cramped on BOTH sides → the floor keeps the panel usable.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SearchCombo, type ComboOption } from './SearchCombo';

const OPTIONS: ComboOption[] = Array.from({ length: 12 }, (_, i) => ({
  value: `900-A${String(i + 1).padStart(3, '0')}`,
  label: `900-A${String(i + 1).padStart(3, '0')} · ADVERTISEMENT ${i + 1}`,
  group: 'Expenses',
}));

afterEach(() => { vi.restoreAllMocks(); });

/* Render closed, plant the input's viewport position, THEN focus — the
   measurement runs at open time. jsdom's window.innerHeight is 768. */
function openAt(top: number, bottom: number) {
  render(<SearchCombo options={OPTIONS} value="" onChange={() => {}} aria-label="Account" />);
  const input = screen.getByRole('combobox');
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top,
    toJSON: () => ({}),
  } as DOMRect);
  fireEvent.focus(input);
  return screen.getByRole('listbox');
}

describe('SearchCombo panel placement', () => {
  test('every hit renders — the list is never truncated to what happens to be visible', () => {
    const listbox = openAt(100, 130);
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(12);
  });

  test('room below → opens downward at the full 280', () => {
    const listbox = openAt(100, 130); // below = 768-130-8 = 630
    expect(listbox.style.top).toBe('100%');
    expect(listbox.style.bottom).toBe('');
    expect(listbox.style.maxHeight).toBe('280px');
  });

  test('cramped below with room above → flips UP and caps to the space above', () => {
    const listbox = openAt(600, 630); // below = 130 (< 280), above = 592
    expect(listbox.style.bottom).toBe('100%');
    expect(listbox.style.top).toBe('');
    expect(listbox.style.maxHeight).toBe('280px'); // above is plenty — full height, upward
  });

  test('cramped on BOTH sides → stays on the larger side, shrunk to what fits', () => {
    /* below < 280 AND above < below (top 100, bottom 620 — a tall widget):
       below = 768-620-8 = 140, above = 92 → stays DOWN at min(280,140). */
    const listbox = openAt(100, 620);
    expect(listbox.style.top).toBe('100%');
    expect(listbox.style.maxHeight).toBe('140px');
  });
});
