// ----------------------------------------------------------------------------
// reportPrefs — what the Finance reports remember in the browser, in one file
// (lib/browserStorageRegistry lists it as the caller and its keys):
//
//   · fin-reports-rail-pinned (localStorage) — the report list pinned open
//     ('1' / '0'), a per-device layout preference (the design's own key);
//   · fin-report-range (sessionStorage) — the last date range picked on a
//     report, so a report opened without dates in its address follows it
//     (batch 6 §4.3: the range lives in the URL; this is the fallback).
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
