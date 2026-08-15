// Guards the 2026-08-15 clipping fix: the country list is portalled to <body>
// and positioned from the trigger's rect, instead of being absolutely
// positioned inside a field whose card clips its overflow. Measured on prod's
// New Sales Order before the fix: a 287px panel with 247px sliced off by
// `SalesOrderNew.module.css .card { overflow: hidden }` — the search box
// visible and not one country.
//
// WHAT THIS CANNOT PROVE. jsdom does no layout, so nothing here shows pixels
// are no longer cut — that was measured in a browser. What IS mechanically
// checkable is the property the clip depended on (the panel being a descendant
// of the clipping ancestor) and the trap the portal introduces: the
// document-level outside-click handler no longer sees the panel inside the
// component's own subtree, so without a second containment test a mousedown on
// a country closes the list before the click can pick it.
//
// Unmount is handled by the global afterEach(cleanup) in src/test-setup.ts.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { PhoneInput } from './PhoneInput';

/** The form's own clipping ancestor — the shape that caused the bug. */
function renderPhone(value = '+60123456789') {
  const emitted: string[] = [];
  const view = render(
    <div data-testid="clipper" style={{ overflow: 'hidden', height: 60 }}>
      <PhoneInput value={value} onChange={(v) => emitted.push(v)} />
    </div>,
  );
  return { ...view, emitted };
}

const trigger = () => screen.getByRole('button', { name: 'Country dial code' });
const panel = () => screen.getByRole('listbox');

describe('PhoneInput country panel placement', () => {
  test('the open list is portalled to <body>, not left inside the clipping ancestor', () => {
    renderPhone();
    fireEvent.click(trigger());

    expect(panel().parentElement).toBe(document.body);
    expect(screen.getByTestId('clipper').contains(panel())).toBe(false);
  });

  test('it is positioned fixed, so no ancestor overflow can clip it', () => {
    renderPhone();
    fireEvent.click(trigger());
    expect(panel().style.position).toBe('fixed');
  });

  test('the list scrolls inside the measured box rather than a fixed 240px', () => {
    // The outer box is clamped to the room available; the rows flex inside it,
    // so a cramped viewport shrinks the rows instead of hiding the search box.
    renderPhone();
    fireEvent.click(trigger());
    expect(panel().style.maxHeight).not.toBe('');
    expect(panel().style.display).toBe('flex');
  });

  test('closed, nothing is left in the portal', () => {
    renderPhone();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('PhoneInput behaviour the portal could have broken', () => {
  test('a mousedown inside the portalled panel does NOT close it', () => {
    // The outside-click handler tests rootRef; the panel is no longer inside
    // rootRef in the DOM, so it needs its own containment test or the pick
    // below never lands.
    renderPhone();
    fireEvent.click(trigger());
    fireEvent.mouseDown(panel());
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  test('picking a country still commits and closes', () => {
    const { emitted } = renderPhone('+60123456789');
    fireEvent.click(trigger());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'singapore' } });
    const option = screen.getAllByRole('option')[0];
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(emitted.at(-1)).toBe('+65123456789');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('a mousedown outside both the field and the panel closes it', () => {
    renderPhone();
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('Escape closes the list', () => {
    renderPhone();
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('the panel re-pins on a capture-phase scroll from a nested container', () => {
    // The field sits in a scrolling card; those scroll events never reach
    // window on the bubble path, so a bubble-only listener would let the panel
    // drift away from the trigger.
    const nested = document.createElement('div');
    document.body.appendChild(nested);
    renderPhone();
    fireEvent.click(trigger());

    const before = panel().style.top;
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({ top: 300, bottom: 328, left: 40, width: 96, height: 28, right: 136, x: 40, y: 300, toJSON: () => ({}) }) as DOMRect,
    );
    fireEvent.scroll(nested);

    expect(panel().style.top).not.toBe(before);
    expect(panel().style.top).toBe('332px');
    vi.restoreAllMocks();
    nested.remove();
  });
});
