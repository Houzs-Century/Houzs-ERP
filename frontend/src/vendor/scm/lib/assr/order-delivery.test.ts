import { describe, expect, test } from "vitest";
import { orderDeliveryOf } from "./order-delivery";

describe("orderDeliveryOf", () => {
  test("joins the order's DOs and takes the most recent delivery date", () => {
    expect(
      orderDeliveryOf({
        order_dos: [
          { do_number: "HC-DO-2609-244", delivery_date: "2026-09-26" },
          { do_number: "HC-DO-2609-100", delivery_date: "2026-09-10" },
        ],
      }),
    ).toEqual({ doNo: "HC-DO-2609-244 · HC-DO-2609-100", deliveryDate: "2026-09-26" });
  });

  test("ignores the case's own do_date (the service delivery leg)", () => {
    expect(orderDeliveryOf({ do_numbers: "HC-DO-1", do_date: "2026-10-05" })).toEqual({ doNo: "HC-DO-1", deliveryDate: null });
  });

  test("empty case reads as nothing", () => {
    expect(orderDeliveryOf({})).toEqual({ doNo: null, deliveryDate: null });
    expect(orderDeliveryOf(undefined)).toEqual({ doNo: null, deliveryDate: null });
  });
});
