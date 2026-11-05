// ----------------------------------------------------------------------------
// reportPrefs — what the Finance reports remember in the browser, in one file
// (lib/browserStorageRegistry lists it as the caller and its keys):
//
//   · fin-reports-rail-pinned (localStorage) — the report list pinned open
//     ('1' / '0'), a per-device layout preference (the design's own key);
//   · fin-report-range (sessionStorage) — the last date range picked on a
//     report, so a report opened without dates in its address follows it
//     (batch 6 §4.3: the range lives in the URL; this is the fallback);
//   · fin-reports-colw-v2 (localStorage) — the statement column widths a
//     person dragged, per view (the design's own key).
//
// Every read and write is wrapped: a private window or blocked storage only
// means nothing is remembered.
// ----------------------------------------------------------------------------

import { isIsoDay } from '../../../lib/dateRangePresets';
import type { ReportRange } from '../reports-catalog';

const PINNED_KEY = 'fin-reports-rail-pinned';
const RANGE_KEY = 'fin-report-range';

export function readRailPinned(): boolean {
  try {
    return window.localStorage.getItem(PINNED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeRailPinned(on: boolean): void {
  try {
    window.localStorage.setItem(PINNED_KEY, on ? '1' : '0');
  } catch { /* nothing remembered */ }
}

/** The last range picked on a report in this browser tab, or null. */
export function readSavedRange(): ReportRange | null {
  try {
    const v: unknown = JSON.parse(window.sessionStorage.getItem(RANGE_KEY) ?? 'null');
    if (v && typeof v === 'object') {
      const { from, to } = v as Record<string, unknown>;
      if (typeof from === 'string' && typeof to === 'string' && isIsoDay(from) && isIsoDay(to) && from <= to) return { from, to };
    }
  } catch { /* a stale or unreadable value — none */ }
  return null;
}

export function saveRange(range: ReportRange): void {
  try {
    window.sessionStorage.setItem(RANGE_KEY, JSON.stringify(range));
  } catch { /* nothing remembered */ }
}

/** The statement column widths a person dragged, per view: the account
 *  column, Total, and every period column together (statementWidths). */
export type StatementWidths = Partial<Record<string, Partial<Record<'acc' | 'total' | 'period', number>>>>;

const WIDTHS_KEY = 'fin-reports-colw-v2';

export function readStatementWidths(): StatementWidths {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(WIDTHS_KEY) ?? 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: StatementWidths = {};
    for (const [view, w] of Object.entries(v as Record<string, unknown>)) {
      if (!w || typeof w !== 'object') continue;
      const keep: Partial<Record<'acc' | 'total' | 'period', number>> = {};
      for (const g of ['acc', 'total', 'period'] as const) {
        const px = (w as Record<string, unknown>)[g];
        if (typeof px === 'number' && px > 0 && px < 2000) keep[g] = Math.round(px);
      }
      if (Object.keys(keep).length > 0) out[view] = keep;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeStatementWidths(all: StatementWidths): void {
  try {
    if (Object.keys(all).length === 0) window.localStorage.removeItem(WIDTHS_KEY);
    else window.localStorage.setItem(WIDTHS_KEY, JSON.stringify(all));
  } catch { /* nothing remembered */ }
}

/** A Finance table's layout (FinanceGrid): fin-grid-v1:<table> (localStorage),
 *  its column widths, order, hidden and frozen columns. Null when none is kept. */
const GRID_KEY = 'fin-grid-v1:';
export function readGridLayout(table: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(GRID_KEY + table) ?? 'null') as unknown;
  } catch {
    return null;
  }
}
export function writeGridLayout(table: string, layout: unknown): void {
  try {
    if (layout == null) window.localStorage.removeItem(GRID_KEY + table);
    else window.localStorage.setItem(GRID_KEY + table, JSON.stringify(layout));
  } catch { /* nothing remembered */ }
}
