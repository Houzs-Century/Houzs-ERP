import { describe, expect, test } from "vitest";
import { hashPin, parsePinHash, verifyPin } from "./pin";

describe("pin", () => {
  test("a hash made the ERP way verifies the right PIN only", async () => {
    const stored = await hashPin("2468");
    expect(stored).toMatch(/^[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPin("2468", stored)).toBe(true);
    expect(await verifyPin("2469", stored)).toBe(false);
    expect(await verifyPin("", stored)).toBe(false);
  });

  test("a corrupt stored hash never verifies", async () => {
    expect(parsePinHash("nodollar")).toBeNull();
    expect(await verifyPin("1234", "nodollar")).toBe(false);
    expect(await verifyPin("1234", "$")).toBe(false);
  });
});
