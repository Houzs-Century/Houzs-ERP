/* do-header-lock.ts — WHICH Delivery Order header fields freeze once the next
 * document exists, in ONE place that the server and both screens read.
 *
 * OWNER RULING 2026-09-14, verbatim: 「我的 Sales Invoice 开了，正常上游的单就锁了」
 * and 「无论怎么样 convert，它最后一个 step 基本上就是可以被 edit 的，他被下一个流程
 * lock 住了」. Once a live (non-cancelled) Sales Invoice or Delivery Return exists on
 * a DO, the DO's customer, address, contact and commercial fields are LOCKED.
 *
 * THIS SUPERSEDES the 2026-08-20 field-level decision (§8 GAP-1, "越松越好"), which
 * froze only customer / currency / sales location / branding and left the
 * addresses, phone, dates and notes editable after invoicing.
 *
 * WHAT STAYS EDITABLE, AND WHY. Only what happens AFTER invoicing in real life —
 * getting the goods to the customer:
 *   - driver / vehicle (a crew is reassigned on the day),
 *   - the delivery-execution times the Delivery Planning board and the driver's
 *     "Mark arrived" button write (time window, arrival, departure, shipout,
 *     customer-delivered date, port ETA, sub-status, arrives-at-warehouse),
 *   - the EXPECTED delivery date — our dispatch plan, which moves when a lorry
 *     is rescheduled. The customer's own delivery date is LOCKED.
 * The SALESPERSON is LOCKED too. Asked on 2026-09-14 whether the 2026-08-17
 * hand-over ruling kept it open on an invoiced DO, the owner answered
 * 「下游开了 上游就locked了啊」: the next document locks the whole header.
 * Status moves and proof of delivery are separate endpoints and never read this.
 *
 * THE PARTITION IS EXHAUSTIVE. Every column the header PATCH writes is either in
 * DO_HEADER_LOCKED_FIELDS or DO_HEADER_OPEN_COLS — do-header-lock.test.ts fails
 * a new PATCH column that was not classified, so a field cannot be added to the
 * edit without somebody deciding whether an invoice freezes it.
 *
 * BYTE-IDENTICAL COPIES: backend/src/scm/shared/do-header-lock.ts (the server's
 * PATCH /delivery-orders-mfg/:id) and frontend/src/vendor/shared/do-header-lock.ts
 * (DeliveryOrderNewV2 edit mode + the phone's MobileDoHeaderEdit). Refereed by
 * frontend/src/vendor/shared/do-header-lock.canonical.test.ts. Edit both or
 * neither. */
import { normalizePhone } from './phone';

export type DoHeaderLockField = {
  /** DB column on scm.delivery_orders. */
  col: string;
  /** The PATCH body key(s) that write it. */
  body: readonly string[];
  /** What the refusal and the screen call it. */
  label: string;
};

export const DO_HEADER_LOCKED_FIELDS: readonly DoHeaderLockField[] = [
  { col: 'debtor_code', body: ['debtorCode'], label: 'customer code' },
  { col: 'debtor_name', body: ['debtorName'], label: 'customer' },
  { col: 'phone', body: ['phone'], label: 'phone' },
  { col: 'email', body: ['email'], label: 'email' },
  { col: 'customer_type', body: ['customerType'], label: 'customer type' },
  { col: 'address1', body: ['address1'], label: 'address line 1' },
  { col: 'address2', body: ['address2'], label: 'address line 2' },
  { col: 'city', body: ['city'], label: 'city' },
  { col: 'state', body: ['state'], label: 'state' },
  { col: 'customer_state', body: ['customerState'], label: 'state' },
  { col: 'postcode', body: ['postcode'], label: 'postcode' },
  { col: 'customer_country', body: ['customerCountry'], label: 'country' },
  { col: 'building_type', body: ['buildingType'], label: 'building type' },
  { col: 'venue', body: ['venue'], label: 'venue' },
  { col: 'venue_id', body: ['venueId'], label: 'venue' },
  { col: 'emergency_contact_name', body: ['emergencyContactName'], label: 'emergency contact name' },
  { col: 'emergency_contact_phone', body: ['emergencyContactPhone'], label: 'emergency contact phone' },
  { col: 'emergency_contact_relationship', body: ['emergencyContactRelationship'], label: 'emergency contact relationship' },
  { col: 'sales_location', body: ['salesLocation'], label: 'sales location' },
  { col: 'currency', body: ['currency'], label: 'currency' },
  { col: 'branding', body: ['branding'], label: 'branding' },
  { col: 'ref', body: ['ref'], label: 'reference' },
  { col: 'po_doc_no', body: ['poDocNo'], label: 'customer PO number' },
  { col: 'customer_so_no', body: ['customerSoNo'], label: 'customer SO reference' },
  { col: 'do_date', body: ['doDate', 'soDate'], label: 'DO date' },
  { col: 'customer_delivery_date', body: ['customerDeliveryDate'], label: 'customer delivery date' },
  { col: 'note', body: ['note'], label: 'note' },
  { col: 'notes', body: ['notes'], label: 'remarks' },
  { col: 'salesperson_id', body: ['salespersonId'], label: 'salesperson' },
  { col: 'agent', body: ['agent'], label: 'salesperson' },
];

/** Header columns that stay editable with a live Sales Invoice / Delivery Return. */
export const DO_HEADER_OPEN_COLS: ReadonlySet<string> = new Set([
  'driver_id', 'driver_name', 'vehicle',
  'expected_delivery_at',
  'time_range', 'time_confirmed', 'arrival_at', 'departure_at', 'shipout_date',
  'customer_delivered_date', 'eta_arriving_port', 'delivery_substatus',
  'arrives_em_warehouse_date',
]);

export const DO_HEADER_LOCK_COLS: ReadonlySet<string> =
  new Set(DO_HEADER_LOCKED_FIELDS.map((f) => f.col));

export const DO_HEADER_LOCK_LABELS: Record<string, string> =
  Object.fromEntries(DO_HEADER_LOCKED_FIELDS.map((f) => [f.col, f.label]));

export const DO_HEADER_LOCK_BODY_KEYS: ReadonlySet<string> =
  new Set(DO_HEADER_LOCKED_FIELDS.flatMap((f) => [...f.body]));

/** What the refusal says stays open — one sentence, used by the 409 body. */
export const DO_HEADER_OPEN_DESCRIPTION =
  'driver, vehicle, expected delivery date and delivery-execution times';

/** The screen's lock decision. `has_children` is what GET /delivery-orders-mfg/:id
    stamps from the SAME non-cancelled SI / DR counts the server's PATCH checks. */
export function doHeaderLocked(deliveryOrder: { has_children?: unknown } | null | undefined): boolean {
  return deliveryOrder?.has_children === true;
}

/** True when this PATCH body key may not be edited on a locked DO. */
export function isDoHeaderKeyLocked(bodyKey: string, locked: boolean): boolean {
  return locked && DO_HEADER_LOCK_BODY_KEYS.has(bodyKey);
}

/** Drop the locked keys from a PATCH body. A locked field is disabled on screen,
    so it cannot have changed — sending it anyway only invites a false refusal
    when the stored value is in an older format than the form re-sends. */
export function stripLockedDoHeaderKeys<T extends Record<string, unknown>>(body: T, locked: boolean): Partial<T> {
  if (!locked) return body;
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!DO_HEADER_LOCK_BODY_KEYS.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const PHONE_COLS: ReadonlySet<string> = new Set(['phone', 'emergency_contact_phone']);
const DATE_COLS: ReadonlySet<string> = new Set(['do_date', 'customer_delivery_date']);

/** Compare a stored value and a written value the way a person would: blank is
    blank, a phone is compared normalised (the PATCH normalises what it writes and
    a legacy row may hold "012-345 6789"), and a date by its calendar day (a form
    re-sends YYYY-MM-DD while a row may read back with a time part). */
export function sameDoHeaderValue(col: string, a: unknown, b: unknown): boolean {
  const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
  let x = s(a);
  let y = s(b);
  if (PHONE_COLS.has(col)) {
    x = normalizePhone(x) ?? x;
    y = normalizePhone(y) ?? y;
  } else if (DATE_COLS.has(col)) {
    x = x.slice(0, 10);
    y = y.slice(0, 10);
  }
  return x === y;
}

/** The locked columns this patch genuinely CHANGES. `updates` is the snake-keyed
    column map the route is about to write; `before` is the stored row. */
export function doLockedHeaderChanges(
  updates: Record<string, unknown>,
  before: Record<string, unknown>,
): string[] {
  return DO_HEADER_LOCKED_FIELDS
    .map((f) => f.col)
    .filter((col) => col in updates && !sameDoHeaderValue(col, updates[col], before[col]));
}
