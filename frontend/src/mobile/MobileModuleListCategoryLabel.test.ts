import { describe, it, expect } from "vitest";
import { MODULE_CONFIGS } from "./MobileModuleList";

describe("MobileModuleList products config labels FABRIC_ACCESSORY", () => {
  const products = MODULE_CONFIGS.products;
  const row = { code: "SQUARE PILLOW", category: "FABRIC_ACCESSORY", name: "Square Pillow" };

  it("the category pill reads Sofa Accessory, never the raw enum", () => {
    expect(products.pill?.(row)).toBe("Sofa Accessory");
  });

  it("the sub-line reads Sofa Accessory", () => {
    expect(products.subline?.(row)).toBe("Sofa Accessory");
  });

  it("the secondary line carries the label, not FABRIC_ACCESSORY", () => {
    const line = products.secondary?.(row) ?? "";
    expect(line).toContain("Sofa Accessory");
    expect(line).not.toContain("FABRIC_ACCESSORY");
  });

  it("the Category detail field reads Sofa Accessory", () => {
    const catField = products.fields?.find((f) => f[1] === "Category");
    expect(catField?.[0](row)).toBe("Sofa Accessory");
  });
});
