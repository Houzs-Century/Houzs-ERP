// ----------------------------------------------------------------------------
// part-time-pay.ts — what a part-time salesperson is paid for an event (owner
// 2026-10-14): 2% of their sales at that event (nothing when they sold nothing),
// RM 120 for each day they logged into the POS, and one RM 20 WiFi allowance per
// event. The rates live in HR Settings (hr_commission_config); this file is the
// arithmetic and the day count, pure, so a test can reach every rule. The route
// is routes/hr-part-time-pay.ts.
//
// Days come from the POS logins (scm.pos_logins) — one day per Malaysian
// calendar day with a login inside the event's period — and the first login of
// the day is the arrival time the owner asked to see. A day the salesperson
// sold something on without a login that day (the tablet stayed signed in) is
// counted too, and marked, so the owner sees why the count is what it is.
// ----------------------------------------------------------------------------

import { mytDateOf } from './my-time';

export type PartTimeRates = {
  /** 2% is 200. */
  commissionBps: number;
  dayRateSen: number;
  wifiSen: number;
};

export type LoginMark = { at: string; outAt: string | null };

export type WorkDay = {
  /** The Malaysian calendar day, YYYY-MM-DD. */
  date: string;
  /** The first POS login that day — the arrival time — or null when the day
      counts from a sale alone. */
  firstLoginAt: string | null;
  lastLogoutAt: string | null;
  logins: number;
  orders: number;
};

export type EventPeriod = { startDate: string | null; endDate: string | null };

const inPeriod = (ymd: string, p: EventPeriod): boolean =>
  (p.startDate == null || ymd >= p.startDate) && (p.endDate == null || ymd <= p.endDate);

/** The days one salesperson worked an event, from their POS logins and their
    orders' dates, inside the event's period (end inclusive; an open end runs
    on). Sorted by date. */
export function workDays(logins: ReadonlyArray<LoginMark>, orderDates: ReadonlyArray<string>, period: EventPeriod): WorkDay[] {
  const days = new Map<string, WorkDay>();
  const dayOf = (date: string): WorkDay => {
    let d = days.get(date);
    if (!d) {
      d = { date, firstLoginAt: null, lastLogoutAt: null, logins: 0, orders: 0 };
      days.set(date, d);
    }
    return d;
  };
  for (const l of logins) {
    if (!l.at || Number.isNaN(Date.parse(l.at))) continue;
    const date = mytDateOf(l.at);
    if (!inPeriod(date, period)) continue;
    const d = dayOf(date);
    d.logins += 1;
    if (d.firstLoginAt == null || Date.parse(l.at) < Date.parse(d.firstLoginAt)) d.firstLoginAt = l.at;
    if (l.outAt && !Number.isNaN(Date.parse(l.outAt)) && (d.lastLogoutAt == null || Date.parse(l.outAt) > Date.parse(d.lastLogoutAt))) d.lastLogoutAt = l.outAt;
  }
  for (const raw of orderDates) {
    const date = String(raw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inPeriod(date, period)) continue;
    dayOf(date).orders += 1;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type PartTimeAmounts = { commissionSen: number; salarySen: number; wifiSen: number; totalSen: number };

/** The money, in sen. Commission rounds half up to the sen; zero (or negative)
    sales earn no commission at all, as the owner ruled. */
export function partTimeAmounts(input: { days: number; salesSen: number; wifi: boolean; rates: PartTimeRates }): PartTimeAmounts {
  const days = Number.isInteger(input.days) && input.days > 0 ? input.days : 0;
  const sales = Number.isFinite(input.salesSen) && input.salesSen > 0 ? Math.round(input.salesSen) : 0;
  const commissionSen = sales > 0 ? Math.round((sales * input.rates.commissionBps) / 10_000) : 0;
  const salarySen = days * input.rates.dayRateSen;
  const wifiSen = input.wifi ? input.rates.wifiSen : 0;
  return { commissionSen, salarySen, wifiSen, totalSen: commissionSen + salarySen + wifiSen };
}

const rm = (sen: number): string => `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** The purpose line Finance reads and the receipt prints: the event's title and
    dates, as the project carries them. */
export function partTimePurpose(event: { name: string; startDate: string | null; endDate: string | null }): string {
  const when = event.startDate && event.endDate && event.endDate !== event.startDate
    ? `${event.startDate} to ${event.endDate}`
    : (event.startDate ?? event.endDate ?? '');
  return `Part-time sales — ${event.name}${when ? ` (${when})` : ''}`;
}

/** The breakdown, one line, for the request's note and the sheet. */
export function partTimeBreakdown(row: {
  days: number; dayRateSen: number; salesSen: number; commissionBps: number; commissionSen: number; wifiSen: number; totalSen: number;
}): string {
  const parts = [
    `${row.days} day${row.days === 1 ? '' : 's'} × ${rm(row.dayRateSen)} = ${rm(row.days * row.dayRateSen)}`,
    row.salesSen > 0
      ? `sales ${rm(row.salesSen)} × ${pct(row.commissionBps)} = ${rm(row.commissionSen)}`
      : 'no sales, no commission',
  ];
  if (row.wifiSen > 0) parts.push(`WiFi ${rm(row.wifiSen)}`);
  return `${parts.join('; ')}. Total ${rm(row.totalSen)}.`;
}
