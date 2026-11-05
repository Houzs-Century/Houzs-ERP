/*
 * Run-sheet ordering within one day — the tiebreak that decides a driver's stop
 * sequence once the day bucket is fixed (see MobileDeliveryPlanning's bySeq).
 *
 * Owner 2026-11-01. Trips (Time Arrangement) are not being filled in, so every
 * stop carried a null trip_stop_no and the list fell straight through to the
 * document number — a meaningless order (6:30pm stop above a 4:30pm one). The
 * fix: when no run sequence is set, order by the delivery TIME SLOT so the
 * driver sees an earliest-first list. An explicit trip_stop_no still wins when
 * it is set (a hand-arranged lorry run is the real route), and a stop with no
 * time window sinks to the end rather than jumping to the top.
 */

export interface RunStopOrder {
  /** 1-based place in the lorry run, set by Time Arrangement. Null = not on a run. */
  trip_stop_no?: number | null;
  /**
   * Delivery window as the free text the office types on the DO, e.g.
   * "TIME AROUND 1:30PM TO 3:30PM", "TIME AROUND 11AM TO 1PM". Null = no slot.
   */
  time_range?: string | null;
  so_doc_no?: string | null;
}

const BIG = Number.MAX_SAFE_INTEGER;

// Every clock time in a string: hour, optional ":mm", optional am/pm (any case).
const CLOCK_RE = /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/gi;

// One clock token → minutes since midnight. 12-hour am/pm when present
// (12AM = 00:00, 12PM = noon), else a bare 24-hour clock. Null if out of range.
function clockToMin(h: string, min: string | undefined, ap: string | undefined): number | null {
  let hh = Number(h);
  const mm = min ? Number(min) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const a = ap ? ap.toLowerCase().replace(/\./g, "") : "";
  if (a === "am") {
    if (hh === 12) hh = 0;
  } else if (a === "pm") {
    if (hh !== 12) hh += 12;
  }
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

const clockTokens = (timeRange: string | null | undefined): RegExpMatchArray[] =>
  timeRange ? [...timeRange.matchAll(CLOCK_RE)] : [];

/**
 * Minutes-since-midnight of a delivery window's START, read from the office's
 * free-text time_range ("TIME AROUND 1:30PM TO 3:30PM" → 810, "...11AM TO 1PM"
 * → 660). Takes the FIRST clock time; understands 12-hour am/pm with optional
 * minutes and a bare 24-hour "13:30". A start with no am/pm takes the end's
 * ("2-4pm" → 840) unless that would pass the end ("10-12pm" → 600). Null when no
 * time can be read.
 */
export function timeSlotStartMin(timeRange: string | null | undefined): number | null {
  const toks = clockTokens(timeRange);
  if (toks.length === 0) return null;
  const m = toks[0];
  const last = toks[toks.length - 1];
  if (!m[3] && last[3]) {
    const borrowed = clockToMin(m[1], m[2], last[3]);
    const end = clockToMin(last[1], last[2], last[3]);
    if (borrowed != null && (end == null || borrowed <= end)) return borrowed;
  }
  return clockToMin(m[1], m[2], m[3]);
}

/**
 * Minutes-since-midnight of a delivery window's END — the LAST clock time in the
 * same free-text time_range ("TIME AROUND 1:30PM TO 3:30PM" → 930). Used to tell
 * whether a stop is past its window (the "late" pill). Null when none is read.
 */
export function timeSlotEndMin(timeRange: string | null | undefined): number | null {
  const toks = clockTokens(timeRange);
  if (toks.length === 0) return null;
  const m = toks[toks.length - 1];
  return clockToMin(m[1], m[2], m[3]);
}

/**
 * Order two stops that fall on the same run day:
 *   1. explicit lorry-run sequence (trip_stop_no) when set,
 *   2. else earliest delivery time slot (untimed stops last),
 *   3. else document number, so the order is stable.
 */
export function runSheetTieBreak(a: RunStopOrder, b: RunStopOrder): number {
  const as = a.trip_stop_no ?? BIG;
  const bs = b.trip_stop_no ?? BIG;
  if (as !== bs) return as - bs;

  const at = timeSlotStartMin(a.time_range) ?? BIG;
  const bt = timeSlotStartMin(b.time_range) ?? BIG;
  if (at !== bt) return at - bt;

  return (a.so_doc_no || "").localeCompare(b.so_doc_no || "");
}
