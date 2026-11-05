// ----------------------------------------------------------------------------
// useReportRange — the date range a Finance report reads (batch 6 §4.3): it
// lives in the address (`from`, `to`, ISO), so a reload, a bookmark and the
// report list's links all carry it; the report list adds it to the report it
// opens, so the dates follow the reader from report to report. With no dates
// in the address the last range picked in this browser tab applies
// (reportPrefs, sessionStorage), else This month.
//
// An as-at report reads the range's end (`to`) as its day.
// ----------------------------------------------------------------------------

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { todayMyt } from '../../../vendor/scm/lib/dates';
import { isIsoDay, monthStart, presetRange, type RangePresetKey } from '../../../lib/dateRangePresets';
import type { ReportRange } from '../reports-catalog';
import { readSavedRange, saveRange } from './reportPrefs';

export const REPORT_DEFAULT_PRESET: RangePresetKey = 'thisMonth';

/** Where the range in use came from: the address, the tab's last pick, or the default. */
export type ReportRangeSource = 'url' | 'saved' | 'default';

const urlDay = (v: string | null): string => (v && isIsoDay(v) ? v : '');

/** The range in use: the address's, else the tab's last, else This month. */
export function resolveReportRange(params: URLSearchParams, today: string): ReportRange & { source: ReportRangeSource } {
  if (params.has('from') || params.has('to')) {
    return { from: urlDay(params.get('from')), to: urlDay(params.get('to')), source: 'url' };
  }
  const saved = readSavedRange();
  if (saved) return { ...saved, source: 'saved' };
  return { ...presetRange(REPORT_DEFAULT_PRESET, today), source: 'default' };
}

/** Both ends real days, From not after To — the only range a report reads. */
export const isUsableRange = (r: ReportRange): boolean =>
  isIsoDay(r.from) && isIsoDay(r.to) && r.from <= r.to;

export type ReportRangeState = ReportRange & {
  today: string;
  source: ReportRangeSource;
  usable: boolean;
  setRange: (from: string, to: string) => void;
  /** An as-at report's day: the range's end; From follows when it would pass it. */
  setAsAt: (day: string) => void;
};

export function useReportRange(): ReportRangeState {
  const [params, setParams] = useSearchParams();
  const today = todayMyt();
  const { from, to, source } = resolveReportRange(params, today);

  const setRange = useCallback((f: string, t: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('from', f);
      next.set('to', t);
      return next;
    }, { replace: true });
    if (isUsableRange({ from: f, to: t })) saveRange({ from: f, to: t });
  }, [setParams]);

  const setAsAt = useCallback((day: string) => {
    const f = !day ? from : from && from <= day ? from : monthStart(day);
    setRange(f, day);
  }, [from, setRange]);

  return useMemo(() => ({
    from, to, today, source, usable: isUsableRange({ from, to }), setRange, setAsAt,
  }), [from, to, today, source, setRange, setAsAt]);
}
