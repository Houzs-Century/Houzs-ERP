// Field metadata for PATCH /delivery-planning/:type/:id/fields — the value
// whitelists, the zod body schema, and the camelCase-key -> snake_case-column
// maps split by table (SO header vs DO row). Lives here, not in the router, to
// keep delivery-planning.ts under its file-size ceiling; imported back by the
// route and by delivery-planning.fields.test.ts / delivery-planning-fields.test.ts.
import { z } from 'zod';

export const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

/* The customer-message follow-up workflow statuses shown/edited in the "Delivery
   Status" column (owner 2026-09-22). One of these 23 values, or blank. The
   coarse scm.delivery_state (the top state tabs) is a separate, derived field
   and is NOT one of these — the tabs get their own rework later. */
export const HC_MESSAGE_STATUS_VALUES = [
  'To Send Delivery Date', 'Pending Customer Reply (D)', 'Pending Reschedule (D)',
  'Done Scheduling', 'Not Sent (D)', 'Pending Reschedule (A)', 'Not Sent (A)',
  'Invalid Data', '3 Days Reminder Sent (Time)', '1 Day Reminder Sent (Driver)',
  '7 Days Balance Reminder Sent', 'To Send Delivery Time', 'Done Delivery Time',
  'To Send Driver Info', 'Done Driver Information', 'To Send Collect Balance',
  'Done Balance Collection', 'To Send Postpone Reason', 'Done Postpone Reason',
  'To Remind Customer Reply (1)', 'To Remind Customer Reply (2)',
  'To Remind Customer Reply (3)', 'Done Remind',
] as const;

export const fieldsSchema = z.object({
  // SO-context (→ mfg_sales_orders)
  possessionDate: z.string().nullable().optional(),       // YYYY-MM-DD
  houseType: z.string().nullable().optional(),            // New House / Replacement (free text)
  replacementDisposal: z.string().nullable().optional(),
  referral: z.string().nullable().optional(),
  deliveryMessageStatus: z.string().nullable().optional(),  // one of the 23 workflow values, or blank
  disposalRequest: z.string().nullable().optional(),
  dpRemark: z.string().nullable().optional(),
  amendReason: z.string().nullable().optional(),  // preset reason or free text
  // Amendment dates — the customer's ORIGINAL customer_delivery_date is NEVER
  // edited here; only the amendment columns are.
  amendDateFromCustomer: z.string().nullable().optional(),  // YYYY-MM-DD (customer's ask)
  amendedDeliveryDate: z.string().nullable().optional(),    // YYYY-MM-DD (we confirm)
  // DO-execution (→ delivery_orders)
  timeRange: z.string().nullable().optional(),
  timeConfirmed: z.boolean().nullable().optional(),
  arrivalAt: z.string().nullable().optional(),            // ISO datetime
  departureAt: z.string().nullable().optional(),
  shipoutDate: z.string().nullable().optional(),          // YYYY-MM-DD
  customerDeliveredDate: z.string().nullable().optional(),
  etaArrivingPort: z.string().nullable().optional(),      // port / shipment ref
  deliverySubstatus: z.string().nullable().optional(),    // HC "Remark 4" (whitelisted, blank allowed)
  arrivesEmWarehouseDate: z.string().nullable().optional(),  // YYYY-MM-DD
  // EM cross-border transport status (owner 2026-09-23) — ESB sea-freight + BS
  // last-mile legs, back-filled by the two 3PL transporters.
  emDeliveryStatus: z.string().nullable().optional(),
  consignmentNo: z.string().nullable().optional(),
  vesselVoyage: z.string().nullable().optional(),
  etdPortKlang: z.string().nullable().optional(),         // YYYY-MM-DD
  bsDeliveryDate: z.string().nullable().optional(),       // YYYY-MM-DD
  esbRemarks: z.string().nullable().optional(),
  bsRemarks: z.string().nullable().optional(),
  ctn: z.string().nullable().optional(),                  // carton count (free text)
  emDeliveredDate: z.string().nullable().optional(),      // YYYY-MM-DD (Done Delivery)
});

/* Map the camelCase request keys → the snake_case columns, split by table. */
export const SO_FIELD_COLS: Record<string, string> = {
  possessionDate: 'possession_date',
  houseType: 'house_type',
  replacementDisposal: 'replacement_disposal',
  referral: 'referral',
  deliveryMessageStatus: 'delivery_message_status',
  disposalRequest: 'disposal_request',
  dpRemark: 'dp_remark',
  amendReason: 'amend_reason',
  // Amendment dates — NEVER customer_delivery_date (the original).
  amendDateFromCustomer: 'amend_date_from_customer',
  amendedDeliveryDate: 'amended_delivery_date',
};
export const DO_FIELD_COLS: Record<string, string> = {
  timeRange: 'time_range',
  timeConfirmed: 'time_confirmed',
  arrivalAt: 'arrival_at',
  departureAt: 'departure_at',
  shipoutDate: 'shipout_date',
  customerDeliveredDate: 'customer_delivered_date',
  etaArrivingPort: 'eta_arriving_port',
  deliverySubstatus: 'delivery_substatus',
  arrivesEmWarehouseDate: 'arrives_em_warehouse_date',
  emDeliveryStatus: 'em_delivery_status',
  consignmentNo: 'consignment_no',
  vesselVoyage: 'vessel_voyage',
  etdPortKlang: 'etd_port_klang',
  bsDeliveryDate: 'bs_delivery_date',
  esbRemarks: 'esb_remarks',
  bsRemarks: 'bs_remarks',
  ctn: 'ctn',
  emDeliveredDate: 'em_delivered_date',
};

/* The raw scm.delivery_orders row the board read shapes into the per-DO exec
   fields — dual-read snake + camelCase (the pg driver camelCases result
   columns). Declared here (rather than inline in the router) to keep
   delivery-planning.ts under its file-size ceiling. */
export type DeliveryOrderExecRow = {
  id: string; do_number: string | null; so_doc_no: string | null; status: string | null;
  driver_id: string | null; driverId?: string | null;
  delivery_state: string | null; customer_delivery_date: string | null; do_date: string | null;
  time_range: string | null; time_confirmed: boolean | null;
  arrival_at: string | null; departure_at: string | null;
  shipout_date: string | null; customer_delivered_date: string | null;
  eta_arriving_port: string | null; delivery_substatus: string | null;
  arrives_em_warehouse_date: string | null;
  em_delivery_status: string | null; consignment_no: string | null;
  vessel_voyage: string | null; etd_port_klang: string | null;
  bs_delivery_date: string | null; esb_remarks: string | null;
  bs_remarks: string | null; ctn: string | null; em_delivered_date: string | null;
  doDate?: string | null;
  timeRange?: string | null; timeConfirmed?: boolean | null;
  arrivalAt?: string | null; departureAt?: string | null;
  shipoutDate?: string | null; customerDeliveredDate?: string | null;
  etaArrivingPort?: string | null; deliverySubstatus?: string | null;
  arrivesEmWarehouseDate?: string | null;
  emDeliveryStatus?: string | null; consignmentNo?: string | null;
  vesselVoyage?: string | null; etdPortKlang?: string | null;
  bsDeliveryDate?: string | null; esbRemarks?: string | null;
  bsRemarks?: string | null; emDeliveredDate?: string | null;
};
