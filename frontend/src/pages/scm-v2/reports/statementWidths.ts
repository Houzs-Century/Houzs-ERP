
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { readStatementWidths, writeStatementWidths, type StatementWidths } from './reportPrefs';

export type WidthGroup = 'acc' | 'total' | 'period';

/** The narrowest a dragged column gets, in px — never so narrow a figure is cut. */
export const MIN_WIDTH: Record<WidthGroup, number> = { acc: 140, total: 96, period: 96 };
const MAX_WIDTH = 720;

export function useStatementWidths(view: string) {
  const [all, setAll] = useState<StatementWidths>(readStatementWidths);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    writeStatementWidths(all);
  }, [all]);

  const mine = all[view] ?? {};
  const set = useCallback((group: WidthGroup, px: number | null) => setAll((prev) => {
    const cur = { ...(prev[view] ?? {}) };
    if (px === null) delete cur[group]; else cur[group] = px;
    const next = { ...prev };
    if (Object.keys(cur).length === 0) delete next[view]; else next[view] = cur;
    return next;
  }), [view]);

  const startResize = (group: WidthGroup, e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    const cell = e.currentTarget.parentElement;
    const startW = cell ? cell.getBoundingClientRect().width : (mine[group] ?? MIN_WIDTH[group]);
    const startX = e.clientX;
    const before = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      set(group, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH[group], Math.round(startW + ev.clientX - startX))));
    };
    const onUp = () => {
      document.body.style.userSelect = before;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return {
    widths: mine as Partial<Record<WidthGroup, number>>,
    custom: Object.keys(mine).length > 0,
    startResize,
    reset: (group: WidthGroup) => set(group, null),
    resetAll: () => setAll((prev) => {
      const next = { ...prev };
      delete next[view];
      return next;
    }),
  };
}
