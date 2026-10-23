// ----------------------------------------------------------------------------
// delivery-date-group — the Delivery Planning board's delivery-date default sort
// and its All-view month grouping (owner follow-up 2026-10-23).
//
// One shared place for "which date is this row's delivery date" so the board's
// default ordering (earliest first) and the All tab's month buckets can never
// disagree. EFFECTIVE delivery date = amended_delivery_date (the date WE
// confirmed) ?? customer_delivery_date (the customer's original promise) —
// mirrors the server-derived effective_delivery_date and the arrangement queues'
// "new date, else original" rule (lib/arrangement-sort.ts). A row with neither
// sorts LAST and buckets into a trailing "No date" month group.
//
// Pure + shared so the host page (defaultSort) and the board (month groupValue)
// read the same key; pinned by delivery-date-group.test.ts.
// ----------------------------------------------------------------------------
import type { PlanningOrder } from './delivery-planning-queries';

/** The comparator / bucketers read only these two fields, so tests (and any
 *  future caller) can build rows without the full PlanningOrder shape. */
export type DeliveryDateRow = Pick<PlanningOrder, 'amended_delivery_date' | 'customer_delivery_date'>;

/** The row's EFFECTIVE delivery day as YYYY-MM-DD, or null when it has neither an
 *  amended nor an original customer date. Truncated to the calendar day so a
 *  stored timestamp still buckets by its date. */
export function effectiveDeliveryDay(o: DeliveryDateRow): string | null {
  const raw = o.amended_delivery_date ?? o.customer_delivery_date;
  if (raw == null) return null;
  const day = String(raw).slice(0, 10);
  return day || null;
}

/** Ascending by effective delivery day, blanks (no date) LAST. ISO YYYY-MM-DD
 *  sorts correctly as a plain string. This is the board's DEFAULT ordering —
 *  a column sort or the manual drag order still overrides it. */
export function compareByDeliveryDate(a: DeliveryDateRow, b: DeliveryDateRow): number {
  const av = effectiveDeliveryDay(a) ?? '';
  const bv = effectiveDeliveryDay(b) ?? '';
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** The row's month bucket key: 'YYYY-MM', or '' when it has no delivery date
 *  (the empty key is the trailing "No date" group, and sorts after every real
 *  month because compareByDeliveryDate puts no-date rows last). */
export function deliveryMonthKey(o: DeliveryDateRow): string {
  return effectiveDeliveryDay(o)?.slice(0, 7) ?? '';
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** The month group's banner label: 'YYYY-MM' -> 'Oct 2026'; '' -> 'No date'.
 *  Formatted from the key digits (no Date parsing) so it can't drift by
 *  timezone. An unparseable key falls back to itself. */
export function deliveryMonthLabel(key: string): string {
  if (!key) return 'No date';
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const month = Number(m[2]);
  const name = month >= 1 && month <= 12 ? MONTH_SHORT[month - 1] : m[2];
  return `${name} ${m[1]}`;
}
