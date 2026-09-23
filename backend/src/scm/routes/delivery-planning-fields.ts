// Field metadata for PATCH /delivery-planning/:type/:id/fields — the delivery
// sub-status whitelist, the zod body schema, and the camelCase-key -> snake_case
// column maps split by table (SO header vs DO row). Lives here, not in the
// router, to keep delivery-planning.ts under its file-size ceiling; imported
// back by the route.
import { z } from 'zod';

export const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

export const fieldsSchema = z.object({
  // SO-context (→ mfg_sales_orders)
  possessionDate: z.string().nullable().optional(),       // YYYY-MM-DD
  houseType: z.string().nullable().optional(),            // New House / Replacement (free text)
  replacementDisposal: z.string().nullable().optional(),
  referral: z.string().nullable().optional(),
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
