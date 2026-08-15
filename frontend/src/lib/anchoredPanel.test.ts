// Geometry for the shared floating-panel placement (lib/anchoredPanel.ts).
//
// WHAT THIS CANNOT PROVE. jsdom does no layout, so nothing here shows pixels
// are no longer sliced off by a card's overflow — that was measured in a
// browser against prod. What IS mechanically checkable is the arithmetic the
// browser fix rests on: the flip, the clamp, the floor, and the listener
// lifecycle. Same split the StatePicker suite documents.

import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { measureAnchoredPanel, useAnchoredPanel, anchoredPanelStyle } from './anchoredPanel';

const anchor = (top: number, height = 28, left = 40, width = 200) => ({
  top,
  bottom: top + height,
  left,
  width,
});

describe('measureAnchoredPanel', () => {
  test('hangs below the anchor when the room below can hold the whole panel', () => {
    const pos = measureAnchoredPanel(anchor(100), 800, 280);
    expect(pos.top).toBe(132); // anchor.bottom (128) + 4px gap
    expect(pos.bottom).toBeUndefined();
    expect(pos.maxHeight).toBe(280);
  });

  test('tracks the anchor left edge and width', () => {
    const pos = measureAnchoredPanel(anchor(100, 28, 315, 640), 800, 280);
    expect(pos.left).toBe(315);
    expect(pos.width).toBe(640);
  });

  test('flips above when below cannot hold it and above holds more', () => {
    // 700px down a 800px viewport: 60px below, 688px above.
    const pos = measureAnchoredPanel(anchor(700), 800, 280);
    expect(pos.top).toBeUndefined();
    expect(pos.bottom).toBe(104); // 800 - anchor.top (700) + 4px gap
    expect(pos.maxHeight).toBe(280);
  });

  test('stays below when neither side can hold it but below has more room', () => {
    // A 200px viewport with the anchor at 60: 108px below, 48px above.
    const pos = measureAnchoredPanel(anchor(60), 200, 280);
    expect(pos.top).toBe(92);
    expect(pos.bottom).toBeUndefined();
  });

  test('clamps max-height to the room actually available, never past the cap', () => {
    // 150px below a 300px viewport with a 280px cap.
    const pos = measureAnchoredPanel(anchor(110), 300, 280);
    expect(pos.maxHeight).toBe(150);
  });

  test('never shrinks below the 120px floor, even in a cramped viewport', () => {
    // A 200px viewport with the anchor at 90: 70px below, 78px above. Both are
    // under the floor, so the panel deliberately overhangs rather than opening
    // as a two-row sliver nobody can use.
    const pos = measureAnchoredPanel(anchor(90), 200, 280);
    expect(pos.maxHeight).toBe(120);
  });

  test('honours the caller cap rather than a house default', () => {
    // The cap is the list's own design — a two-row menu must not open ten rows
    // tall just because the state picker does.
    expect(measureAnchoredPanel(anchor(100), 800, 160).maxHeight).toBe(160);
    expect(measureAnchoredPanel(anchor(100), 800, 300).maxHeight).toBe(300);
  });
});

describe('anchoredPanelStyle', () => {
  test('is fixed and above the drawer backdrops these forms sit in', () => {
    const style = anchoredPanelStyle(measureAnchoredPanel(anchor(100), 800, 280));
    expect(style.position).toBe('fixed');
    expect(style.zIndex).toBe(1000);
  });

  test('leaves scrolling and paint to the caller', () => {
    const style = anchoredPanelStyle(measureAnchoredPanel(anchor(100), 800, 280));
    expect(style).not.toHaveProperty('overflowY');
    expect(style).not.toHaveProperty('background');
  });
});

describe('useAnchoredPanel', () => {
  const stubAnchor = (top: number) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ top, bottom: top + 28, left: 40, width: 200, height: 28, right: 240, x: 40, y: top, toJSON: () => ({}) }) as DOMRect;
    return { current: el };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns null while closed, so the caller has one render guard', () => {
    const { result } = renderHook(() => useAnchoredPanel(stubAnchor(100), false, 280));
    expect(result.current).toBeNull();
  });

  test('measures on open', () => {
    const { result } = renderHook(() => useAnchoredPanel(stubAnchor(100), true, 280));
    expect(result.current?.top).toBe(132);
  });

  test('re-measures on a CAPTURE-phase scroll from a nested container', () => {
    // The trigger sits inside a scrolling card, and those scroll events never
    // reach window on the bubble path — a bubble-only listener sees nothing and
    // the panel detaches from the field.
    const ref = stubAnchor(100);
    const nested = document.createElement('div');
    document.body.appendChild(nested);
    const { result } = renderHook(() => useAnchoredPanel(ref, true, 280));
    expect(result.current?.top).toBe(132);

    ref.current.getBoundingClientRect = () =>
      ({ top: 300, bottom: 328, left: 40, width: 200, height: 28, right: 240, x: 40, y: 300, toJSON: () => ({}) }) as DOMRect;
    act(() => {
      nested.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(result.current?.top).toBe(332);
    nested.remove();
  });

  test('re-measures on resize', () => {
    const ref = stubAnchor(100);
    const { result } = renderHook(() => useAnchoredPanel(ref, true, 280));
    ref.current.getBoundingClientRect = () =>
      ({ top: 200, bottom: 228, left: 40, width: 200, height: 28, right: 240, x: 40, y: 200, toJSON: () => ({}) }) as DOMRect;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current?.top).toBe(232);
  });

  test('keeps the SAME object when a scroll did not move the anchor', () => {
    // Otherwise every one of the dozens of events in a scroll gesture
    // re-renders the picker, and a caller with an unstable ref spins forever.
    const ref = stubAnchor(100);
    const { result } = renderHook(() => useAnchoredPanel(ref, true, 280));
    const first = result.current;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current).toBe(first);
  });

  test('survives a caller whose ref identity changes on every render', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ top: 100, bottom: 128, left: 40, width: 200, height: 28, right: 240, x: 40, y: 100, toJSON: () => ({}) }) as DOMRect;
    const { result } = renderHook(() => useAnchoredPanel({ current: el }, true, 280));
    expect(result.current?.top).toBe(132);
  });

  test('drops both listeners when the panel closes', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { rerender } = renderHook(({ open }) => useAnchoredPanel(stubAnchor(100), open, 280), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    const removed = remove.mock.calls.map((c) => c[0]);
    expect(removed).toContain('scroll');
    expect(removed).toContain('resize');
  });

  test('drops both listeners on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useAnchoredPanel(stubAnchor(100), true, 280));
    unmount();
    const removed = remove.mock.calls.map((c) => c[0]);
    expect(removed).toContain('scroll');
    expect(removed).toContain('resize');
  });
});
