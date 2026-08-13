// Guards the 2026-08-13 clipping fix: the state list is portalled to <body> and
// positioned from the input's rect, instead of being absolutely positioned
// inside a field whose ancestors clip their overflow.
//
// WHAT THIS CANNOT PROVE. jsdom does no layout, so nothing here demonstrates
// pixels are no longer cut off — that was checked in a browser. What IS
// mechanically checkable is the property the clip depended on: the panel node
// being a descendant of the clipping ancestor. A node parented to <body> with
// position:fixed cannot be clipped by an overflow rule inside the form, so
// asserting the portal + the fixed geometry is the honest half of the fix.
//
// Unmount is handled by the global afterEach(cleanup) in src/test-setup.ts.
// This file must NOT clear document.body by hand — that races RTL's own portal
// node removal (see SearchableSelect.test.tsx and BUG-HISTORY).

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LocalityRow } from '../lib/localities-queries';
import { StatePicker } from './StatePicker';

const ROWS: LocalityRow[] = [
  { postcode: '80000', city: 'Johor Bahru', state: 'Johor', stateCode: 'JHR', country: 'Malaysia' },
  { postcode: '50000', city: 'Kuala Lumpur', state: 'Kuala Lumpur', stateCode: 'KUL', country: 'Malaysia' },
  { postcode: '10000', city: 'George Town', state: 'Penang', stateCode: 'PNG', country: 'Malaysia' },
  { postcode: '40000', city: 'Shah Alam', state: 'Selangor', stateCode: 'SGR', country: 'Malaysia' },
  { postcode: '510000', city: 'Foshan', state: 'Guangdong', stateCode: 'GD', country: 'China' },
  { postcode: '018956', city: 'Singapore', state: 'Singapore', stateCode: 'SG', country: 'Singapore' },
];

vi.mock('../lib/localities-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/localities-queries')>();
  return {
    ...actual,
    // The real hook is a react-query call; only `.data` / `.isLoading` are read.
    useLocalities: (() => ({ data: ROWS, isLoading: false })) as unknown as typeof actual.useLocalities,
  };
});

/** jsdom reports a zero rect for everything, so describe the input's box. */
function stubInputRect(top: number, left = 40, width = 200, height = 28) {
  const rect = {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect);
}

/** The form's own clipping ancestor — the shape that caused the bug. */
function renderPicker(props: Partial<Parameters<typeof StatePicker>[0]> = {}) {
  const picked: Array<[string, string | null]> = [];
  const view = render(
    <div data-testid="clipper" style={{ overflow: 'hidden', height: 60 }}>
      <StatePicker value="" onChange={(s, c) => picked.push([s, c])} {...props} />
    </div>,
  );
  return { ...view, picked };
}

const input = () => screen.getByRole('combobox');
const panel = () => screen.getByRole('listbox');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatePicker dropdown placement', () => {
  test('the open list is portalled to <body>, not left inside the clipping ancestor', () => {
    stubInputRect(100);
    renderPicker();
    fireEvent.focus(input());

    const list = panel();
    expect(list.parentElement).toBe(document.body);
    expect(screen.getByTestId('clipper').contains(list)).toBe(false);
    expect(list.style.position).toBe('fixed');
  });

  test('hangs under the input at the input width', () => {
    stubInputRect(100);
    renderPicker();
    fireEvent.focus(input());

    const list = panel();
    expect(list.style.top).toBe('132px'); // rect.bottom (128) + 4px gap
    expect(list.style.left).toBe('40px');
    expect(list.style.width).toBe('200px');
    expect(list.style.bottom).toBe('');
  });

  test('flips above the input when there is not enough room below', () => {
    stubInputRect(700); // bottom 728 of a 768px viewport
    renderPicker();
    fireEvent.focus(input());

    const list = panel();
    expect(list.style.top).toBe('');
    // Anchored by its bottom edge so it grows upward: innerHeight - rect.top + gap.
    expect(list.style.bottom).toBe(`${window.innerHeight - 700 + 4}px`);
  });

  test('follows the input when an ancestor scroll container scrolls', () => {
    stubInputRect(300);
    renderPicker();
    fireEvent.focus(input());
    expect(panel().style.top).toBe('332px');

    // A scroll inside the page, not on window — only a capture-phase listener
    // sees it, and that is what keeps the list glued to the field.
    stubInputRect(120);
    fireEvent.scroll(screen.getByTestId('clipper'));
    expect(panel().style.top).toBe('152px');
  });

  test('follows the input on window resize', () => {
    stubInputRect(300);
    renderPicker();
    fireEvent.focus(input());

    stubInputRect(220);
    fireEvent(window, new Event('resize'));
    expect(panel().style.top).toBe('252px');
  });

  test('drops its scroll and resize listeners when the list closes', () => {
    stubInputRect(100);
    const off = vi.spyOn(window, 'removeEventListener');
    renderPicker();
    fireEvent.focus(input());
    expect(off.mock.calls.some(([type]) => type === 'scroll')).toBe(false);

    fireEvent.blur(input());
    expect(off.mock.calls.some(([type, , opts]) => type === 'scroll' && opts === true)).toBe(true);
    expect(off.mock.calls.some(([type]) => type === 'resize')).toBe(true);
  });

  test('drops them on unmount too', () => {
    stubInputRect(100);
    const off = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderPicker();
    fireEvent.focus(input());
    unmount();
    expect(off.mock.calls.some(([type, , opts]) => type === 'scroll' && opts === true)).toBe(true);
  });
});

describe('StatePicker behaviour survives the portal', () => {
  test('mousedown picks before the input can blur, and derives the country', () => {
    stubInputRect(100);
    const { picked } = renderPicker();
    fireEvent.focus(input());

    const penang = screen.getAllByRole('option').find((o) => o.textContent === 'Penang')!;
    // preventDefault on mousedown is what stops the blur-close beating the pick.
    const prevented = !fireEvent.mouseDown(penang);
    expect(prevented).toBe(true);
    expect(picked).toEqual([['Penang', 'Malaysia']]);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('arrow keys still walk the grouped list and Enter commits', () => {
    stubInputRect(100);
    const { picked } = renderPicker();
    fireEvent.focus(input());
    // Malaysia first: Johor, Kuala Lumpur, Penang, Selangor, then China, Singapore.
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(picked).toEqual([['Kuala Lumpur', 'Malaysia']]);
  });

  test('typing filters the portalled list in place', () => {
    stubInputRect(100);
    renderPicker();
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'sela' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Selangor']);
  });

  test('blurring the input closes the portalled list', () => {
    stubInputRect(100);
    renderPicker();
    fireEvent.focus(input());
    expect(screen.queryByRole('listbox')).not.toBeNull();

    fireEvent.blur(input());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('Escape closes it', () => {
    stubInputRect(100);
    renderPicker();
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('compact (mobile) keeps the native select and portals nothing', () => {
    stubInputRect(100);
    renderPicker({ compact: true });
    expect(screen.getByRole('combobox').tagName).toBe('SELECT');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
