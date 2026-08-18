// ─────────────────────────────────────────────────────────────────────────
// my-time.ts — Malaysia (Asia/Kuala_Lumpur, UTC+8, no DST) calendar-period
// → UTC-instant bounds, shared by GET /pos/sales-stats and
// GET /mfg-sales-orders/mine so their period math can never drift.
//
// Workers run in UTC. "This month in MY" means the window from the 1st of the
// MY month at MY-midnight to the 1st of the next MY month — expressed as UTC
// instants by shifting the MY wall-clock back 8 hours. A date range from the
// POS calendar is treated the same way: the `to` day is INCLUSIVE, so its
// exclusive upper bound is the MY-midnight of the following day.
// ─────────────────────────────────────────────────────────────────────────

import { fmtDate } from '../shared/format';

const MY_OFFSET_MS = 8 * 60 * 60 * 1000;
const MY_TZ = 'Asia/Kuala_Lumpur';

/**
 * Today's calendar date in Malaysia (UTC+8, no DST) as `YYYY-MM-DD`.
 *
 * Workers run in UTC, so `new Date().toISOString().slice(0, 10)` is the UTC
 * calendar date — before 08:00 MYT that is YESTERDAY, so every document-date
 * default (do_date, invoice_date, received_at, entry_date, …) was stamped a
 * day early each morning and effective-dated pricing flipped a day off. Shift
 * the clock forward 8h, then read the UTC date — that IS the MY calendar date,
 * independent of the server's own timezone. Backend mirror of the frontend
 * `todayMyt()` in `vendor/scm/lib/dates.ts`.
 *
 * Optional `offsetDays` shifts the result (e.g. `todayMyt(-365)` = a year ago).
 */
export function todayMyt(offsetDays = 0): string {
  return new Date(Date.now() + MY_OFFSET_MS + offsetDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The Malaysia (UTC+8) calendar date of a given instant, as `YYYY-MM-DD`.
 *
 * A UTC timestamp (e.g. a row's `created_at`) shifted +8h then read as a UTC
 * date IS the Malaysian wall-clock day it happened on. Use this — not the raw
 * UTC date slice — whenever a "same MY calendar day" comparison is needed
 * (e.g. `mytDateOf(row.created_at) === todayMyt()`), so a row created at
 * 23:30 UTC (07:30 MYT next day) isn't mis-bucketed a day behind.
 */
export function mytDateOf(instant: string | number | Date): string {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return new Date(t + MY_OFFSET_MS).toISOString().slice(0, 10);
}

export interface PeriodBounds {
  /** Inclusive lower bound as a UTC ISO instant, or null = open (no lower bound). */
  startUtc: string | null;
  /** Exclusive upper bound as a UTC ISO instant, or null = open (no upper bound). */
  endUtc: string | null;
  /** Human label for the KPI cards, e.g. "June 2026" or "1 Jun – 15 Jun 2026". */
  label: string;
}

/** The UTC instant of MY-midnight on the given MY calendar day. */
function myMidnightUtc(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day, 0, 0, 0) - MY_OFFSET_MS);
}

/** Parse a strict `YYYY-MM-DD` into MY calendar parts, or null when malformed. */
export function parseYmd(ymd: string): { y: number; m0: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (m0 < 0 || m0 > 11 || d < 1 || d > 31) return null;
  return { y, m0, d };
}

/** Whole-calendar-month window in MY → UTC bounds + a "Month YYYY" label. */
export function monthBoundsMy(year: number, month0: number): PeriodBounds {
  const startUtc = myMidnightUtc(year, month0, 1);
  const endUtc = myMidnightUtc(year, month0 + 1, 1);
  return {
    startUtc: startUtc.toISOString(),
    endUtc: endUtc.toISOString(),
    label: new Intl.DateTimeFormat('en-MY', {
      month: 'long',
      year: 'numeric',
      timeZone: MY_TZ,
    }).format(startUtc),
  };
}

/* Was `{ day: 'numeric', month: 'short' }` — "16 Aug 2026", a month NAME in a
   filter label sitting next to DD/MM/YYYY everywhere else on the same screen. */
const fmtDay = fmtDate;

/**
 * From–to date range (MY calendar days, `to` inclusive) → UTC bounds.
 * Either bound may be omitted for an open-ended window. When the range covers
 * exactly one whole calendar month it collapses to that month's label.
 */
export function rangeBoundsMy(
  fromYmd?: string | null,
  toYmd?: string | null,
): PeriodBounds {
  const from = fromYmd ? parseYmd(fromYmd) : null;
  const to = toYmd ? parseYmd(toYmd) : null;

  const startUtc = from ? myMidnightUtc(from.y, from.m0, from.d) : null;
  // `to` is inclusive → exclusive bound is the next MY day's midnight.
  const endUtc = to ? myMidnightUtc(to.y, to.m0, to.d + 1) : null;

  let label: string;
  if (from && to) {
    const lastOfFromMonth = new Date(Date.UTC(from.y, from.m0 + 1, 0)).getUTCDate();
    const wholeMonth =
      from.d === 1 &&
      to.y === from.y &&
      to.m0 === from.m0 &&
      to.d === lastOfFromMonth;
    label = wholeMonth
      ? monthBoundsMy(from.y, from.m0).label
      : `${fmtDay(startUtc!)} – ${fmtDay(myMidnightUtc(to.y, to.m0, to.d))}`;
  } else if (from) {
    label = `From ${fmtDay(startUtc!)}`;
  } else if (to) {
    label = `Until ${fmtDay(myMidnightUtc(to.y, to.m0, to.d))}`;
  } else {
    label = 'All dates';
  }

  return {
    startUtc: startUtc ? startUtc.toISOString() : null,
    endUtc: endUtc ? endUtc.toISOString() : null,
    label,
  };
}
