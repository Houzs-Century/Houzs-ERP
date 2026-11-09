import { mytDayOf, mytDayOfValue } from "../vendor/scm/lib/dates";

/* The fixed highlight rules every list shares (owner 2026-09-25): a date that
   has passed while the document is still open reads red; money still owed on
   an order already delivered reads amber. Written in code, not configurable,
   so the same state looks the same on every list. */

export const OVERDUE_CLASS = "font-semibold text-err";
export const OWING_CLASS = "font-semibold text-warning-text";

/** Today as yyyy-mm-dd on the Malaysian calendar, whatever zone the device is in. */
export function todayIso(now: Date = new Date()): string {
  return mytDayOf(now.toISOString()) ?? "";
}

/** A date strictly before today on a document that is still open. A timestamp is
 *  judged by the Malaysian day it falls on, not its UTC date. */
export function isPastDue(date: string | null | undefined, open: boolean, today: string = todayIso()): boolean {
  if (!open || !date) return false;
  const day = mytDayOfValue(date);
  return day != null && day < today;
}

/** Delivered in full yet not fully paid. */
export function isDeliveredOwing(balanceSen: number | null | undefined, deliveryState: string | null | undefined): boolean {
  return deliveryState === "full" && (balanceSen ?? 0) > 0;
}
