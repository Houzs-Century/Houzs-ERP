import { describe, expect, it } from "vitest";
import { tabKeyOf } from "./DeliveryMaintenance";

describe("which Coverage & Fleet tab a link opens", () => {
  it("opens the tab named, Lorries when none", () => {
    expect(tabKeyOf("drivers", null)).toBe("drivers");
    expect(tabKeyOf(null, null)).toBe("lorries");
  });
  it("an old fold link lands on its tab", () => {
    expect(tabKeyOf(null, "fleet")).toBe("lorries");
    expect(tabKeyOf(null, "regions,fleet")).toBe("regions");
  });
});
