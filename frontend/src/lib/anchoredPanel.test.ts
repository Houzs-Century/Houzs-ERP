
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  measureAnchoredPanel,
  measureFixedWidthPanel,
  useAnchoredPanel,
  useFixedWidthPanel,
  anchoredPanelStyle,
} from './anchoredPanel';

const anchor = (top: number, height = 28, left = 40, width = 200) => ({
  top,
  bottom: top + height,
  left,
  width,
});

describe('measureAnchoredPanel', () => {
  test('hangs below the anchor when the room below can hold the whole panel', () => {
    const pos = measureAnchoredPanel(anchor(100), 800, 280);
    expect(pos.top).toBe(132);
    expect(pos.bottom).toBeUndefined();
    expect(pos.maxHeight).toBe(280);
  });

  test('tracks the anchor left edge and width', () => {
    const pos = measureAnchoredPanel(anchor(100, 28, 315, 640), 800, 280);
    expect(pos.left).toBe(315);
    expect(pos.width).toBe(640);
  });

  test('flips above when below cannot hold it and above holds more', () => {
    const pos = measureAnchoredPanel(anchor(700), 800, 280);
    expect(pos.top).toBeUndefined();
    expect(pos.bottom).toBe(104);
    expect(pos.maxHeight).toBe(280);
  });

  test('stays below when neither side can hold it but below has more room', () => {
    const pos = measureAnchoredPanel(anchor(60), 200, 280);
    expect(pos.top).toBe(92);
    expect(pos.bottom).toBeUndefined();
  });

  test('clamps max-height to the room actually available, never past the cap', () => {
    const pos = measureAnchoredPanel(anchor(110), 300, 280);
    expect(pos.maxHeight).toBe(150);
  });

  test('never shrinks below the 120px floor, even in a cramped viewport', () => {
    const pos = measureAnchoredPanel(anchor(90), 200, 280);
    expect(pos.maxHeight).toBe(120);
  });

  test('the panel and its footer both end INSIDE the viewport when it opens downward', () => {
    // The owner's 2026-08-21 report, as arithmetic: the SKU picker asks for a
    // 460px list from a field 300px down a 700px window. Below (360) is less
    // than the cap but still more than above (288), so it stays put and is
    // SHORTENED — unclamped it would have ended at 792, putting the last rows
    // and the green "Add N" bar (a sticky footer INSIDE the scroller) below
    // the fold, unreachable.
    const pos = measureAnchoredPanel(anchor(300), 700, 460);
    expect(pos.top).toBe(332);
    expect(pos.maxHeight).toBe(360);
    expect(pos.top! + pos.maxHeight).toBeLessThanOrEqual(700 - 8);
  });

  test('a flipped panel ends inside the viewport at the TOP edge too', () => {
    const pos = measureAnchoredPanel(anchor(760), 800, 460);
    expect(pos.top).toBeUndefined();
    expect(pos.maxHeight).toBe(460);
    expect(800 - pos.bottom! - pos.maxHeight).toBeGreaterThanOrEqual(8);
  });

  test('picks the side with MORE room when neither side can hold the cap', () => {
    const below = measureAnchoredPanel(anchor(600), 700, 460);
    expect(below.top).toBeUndefined();
    expect(below.maxHeight).toBe(460);
    const above = measureAnchoredPanel(anchor(100), 700, 460);
    expect(above.top).toBe(132);
    expect(above.maxHeight).toBe(460);
  });

  test('honours the caller cap rather than a house default', () => {
    expect(measureAnchoredPanel(anchor(100), 800, 160).maxHeight).toBe(160);
    expect(measureAnchoredPanel(anchor(100), 800, 300).maxHeight).toBe(300);
  });
});

describe('measureFixedWidthPanel', () => {
  const viewport = { width: 1200, height: 800 };

  test('keeps the panel width the CALLER gave, not the trigger width', () => {
    const pos = measureFixedWidthPanel(anchor(100), 236, viewport, 400);
    expect(pos.width).toBe(236);
  });

  test('pulls a panel back inside the right edge', () => {
    const pos = measureFixedWidthPanel({ top: 100, bottom: 128, left: 1150 }, 236, viewport, 400);
    expect(pos.left).toBe(1200 - 236 - 8);
  });

  test('never pushes it off the LEFT edge either', () => {
    const pos = measureFixedWidthPanel({ top: 100, bottom: 128, left: -40 }, 236, viewport, 400);
    expect(pos.left).toBe(8);
  });

  test('still flips and clamps vertically like every other panel', () => {
    const pos = measureFixedWidthPanel({ top: 700, bottom: 728, left: 100 }, 236, viewport, 400);
    expect(pos.top).toBeUndefined();
    expect(pos.bottom).toBe(104);
  });
});

describe('useFixedWidthPanel', () => {
  test('returns null while there is no anchor, so the caller has one render guard', () => {
    const { result } = renderHook(() => useFixedWidthPanel(null, 236, 400));
    expect(result.current).toBeNull();
  });

  test('measures against the live window', () => {
    const { result } = renderHook(() =>
      useFixedWidthPanel({ top: 100, bottom: 128, left: 40 }, 236, 400),
    );
    expect(result.current?.top).toBe(132);
    expect(result.current?.width).toBe(236);
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

describe('anchoredPanelStyle — the unused edge is auto, never omitted', () => {
  test('flipped up: bottom is the number, top is auto', () => {
    const st = anchoredPanelStyle({ left: 295, width: 286, bottom: 376, maxHeight: 432 });
    expect(st.bottom).toBe(376);
    expect(st.top).toBe('auto');
    expect('top' in st).toBe(true);
  });

  test('dropped down: top is the number, bottom is auto', () => {
    const st = anchoredPanelStyle({ left: 295, width: 286, top: 472, maxHeight: 432 });
    expect(st.top).toBe(472);
    expect(st.bottom).toBe('auto');
    expect('bottom' in st).toBe(true);
  });

  test('never leaves either edge undefined, for any placement the measurer emits', () => {
    const rect = { top: 444, bottom: 472, left: 295, width: 286 };
    for (const viewport of [816, 600, 400, 300, 1200]) {
      const st = anchoredPanelStyle(measureAnchoredPanel(rect, viewport, 432));
      expect(st.top).toBeDefined();
      expect(st.bottom).toBeDefined();
    }
  });

  test('the exact production case is no longer over-constrained', () => {
    const pos = measureAnchoredPanel({ top: 444, bottom: 472, left: 295, width: 286 }, 816, 460);
    const st = anchoredPanelStyle(pos);
    expect(st.top).toBe('auto');
    expect(typeof st.bottom).toBe('number');
  });
});
