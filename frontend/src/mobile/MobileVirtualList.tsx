import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Windowed vertical card list for mobile screens.
 *
 * Card heights are measured individually. A prefix-offset table plus binary
 * search keeps variable-height cards reachable without assuming every card is
 * the same height as the first one. Short lists remain completely unwindowed.
 */
export function MobileVirtualList<T>({
  items,
  renderItem,
  getKey,
  estimateHeight = 88,
  threshold = 40,
  overscan = 8,
  gap = 11,
  ariaLabel,
}: {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string | number;
  estimateHeight?: number;
  threshold?: number;
  overscan?: number;
  gap?: number;
  /**
   * Accessible name for the loaded set. Say "loaded" when the caller may be
   * rendering one server page so assistive technology is not promised a
   * larger result set than this component can actually browse.
   */
  ariaLabel?: string;
}) {
  const on = items.length > threshold;
  const ref = useRef<HTMLDivElement>(null);
  const measuredByKey = useRef(new Map<string | number, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [range, setRange] = useState({ start: 0, end: threshold * 2 });
  const estimatedRowHeight = estimateHeight + gap;

  const offsets = useMemo(() => {
    const next = new Float64Array(items.length + 1);
    for (let index = 0; index < items.length; index++) {
      const key = getKey(items[index], index);
      next[index + 1] = next[index] + (measuredByKey.current.get(key) ?? estimatedRowHeight);
    }
    return next;
  }, [items, getKey, estimatedRowHeight, measurementVersion]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  const indexAtOffset = (table: Float64Array, target: number) => {
    let low = 0;
    let high = Math.max(0, table.length - 1);
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (table[mid] <= target) low = mid;
      else high = mid - 1;
    }
    return Math.min(Math.max(0, table.length - 2), low);
  };

  useLayoutEffect(() => {
    if (!on || !ref.current) return;
    const cards = [...ref.current.querySelectorAll<HTMLElement>("[data-vcard][data-vindex]")];
    const recordMeasurements = (targets: HTMLElement[]) => {
      let changed = false;
      for (const card of targets) {
        const index = Number(card.dataset.vindex);
        if (!Number.isInteger(index) || index < 0 || index >= items.length) continue;
        const height = card.offsetHeight;
        if (height <= 0) continue;
        const key = getKey(items[index], index);
        const next = height + gap;
        if (Math.abs((measuredByKey.current.get(key) ?? 0) - next) > 0.5) {
          measuredByKey.current.set(key, next);
          changed = true;
        }
      }
      if (changed) setMeasurementVersion((version) => version + 1);
    };
    recordMeasurements(cards);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      recordMeasurements(entries.map((entry) => entry.target as HTMLElement));
    });
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [on, items, getKey, gap, range.start, range.end]);

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const table = offsetsRef.current;
      const top = el.getBoundingClientRect().top;
      const visibleTop = Math.max(0, -top);
      const visibleBottom = visibleTop + window.innerHeight;
      const first = Math.max(0, indexAtOffset(table, visibleTop) - overscan);
      const last = Math.min(items.length, indexAtOffset(table, visibleBottom) + overscan + 1);
      setRange((previous) => (
        previous.start === first && previous.end === last ? previous : { start: first, end: last }
      ));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [on, items.length, overscan, measurementVersion]);

  const start = on ? range.start : 0;
  const end = on ? Math.min(items.length, range.end) : items.length;
  const topHeight = offsets[start] ?? 0;
  const bottomHeight = (offsets[items.length] ?? 0) - (offsets[end] ?? 0);

  return (
    <div
      ref={ref}
      data-mobile-virtual-list=""
      role="list"
      aria-label={
        ariaLabel ??
        `${items.length} loaded items. Only visible items are mounted; scroll to browse this loaded set.`
      }
      style={{ display: "flex", flexDirection: "column", gap }}
    >
      {on && start > 0 && <div aria-hidden style={{ height: Math.max(0, topHeight - gap) }} />}
      {items.slice(start, end).map((item, indexWithinRange) => {
        const index = start + indexWithinRange;
        return (
          <div
            data-vcard=""
            data-vindex={index}
            role="listitem"
            aria-setsize={items.length}
            aria-posinset={index + 1}
            key={getKey(item, index)}
          >
            {renderItem(item, index)}
          </div>
        );
      })}
      {on && end < items.length && (
        <div aria-hidden style={{ height: Math.max(0, bottomHeight - gap) }} />
      )}
    </div>
  );
}
