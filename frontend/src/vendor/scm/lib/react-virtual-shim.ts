// react-virtual-shim — a minimal, dependency-free stand-in for the exact slice
// of @tanstack/react-virtual that DataGrid uses (`useVirtualizer` →
// getVirtualItems / getTotalSize). The Houzs frontend does NOT have
// @tanstack/react-virtual installed and we must not run npm install, so this
// reimplements just enough to keep DataGrid.tsx byte-for-byte: it imports
// `useVirtualizer` from '@tanstack/react-virtual' (aliased to this file in
// vite.config + tsconfig paths).
//
// Behaviour parity for DataGrid's use:
//   - fixed estimateSize (DataGrid passes a constant 30px row)
//   - overscan
//   - windows the visible slice from a scroll container
//   - re-measures on scroll + resize
// DataGrid only windows FLAT lists past 25 rows; the grid renders the visible
// slice with padTop/padBottom spacer rows from start/end + getTotalSize().
import { useEffect, useRef, useState } from 'react';

export type VirtualItem = {
  index: number;
  start: number;
  end: number;
  size: number;
  key: number;
};

type VirtualizerOptions = {
  count: number;
  getScrollElement: () => HTMLElement | null;
  estimateSize: (index: number) => number;
  overscan?: number;
};

export type Virtualizer = {
  getVirtualItems: () => VirtualItem[];
  getTotalSize: () => number;
  /** Same slice of the real API DataGrid's map-pin linkage uses: scroll the
   *  container so `index` is visible (fixed row size, like everything here). */
  scrollToIndex: (index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void;
};

export function useVirtualizer(opts: VirtualizerOptions): Virtualizer {
  const { count, getScrollElement, estimateSize, overscan = 0 } = opts;
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  // Cache the per-row size (DataGrid passes a constant, so index 0 is fine).
  const sizeRef = useRef(0);
  sizeRef.current = count > 0 ? estimateSize(0) : 0;

  const scrollTopRef = useRef(0);
  const viewportRef = useRef(0);

  useEffect(() => {
    const el = getScrollElement();
    if (!el) return;
    const read = () => {
      scrollTopRef.current = el.scrollTop;
      viewportRef.current = el.clientHeight;
      rerender();
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(el);
    window.addEventListener('resize', read);
    return () => {
      el.removeEventListener('scroll', read);
      ro?.disconnect();
      window.removeEventListener('resize', read);
    };
    // getScrollElement is a stable closure in DataGrid (returns a ref); count
    // change re-runs to re-read the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const size = sizeRef.current || 1;
  const total = count * sizeRef.current;

  const getTotalSize = () => total;

  const getVirtualItems = (): VirtualItem[] => {
    if (count === 0) return [];
    const scrollTop = scrollTopRef.current;
    const viewport = viewportRef.current || size * Math.min(count, 30);
    const first = Math.max(0, Math.floor(scrollTop / size) - overscan);
    const visibleCount = Math.ceil(viewport / size) + overscan * 2;
    const last = Math.min(count - 1, first + visibleCount);
    const items: VirtualItem[] = [];
    for (let i = first; i <= last; i++) {
      const start = i * sizeRef.current;
      items.push({ index: i, start, end: start + sizeRef.current, size: sizeRef.current, key: i });
    }
    return items;
  };

  const scrollToIndex = (index: number, o?: { align?: 'start' | 'center' | 'end' | 'auto' }) => {
    const el = getScrollElement();
    if (!el || count === 0) return;
    const s = sizeRef.current || 1;
    const i = Math.max(0, Math.min(count - 1, index));
    const top = i * s;
    const align = o?.align ?? 'auto';
    let target = top;
    if (align === 'center') target = top - (el.clientHeight - s) / 2;
    else if (align === 'end') target = top - el.clientHeight + s;
    else if (align === 'auto') {
      // Already fully visible → no movement (the real library's 'auto').
      if (top >= el.scrollTop && top + s <= el.scrollTop + el.clientHeight) return;
      target = top - (el.clientHeight - s) / 2;
    }
    el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  };

  return { getVirtualItems, getTotalSize, scrollToIndex };
}
