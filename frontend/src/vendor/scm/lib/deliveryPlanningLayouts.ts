// Code-shipped, team-wide column layouts for the Delivery Planning board.
//
// Unlike the per-user named layouts (mig 0239) and the single per-company
// default, these are read-only presets that ship in the build and show FIRST
// in every user's Columns > Layout picker, for both companies, with nothing to
// set up. They are the four working views the owner defined in his 2026-09-24
// column pass (one Excel tab per layout, his own column order):
//
//   Delivery Date     — admin confirms/reschedules the delivery date.
//   Delivery Details  — after scheduling: crew, lorry, times.
//   SG Order          — Singapore 3PL (adds Ship-out; no local crew).
//   EM Order          — East Malaysia 3PL (ESB sea leg + BS last mile).
//
// Each preset is a full column ORDER plus the HIDDEN set; a picked layout is
// COPIED into the user's live arrangement (DataGrid.applyGridPreset), so it is
// a starting point they can still adjust. `order` lists every board column so
// hidden ones keep their place in the drawer; keep both in sync with the board.

import type { LayoutSeed, StoredLayout } from "../../../lib/tableLayouts";

/** Full column order shared by Delivery Date / Delivery Details / SG Order —
 *  status -> who/what/worth -> dates + amend -> house/address -> remarks/docs ->
 *  send status, then the default-hidden crew / cross-border tail. EM Order pulls
 *  the shipping legs up next to the dates, so it carries its own order. */
const BASE_ORDER: readonly string[] = [
  "delivery_message_status", "row_type", "company_code", "so_doc_no", "do",
  "so_date", "so_ref", "branding", "debtor_name", "phone", "region",
  "salesperson", "total_amount", "balance_sen", "stock_remark",
  "processing_date", "customer_delivery_date", "delivery_substatus",
  "amended_delivery_date", "amend_date_from_customer", "amend_reason",
  "house_type", "replacement_disposal", "disposal_request", "po_nos",
  "address", "postcode", "dp_remark", "do_date", "wa_message", "venue",
  "warehouse", "time_range", "time_confirmed", "departure_at", "arrival_at",
  "trip_no", "lorry", "driver", "driver_ic", "driver_contact", "driver_2",
  "helper_1", "helper_2", "shipout_date", "eta_arriving_port",
  "arrives_em_warehouse_date", "em_delivery_status", "consignment_no",
  "vessel_voyage", "etd_port_klang", "bs_delivery_date", "esb_remarks",
  "bs_remarks", "ctn",
];

/** EM Order — the two 3PL legs (ESB sea freight, BS last mile) sit right after
 *  the delivery dates; amend/house/crew fall to the hidden tail. */
const EM_ORDER: readonly string[] = [
  "delivery_message_status", "row_type", "company_code", "so_doc_no", "do",
  "so_date", "so_ref", "branding", "debtor_name", "phone", "region",
  "salesperson", "total_amount", "balance_sen", "stock_remark",
  "processing_date", "customer_delivery_date", "delivery_substatus",
  "amended_delivery_date", "shipout_date", "em_delivery_status",
  "arrives_em_warehouse_date", "consignment_no", "vessel_voyage",
  "etd_port_klang", "eta_arriving_port", "bs_delivery_date", "esb_remarks",
  "bs_remarks", "ctn", "po_nos", "address", "postcode", "dp_remark", "do_date",
  "wa_message", "amend_date_from_customer", "amend_reason", "house_type",
  "replacement_disposal", "disposal_request", "venue", "warehouse",
  "time_range", "time_confirmed", "departure_at", "arrival_at", "trip_no",
  "lorry", "driver", "driver_ic", "driver_contact", "driver_2", "helper_1",
  "helper_2",
];

const layout = (order: readonly string[], hidden: readonly string[]): StoredLayout => ({
  order: [...order],
  hidden: [...hidden],
  shown: [],
  widths: {},
  pinned: [],
  pinnedRight: [],
  groupBy: [],
});

export const DELIVERY_PLANNING_LAYOUT_PRESETS: LayoutSeed[] = [
  {
    id: "delivery-date",
    label: "Delivery Date",
    layout: layout(BASE_ORDER, [
      "company_code", "do_date", "venue", "warehouse", "time_range",
      "time_confirmed", "departure_at", "arrival_at", "trip_no", "lorry",
      "driver", "driver_ic", "driver_contact", "driver_2", "helper_1",
      "helper_2", "shipout_date", "eta_arriving_port",
      "arrives_em_warehouse_date", "em_delivery_status", "consignment_no",
      "vessel_voyage", "etd_port_klang", "bs_delivery_date", "esb_remarks",
      "bs_remarks", "ctn",
    ]),
  },
  {
    id: "delivery-details",
    label: "Delivery Details",
    layout: layout(BASE_ORDER, [
      "company_code", "do_date", "venue", "shipout_date", "eta_arriving_port",
      "arrives_em_warehouse_date", "em_delivery_status", "consignment_no",
      "vessel_voyage", "etd_port_klang", "bs_delivery_date", "esb_remarks",
      "bs_remarks", "ctn",
    ]),
  },
  {
    id: "sg-order",
    label: "SG Order",
    layout: layout(BASE_ORDER, [
      "company_code", "do_date", "venue", "warehouse", "time_range",
      "time_confirmed", "departure_at", "arrival_at", "trip_no", "lorry",
      "driver", "driver_ic", "driver_contact", "driver_2", "helper_1",
      "helper_2", "eta_arriving_port", "arrives_em_warehouse_date",
      "em_delivery_status", "consignment_no", "vessel_voyage", "etd_port_klang",
      "bs_delivery_date", "esb_remarks", "bs_remarks", "ctn",
    ]),
  },
  {
    id: "em-order",
    label: "EM Order",
    layout: layout(EM_ORDER, [
      "company_code", "do_date", "amend_date_from_customer", "amend_reason",
      "house_type", "replacement_disposal", "disposal_request", "venue",
      "warehouse", "time_range", "time_confirmed", "departure_at",
      "arrival_at", "trip_no", "lorry", "driver", "driver_ic",
      "driver_contact", "driver_2", "helper_1", "helper_2",
    ]),
  },
];
