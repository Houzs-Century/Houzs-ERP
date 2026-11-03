import { describe, it, expect } from "vitest";
import { friendlyStatus } from "./assrWeeklyStatus";

describe("friendlyStatus", () => {
  it("maps each open stage to a warm customer-facing line", () => {
    expect(friendlyStatus("pending_review")).toBe("Reviewing your request");
    expect(friendlyStatus("pending_solution")).toBe("Preparing the solution");
    expect(friendlyStatus("under_verification")).toBe("Inspecting the item");
    expect(friendlyStatus("pending_supplier_pickup")).toBe("Arranging pickup / with the supplier");
    expect(friendlyStatus("pending_item_ready")).toBe("Preparing your item");
    expect(friendlyStatus("pending_delivery_service")).toBe("Arranging delivery / service");
  });

  it("falls back to the shared customer label for an unlisted stage (never a raw slug)", () => {
    // A retired alias the friendly map doesn't list still reads as words via the
    // shared customer-status label, not as the database slug.
    expect(friendlyStatus("pending_item_pickup")).toBe("Pending Supplier Pickup");
    // An empty/absent stage is the one value that becomes "Unknown".
    expect(friendlyStatus(null)).toBe("Unknown");
  });
});
