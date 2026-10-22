import { describe, it, expect } from "vitest";
import { DELIVERY_PLANNING_LAYOUT_PRESETS } from "./deliveryPlanningLayouts";

/* The full Delivery Planning board column set, AFTER the 2026-09-24 pass that
   dropped delivery_state / arrangement_stage / em_delivered_date as columns.
   Every preset must cover exactly this set (order lists all columns; the hidden
   ones keep their place). If a board column is added or removed, update both the
   board's DP_DEFAULT_ORDER and the presets — this list is the reminder. */
const BOARD_COLUMNS = [
  "delivery_message_status", "row_type", "company_code", "so_doc_no", "do",
  "so_date", "so_ref", "branding", "debtor_name", "phone", "region",
  "salesperson", "total_amount", "balance_sen", "stock_remark",
  "processing_date", "customer_delivery_date", "delivery_substatus",
  "amended_delivery_date", "amend_date_from_customer", "amend_reason_from_customer", "amend_reason",
  "house_type", "replacement_disposal", "disposal_request", "po_nos",
  "address", "postcode", "dp_remark", "do_date", "delivered_at", "wa_message", "pod", "venue",
  "warehouse", "time_range", "time_confirmed", "departure_at", "arrival_at",
  "trip_no", "lorry", "driver", "driver_ic", "driver_contact", "driver_2",
  "helper_1", "helper_2", "shipout_date", "eta_arriving_port",
  "arrives_em_warehouse_date", "em_delivery_status", "consignment_no",
  "vessel_voyage", "etd_port_klang", "bs_delivery_date", "esb_remarks",
  "bs_remarks", "ctn",
].sort();

/** Columns the owner deleted — must not reappear in any preset. */
const DROPPED = ["delivery_state", "arrangement_stage", "em_delivered_date", "days_left", "attention"];

/** Owner's four tabs, in order, with the visible-column count he arranged
 *  (+1 on the three BASE_ORDER tabs since 2026-10-14: "Customer Amend Reason"
 *  sits beside Customer Request Date; EM Order hides both. +1 on every tab
 *  since 2026-10-19: the "POD" column shows; "Delivered At" is added hidden). */
const EXPECTED = [
  { id: "delivery-date", label: "Delivery Date", visible: 30 },
  { id: "delivery-details", label: "Delivery Details", visible: 43 },
  { id: "sg-order", label: "SG Order", visible: 31 },
  { id: "em-order", label: "EM Order", visible: 35 },
];

describe("Delivery Planning layout presets", () => {
  it("ships exactly the owner's four layouts, in order", () => {
    expect(DELIVERY_PLANNING_LAYOUT_PRESETS.map((p) => ({ id: p.id, label: p.label }))).toEqual(
      EXPECTED.map(({ id, label }) => ({ id, label })),
    );
  });

  it("each preset covers every board column exactly once, none dropped", () => {
    for (const p of DELIVERY_PLANNING_LAYOUT_PRESETS) {
      const order = p.layout.order;
      expect(new Set(order).size, `${p.id} has duplicate keys`).toBe(order.length);
      expect([...order].sort(), `${p.id} order != board columns`).toEqual(BOARD_COLUMNS);
      for (const dropped of DROPPED) {
        expect(order, `${p.id} still lists ${dropped}`).not.toContain(dropped);
      }
    }
  });

  it("hidden is a subset of order, and visible counts match the owner's tabs", () => {
    for (const { id, visible } of EXPECTED) {
      const p = DELIVERY_PLANNING_LAYOUT_PRESETS.find((x) => x.id === id)!;
      const orderSet = new Set(p.layout.order);
      for (const h of p.layout.hidden) {
        expect(orderSet.has(h), `${id} hides ${h} not in order`).toBe(true);
      }
      expect(new Set(p.layout.hidden).size, `${id} has duplicate hidden keys`).toBe(p.layout.hidden.length);
      expect(p.layout.order.length - p.layout.hidden.length, `${id} visible count`).toBe(visible);
    }
  });
});
