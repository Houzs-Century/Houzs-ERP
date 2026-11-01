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
  /** Delivery window, e.g. "13:30–15:30" (hyphen or en-dash). Null = no slot. */
  time_range?: string | null;
  so_doc_no?: string | null;
}

const BIG = Number.MAX_SAFE_INTEGER;

/**
 * Minutes-since-midnight of a delivery window's START ("13:30–15:30" → 810).
 * Tolerates a hyphen or en-dash separator and a single-time window; null when
 * the slot is absent or unparseable (those sort last).
 */
export function timeSlotStartMin(timeRange: string | null | undefined): number | null {
  if (!timeRange) return null;
  const start = timeRange.split(/[–-]/)[0]?.trim();
  if (!start) return null;
  const [h, m] = start.split(":");
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
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
