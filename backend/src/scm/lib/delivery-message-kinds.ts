
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
  'overdue_order',
  'postage',
  // East Malaysia (Sabah / Sarawak) sea-freight touchpoints (owner 2026-11-20):
  // prep notice (an opener), shipped (reads the consignment no + ETA the staff
  // entered on the board's EM columns), and arrived at the EM port (gated on the
  // warehouse-arrival date). None moves a Delivery Message Status.
  'eastmy_prep',
  'eastmy_shipped',
  'eastmy_arrived',
  // Service Case (ASSR) legs only — sent by assr-arrangement-message.ts (HC-0171).
  'assr_arrangement',
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
  overdue_order: 'Overdue Order',
  postage: 'Postage Confirm',
  eastmy_prep: 'East Malaysia Prep Notice',
  eastmy_shipped: 'East Malaysia Shipped',
  eastmy_arrived: 'East Malaysia Arrived',
  assr_arrangement: 'Service Arrangement',
};

/** The Delivery Message Status a sent order lands on (owner 2026-10-21: every
 *  send lands the row on its "Done X"; values from HC_MESSAGE_STATUS_VALUES).
 *  Service Arrangement is not here: an ASSR job has no SO status column, its row
 *  reads its state off the WhatsApp record. Overdue Order is not here either: a
 *  one-way production-delay heads-up moves no status (guarded in /send). */
export const KIND_AFTER_STATUS: Record<Exclude<MessageKind, 'assr_arrangement' | 'overdue_order' | 'eastmy_prep' | 'eastmy_shipped' | 'eastmy_arrived'>, string> = {
  delivery: 'Done Send',
  amend: 'Done Amend',
  postpone: 'Done Postpone Reason',
  driver_info: 'Done Driver Information',
  balance_reminder: 'Done Balance Collection',
  reminder_1: 'Done Remind (1)',
  reminder_2: 'Done Remind (2)',
  reminder_3: 'Done Remind (3)',
  postage: 'Done Postage',
  delivery_completed: 'Done Delivered',
};

/** Kinds that OPEN a Confirm / Amend conversation. Only these reset the
 *  contact's button_status & co. — a Driver Info or Balance Reminder sent to a
 *  customer who already confirmed must not unlock the Delivery Lock guard. The
 *  East Malaysia prep notice opens the details conversation (its callback comes
 *  back as the eastmy_ack form), so it resets too; Shipped / Arrived are one-way. */
export const OPENER_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(['delivery', 'amend', 'postpone', 'assr_arrangement', 'eastmy_prep']);

/** Kinds that move NO Delivery Message Status after they send: a one-way
 *  production-delay heads-up (overdue_order) and the three East Malaysia
 *  touchpoints, which track their own lifecycle on the board's EM columns and
 *  must not disturb the delivery-date conversation's status. (assr_arrangement
 *  never reaches the SO status path — it has its own sender.) */
export const NO_STATUS_MOVE_KINDS: ReadonlySet<MessageKind> =
  new Set<MessageKind>(['overdue_order', 'eastmy_prep', 'eastmy_shipped', 'eastmy_arrived']);

/** True when this kind lands a "Done X" Delivery Message Status after it sends —
 *  i.e. it has a KIND_AFTER_STATUS entry. The type predicate lets the caller index
 *  KIND_AFTER_STATUS without a cast. assr_arrangement is excluded (its own sender,
 *  no SO status); so is every NO_STATUS_MOVE_KINDS kind. */
export function movesDeliveryStatus(kind: MessageKind): kind is keyof typeof KIND_AFTER_STATUS {
  return kind !== 'assr_arrangement' && !NO_STATUS_MOVE_KINDS.has(kind);
}

/** Kinds a Service Case (ASSR) leg row can be sent — besides assr_arrangement,
 *  which is ASSR-only and handled on its own. A mixed selection's ASSR row keys
 *  are split out to the ASSR sender (assr-arrangement-message.ts) for these;
 *  every other kind reads a Sales Order and leaves ASSR rows out. Keep in step
 *  with the board's own ASSR gating (frontend DeliveryPlanning). */
export const ASSR_LEG_SEND_KINDS: ReadonlySet<MessageKind> =
  new Set<MessageKind>(['driver_info', 'postpone', 'reminder_1', 'reminder_2', 'reminder_3']);

export interface DriverInfoInput {
  driverName: string;
  driverContact: string;
  driverIc: string;
  carPlate: string;
  deliveryTime: string;
}

export interface SendExtras {
  driverInfo?: DriverInfoInput;
}

/** The SO header columns a kind may read for its attributes. */
export interface KindSoRow {
  phone?: unknown;
  delivery_address1?: unknown; delivery_address2?: unknown; delivery_address3?: unknown; delivery_address4?: unknown;
  address1?: unknown; address2?: unknown; address3?: unknown; address4?: unknown;
  postcode?: unknown; city?: unknown; customer_state?: unknown;
  amend_reason?: unknown; amended_delivery_date?: unknown; customer_delivery_date?: unknown;
  consignment_no?: unknown; eta_arriving_port?: unknown;
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
  attributes: Record<string, string>;
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
    case 'eastmy_prep':
      return { attributes: {} };

    case 'balance_reminder':
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
      // Inline, from the board (owner 2026-10-15): the reason is the row's
      // Amend Reason and the proposed new date is its "Delivery Date"
      // (amended_delivery_date) — no modal re-entry. The current date the
      // notice quotes is the original (customer_delivery_date), falling back to
      // the effective date. An order missing either the reason or the new date
      // is skipped, not sent with a blank.
      const reason = clean(first.amend_reason);
      const newDate = clean(first.amended_delivery_date).slice(0, 10);
      if (!reason || !newDate) return { attributes: {}, skip: 'postpone_needs_reason_date' };
      const current = clean(first.customer_delivery_date).slice(0, 10) || clean(effectiveDate).slice(0, 10);
      return {
        attributes: {
          client_delivery_date: templateDate(current),
          amend_date_reason_2: reason,
          new_delivery_date: templateDate(newDate),
        },
      };
    }

    case 'overdue_order': {
      const reason = clean(first.amend_reason);
      if (!reason) return { attributes: {}, skip: 'overdue_order_needs_reason' };
      return { attributes: { amend_date_reason: reason } };
    }

    case 'assr_arrangement':
      return { attributes: {}, skip: 'assr_only' };

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

    case 'eastmy_shipped': {
      const consignment = clean(first.consignment_no);
      const eta = clean(first.eta_arriving_port).slice(0, 10);
      if (!consignment || !eta) return { attributes: {}, skip: 'eastmy_shipment_fields_required' };
      return { attributes: { consignment_no: consignment, eta_em_port: templateDate(eta) } };
    }

    case 'eastmy_arrived': {
      // Operator-judgment send (owner 2026-11-20): Sya Sya decides from Delivery
      // Planning that the goods have arrived and sends this by hand, so there is
      // NO system date gate. The structured arrival date is never filled in
      // practice (ops track arrival as free text in em_delivery_status), which
      // would otherwise block every send. Nothing beyond the shared bundle's
      // ref_1 is in this template.
      return { attributes: {} };
    }
  }
}
