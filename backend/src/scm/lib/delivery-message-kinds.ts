// ---------------------------------------------------------------------------
// delivery-message-kinds.ts — the message TYPES the Delivery Planning board can
// send through Houzs Connect, and what each one needs from the ERP.
//
// Every kind names ONE Connect automation (matched by exact name — a mismatch
// fires nothing) and the extra contact attributes its template reads beyond the
// shared bundle (full_name / ref_N / delivery_date_N / brand_N / order_total /
// callback_url / amount / per-company blocks — see services/connect.ts). The
// attribute keys are Connect's, read off the flow definitions in houzs-connect
// src/lib/automation/flows/*.ts; renaming one here blanks a template variable.
//
// Two kinds take OPERATOR input because the ERP does not hold the data yet
// (checked in prod 2026-10-05: 0 of 516 September DOs carry a driver or a time
// range, no trip stops): Driver Info (driver / lorry / time picked in the modal)
// and Postpone (reason + proposed date). A kind whose data is missing for an
// order SKIPS that order with a reason the operator sees — it never sends a
// template with a blank variable.
// ---------------------------------------------------------------------------

export const MESSAGE_KINDS = [
  'delivery',
  'amend',
  'reminder_1',
  'reminder_2',
  'reminder_3',
  'driver_info',
  'delivery_completed',
  'balance_reminder',
  'postpone',
  'postage',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The Connect automation each kind fires — its NAME in chat.houzscentury.com. */
export const KIND_AUTOMATION: Record<MessageKind, string> = {
  delivery: 'New Delivery Follow-up',
  amend: 'New Amend',
  reminder_1: 'Reminder 1',
  reminder_2: 'Reminder 2',
  reminder_3: 'Reminder 3',
  driver_info: 'Driver Info',
  delivery_completed: 'Delivery Completed',
  balance_reminder: 'Balance Reminder',
  postpone: 'Postpone',
  postage: 'Postage Confirm',
};

/** Kinds that OPEN a Confirm / Amend conversation. Only these reset the
 *  contact's button_status & co. — a Driver Info or Balance Reminder sent to a
 *  customer who already confirmed must not unlock the Delivery Lock guard. */
export const OPENER_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(['delivery', 'amend', 'postpone']);

export interface DriverInfoInput {
  driverName: string;
  driverContact: string;
  driverIc: string;
  carPlate: string;
  /** Free text the template prints after "Time:" — "10am–1pm". */
  deliveryTime: string;
}

export interface PostponeInput {
  /** Printed after "due to" — "lorry breakdown". */
  reason: string;
  /** yyyy-mm-dd (the board's date input). */
  newDate: string;
}

export interface SendExtras {
  driverInfo?: DriverInfoInput;
  postpone?: PostponeInput;
}

/** The SO header columns a kind may read for its attributes. */
export interface KindSoRow {
  phone?: unknown;
  delivery_address1?: unknown; delivery_address2?: unknown; delivery_address3?: unknown; delivery_address4?: unknown;
  address1?: unknown; address2?: unknown; address3?: unknown; address4?: unknown;
  postcode?: unknown; city?: unknown; customer_state?: unknown;
}

/** ISO yyyy-mm-dd → the templates' yyyy/mm/dd; '' when blank. */
export function templateDate(iso: string | null | undefined): string {
  return String(iso ?? '').slice(0, 10).replace(/-/g, '/');
}

const clean = (v: unknown): string => String(v ?? '').trim();

/** One line the Postage template prints: the DELIVERY address when the order
 *  carries one, else the customer address, then postcode / city / state. Empty
 *  parts are dropped, never left as ", ,". */
export function joinDeliveryAddress(row: KindSoRow): string {
  const delivery = [row.delivery_address1, row.delivery_address2, row.delivery_address3, row.delivery_address4].map(clean).filter(Boolean);
  const customer = [row.address1, row.address2, row.address3, row.address4].map(clean).filter(Boolean);
  const street = delivery.length ? delivery : customer;
  const tail = [[clean(row.postcode), clean(row.city)].filter(Boolean).join(' '), clean(row.customer_state)].filter(Boolean);
  return [...street, ...tail].join(', ');
}

export interface KindAttributesResult {
  /** Extra attributes for this kind (empty for the plain openers). */
  attributes: Record<string, string>;
  /** When set, the whole phone group is skipped with this reason. */
  skip?: string;
}

/**
 * Per-kind attributes for ONE phone group. `first` is the group's first order
 * (the single-order templates print one date / one address); `effectiveDate`
 * is that order's effective delivery date (amended ?? original) as ISO;
 * `owedSen` is the group's owed total (what `amount` prints).
 */
export function kindAttributes(
  kind: MessageKind,
  first: KindSoRow,
  effectiveDate: string | null,
  owedSen: number,
  extras: SendExtras | undefined,
): KindAttributesResult {
  switch (kind) {
    case 'delivery':
    case 'amend':
    case 'reminder_1':
    case 'reminder_2':
    case 'reminder_3':
    case 'delivery_completed':
      return { attributes: {} };

    case 'balance_reminder':
      // The template's whole point is the figure; nothing owed = nothing to say.
      if (owedSen <= 0) return { attributes: {}, skip: 'no_balance' };
      return { attributes: {} };

    case 'driver_info': {
      const d = extras?.driverInfo;
      if (!d) return { attributes: {}, skip: 'driver_info_required' };
      return {
        attributes: {
          client_delivery_date: templateDate(effectiveDate),
          delivery_time: clean(d.deliveryTime),
          drivers_name: clean(d.driverName),
          drivers_contact: clean(d.driverContact),
          drivers_ic: clean(d.driverIc),
          car_plate: clean(d.carPlate),
        },
      };
    }

    case 'postpone': {
      const p = extras?.postpone;
      if (!p) return { attributes: {}, skip: 'postpone_required' };
      return {
        attributes: {
          client_delivery_date: templateDate(effectiveDate),
          amend_date_reason_2: clean(p.reason),
          new_delivery_date: templateDate(p.newDate),
        },
      };
    }

    case 'postage': {
      const address = joinDeliveryAddress(first);
      if (!address) return { attributes: {}, skip: 'no_address' };
      const digits = clean(first.phone).replace(/\D/g, '');
      return {
        attributes: {
          customer_phone: digits ? `+${digits}` : '',
          delivery_address: address,
        },
      };
    }
  }
}
