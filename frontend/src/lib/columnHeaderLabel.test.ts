import { describe, expect, it } from "vitest";
import { headerLabel } from "./columnHeaderLabel";

describe("headerLabel", () => {
  it.each([
    ["Delivery date", "Delivery Date"],
    ["Order total", "Order Total"],
    ["price_tier", "Price Tier"],
    ["category", "Category"],
    ["vs PO price", "Vs PO Price"],
    ["DO date", "DO Date"],
    ["Qty to deliver", "Qty to Deliver"],
    ["Rent / sqm", "Rent / sqm"],
    ["Free (no order)", "Free (No Order)"],
    ["COGS (RM)", "COGS (RM)"],
    ["AutoCount ref", "AutoCount Ref"],
    ["Doc No.", "Doc No."],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(headerLabel(input)).toBe(expected);
  });
});
