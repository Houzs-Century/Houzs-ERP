/* SearchCombo — where the panel lives and opens.
 *
 * Round 1 (owner 2026-09-04: 为什么我能选的这么少 / 选account 时会无法看到
 * 下面的): viewport-aware flip was added — and 还是一样, because the real
 * clipper was the form CARD's overflow:hidden, not the viewport. The panel
 * now portals to document.body and positions fixed off the input's rect, so
 * no ancestor can cut it.
 *
 * Pinned:
 *   1. NO ROW CAP — every hit renders; "few options" must only ever mean
 *      few matches.
 *   2. THE PANEL IS A BODY PORTAL — its parent is document.body, which is
 *      what makes an overflow:hidden ancestor (the .card) unable to clip it.
 *   3. Room below → fixed panel under the input at full height.
 *   4. Cramped below with room above → opens ABOVE the input.
 *   5. Cramped on BOTH sides → stays on the larger side, shrunk to fit.
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

/* Render closed (inside an overflow:hidden wrapper, like the PV line card),
   plant the input's viewport position, THEN focus — the measurement runs at
   open time. jsdom's window.innerHeight is 768. */
function openAt(top: number, bottom: number) {
  render(
    <div style={{ overflow: 'hidden', height: 40 }}>
      <SearchCombo options={OPTIONS} value="" onChange={() => {}} aria-label="Account" />
    </div>,
  );
  const input = screen.getByRole('combobox');
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    top, bottom, left: 40, right: 240, width: 200, height: bottom - top, x: 40, y: top,
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

  test('the panel is a BODY portal — an overflow:hidden card cannot clip it', () => {
    const listbox = openAt(100, 130);
    expect(listbox.parentElement).toBe(document.body);
    expect(listbox.style.position).toBe('fixed');
    expect(listbox.style.left).toBe('40px');
    expect(listbox.style.width).toBe('200px');
  });

  test('room below → sits under the input at the full 280', () => {
    const listbox = openAt(100, 130); // below = 768-130-8 = 630
    expect(listbox.style.top).toBe('132px'); // input bottom + 2
    expect(listbox.style.bottom).toBe('');
    expect(listbox.style.maxHeight).toBe('280px');
  });

  test('cramped below with room above → opens ABOVE the input', () => {
    const listbox = openAt(600, 630); // below = 130 (< 280), above = 592
    expect(listbox.style.bottom).toBe('170px'); // 768 - input top + 2
    expect(listbox.style.top).toBe('');
    expect(listbox.style.maxHeight).toBe('280px');
  });

  test('cramped on BOTH sides → stays on the larger side, shrunk to what fits', () => {
    /* below < 280 AND above < below (top 100, bottom 620 — a tall widget):
       below = 768-620-8 = 140, above = 92 → stays BELOW at min(280,140). */
    const listbox = openAt(100, 620);
    expect(listbox.style.top).toBe('622px');
    expect(listbox.style.maxHeight).toBe('140px');
  });
});
