/* The fixed highlight rules every list shares (owner 2026-09-25): a date that
   has passed while the document is still open reads red; money still owed on
   an order already delivered reads amber. Written in code, not configurable,
   so the same state looks the same on every list. */

export const OVERDUE_CLASS = "font-semibold text-err";
export const OWING_CLASS = "font-semibold text-warning-text";

/** Today as yyyy-mm-dd in the user's own timezone (the dates compared are
 *  calendar dates, not instants). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** A date strictly before today on a document that is still open. */
export function isPastDue(date: string | null | undefined, open: boolean, today: string = todayIso()): boolean {
  return open && !!date && date.slice(0, 10) < today;
}

/** Delivered in full yet not fully paid. */
export function isDeliveredOwing(balanceSen: number | null | undefined, deliveryState: string | null | undefined): boolean {
  return deliveryState === "full" && (balanceSen ?? 0) > 0;
}
