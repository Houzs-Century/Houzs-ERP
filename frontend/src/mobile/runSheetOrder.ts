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

/**
 * Minutes-since-midnight of a delivery window's START, read from the office's
 * free-text time_range ("TIME AROUND 1:30PM TO 3:30PM" → 810, "...11AM TO 1PM"
 * → 660). It takes the FIRST clock time in the string, understands 12-hour
 * am/pm with optional minutes, and also accepts a bare 24-hour "13:30". Null
 * when no time can be read (those stops sort last).
 */
export function timeSlotStartMin(timeRange: string | null | undefined): number | null {
  if (!timeRange) return null;
  // First clock token: hour, optional ":mm", optional am/pm (any spacing/case).
  const m = timeRange.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const ap = m[3] ? m[3].toLowerCase().replace(/\./g, "") : "";
  if (ap === "am") {
    if (hh === 12) hh = 0; // 12AM = midnight
  } else if (ap === "pm") {
    if (hh !== 12) hh += 12; // 12PM = noon stays 12
  }
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
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
