import { z } from 'zod';
import { ASSR_BOARD_LEGS } from '../lib/assr-board-scope';

export const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

/* The customer-message follow-up workflow statuses shown/edited in the "Delivery
   Status" column. One of these 28 values, or blank (owner 2026-10-22). The
   coarse scm.delivery_state (the top state tabs) is a separate, derived field
   and is NOT one of these — the tabs get their own rework later. Byte-synced with
   the frontend MESSAGE_STATUSES (delivery-planning-queries.ts). */
export const HC_MESSAGE_STATUS_VALUES = [
  'To Send Delivery Date', 'Done Send',
  'To Send Driver Info', 'Done Driver Information',
  'To Send Collect Balance', 'Done Balance Collection',
  'To Send Postpone Reason', 'Done Postpone Reason',
  'To Send Postage', 'Done Postage',
  'Done Amend', 'Done Delivered',
  'To Remind Customer Reply (1)', 'To Remind Customer Reply (2)', 'To Remind Customer Reply (3)',
  'Done Remind (1)', 'Done Remind (2)', 'Done Remind (3)',
  'Done Scheduling', 'Pending Reschedule (D)',
  'Not Sent (D)', 'Not Sent (A)', 'Invalid Data',
  // East Malaysia / Singapore shipping + the (A)-round reschedule and customer-reply
  // statuses the HC Delivery sheet actually uses — added so the sheet backfill's
  // real statuses are first-class dropdown values (owner 2026-10-22).
  'Done Shipout', 'Pending Delivery (EM)', 'Customer Confirm Shipment',
  'Pending Reschedule (A)', 'Pending Customer Reply (D)',
] as const;

export const fieldsSchema = z.object({
  possessionDate: z.string().nullable().optional(),
  houseType: z.string().nullable().optional(),
  replacementDisposal: z.string().nullable().optional(),
  referral: z.string().nullable().optional(),
  deliveryMessageStatus: z.string().nullable().optional(),
  disposalRequest: z.string().nullable().optional(),
  dpRemark: z.string().nullable().optional(),
  amendReason: z.string().nullable().optional(),
  amendDateFromCustomer: z.string().nullable().optional(),
  amendedDeliveryDate: z.string().nullable().optional(),
  timeRange: z.string().nullable().optional(),
  jobKind: z.enum(ASSR_BOARD_LEGS).optional(),
  timeConfirmed: z.boolean().nullable().optional(),
  arrivalAt: z.string().nullable().optional(),
  departureAt: z.string().nullable().optional(),
  shipoutDate: z.string().nullable().optional(),
  customerDeliveredDate: z.string().nullable().optional(),
  etaArrivingPort: z.string().nullable().optional(),
  deliverySubstatus: z.string().nullable().optional(),
  arrivesEmWarehouseDate: z.string().nullable().optional(),
  // EM cross-border transport status (owner 2026-09-23) — ESB sea-freight + BS
  // last-mile legs, back-filled by the two 3PL transporters.
  emDeliveryStatus: z.string().nullable().optional(),
  consignmentNo: z.string().nullable().optional(),
  vesselVoyage: z.string().nullable().optional(),
  etdPortKlang: z.string().nullable().optional(),
  bsDeliveryDate: z.string().nullable().optional(),
  esbRemarks: z.string().nullable().optional(),
  bsRemarks: z.string().nullable().optional(),
  ctn: z.string().nullable().optional(),
  emDeliveredDate: z.string().nullable().optional(),
});

export const SO_FIELD_COLS: Record<string, string> = {
  possessionDate: 'possession_date',
  houseType: 'house_type',
  replacementDisposal: 'replacement_disposal',
  referral: 'referral',
  deliveryMessageStatus: 'delivery_message_status',
  disposalRequest: 'disposal_request',
  dpRemark: 'dp_remark',
  amendReason: 'amend_reason',
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

export type DeliveryOrderExecRow = {
  id: string; do_number: string | null; so_doc_no: string | null; status: string | null;
  driver_id: string | null; driverId?: string | null;
  driver_name?: string | null; driverName?: string | null; vehicle?: string | null;
  delivery_state: string | null; customer_delivery_date: string | null; do_date: string | null;
  delivered_at: string | null; pod_r2_key: string | null; pod_lat: number | null;
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
  deliveredAt?: string | null; podR2Key?: string | null; podLat?: number | null;
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

export type DoExecOut = {
  time_range: string | null; time_confirmed: boolean | null;
  arrival_at: string | null; departure_at: string | null;
  shipout_date: string | null; customer_delivered_date: string | null;
  eta_arriving_port: string | null; delivery_substatus: string | null;
  arrives_em_warehouse_date: string | null;
  em_delivery_status: string | null; consignment_no: string | null;
  vessel_voyage: string | null; etd_port_klang: string | null;
  bs_delivery_date: string | null; esb_remarks: string | null;
  bs_remarks: string | null; ctn: string | null; em_delivered_date: string | null;
  do_date: string | null;
  delivered_at: string | null; pod_r2_key: string | null; pod_lat: number | null;
  has_pod: boolean;
};

export type TypedHeaderCrew = {
  driver: string; helper: null; lorry: string | null;
  driver_1_name: string; driver_1_ic: null; driver_1_contact: null;
  driver_2_name: null; helper_1_name: null; helper_2_name: null;
  lorry_plate: string | null; driver_1_typed: true;
};
export function typedHeaderCrewByDo(rows: ReadonlyArray<DeliveryOrderExecRow>): Map<string, TypedHeaderCrew> {
  const out = new Map<string, TypedHeaderCrew>();
  for (const d of rows) {
    const name = String(d.driverName ?? d.driver_name ?? '').trim();
    if (!name) continue;
    const plate = String(d.vehicle ?? '').trim() || null;
    out.set(d.id, {
      driver: name, helper: null, lorry: plate,
      driver_1_name: name, driver_1_ic: null, driver_1_contact: null,
      driver_2_name: null, helper_1_name: null, helper_2_name: null,
      lorry_plate: plate, driver_1_typed: true,
    });
  }
  return out;
}

export function pickDisplayCrew<T>(
  doIdsOldestToNewest: ReadonlyArray<string>,
  getCrew: (doId: string) => T | null,
  hasDriver: (crew: T) => boolean,
): T | null {
  if (doIdsOldestToNewest.length === 0) return null;
  const newestCrew = getCrew(doIdsOldestToNewest[doIdsOldestToNewest.length - 1]!);
  if (newestCrew !== null && hasDriver(newestCrew)) return newestCrew;
  for (let i = doIdsOldestToNewest.length - 2; i >= 0; i--) {
    const earlier = getCrew(doIdsOldestToNewest[i]!);
    if (earlier !== null && hasDriver(earlier)) return earlier;
  }
  return newestCrew;
}
