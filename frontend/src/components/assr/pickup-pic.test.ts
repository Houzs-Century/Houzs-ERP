import { describe, expect, it } from "vitest";
import { pickupPicChoices, pickupPicLabel, pickupPicSelectOptions } from "./PickupTrackingFields";

describe("Pickup PIC dropdown (HC-0129)", () => {
  it("lists the case's supplier first, then the drivers, once each", () => {
    expect(pickupPicChoices(["Jan", "Thunai", "ACME"], "ACME")).toEqual(["ACME", "Jan", "Thunai"]);
  });

  it("lists only drivers when the case has no supplier", () => {
    expect(pickupPicChoices(["Jan"], null)).toEqual(["Jan"]);
  });

  it("marks the supplier so it is not mistaken for a driver", () => {
    const label = pickupPicLabel("ACME");
    expect(label("ACME")).toBe("ACME (Supplier)");
    expect(label("Jan")).toBe("Jan");
  });

  it("keeps a PIC typed before the dropdown selectable on mobile", () => {
    expect(pickupPicSelectOptions(["Jan"], "ACME", "Ali (lorry)").map((o) => o.value)).toEqual(["", "Ali (lorry)", "ACME", "Jan"]);
    expect(pickupPicSelectOptions(["Jan"], null, "Jan").map((o) => o.value)).toEqual(["", "Jan"]);
  });
});
