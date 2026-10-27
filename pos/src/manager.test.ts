import { describe, expect, test } from "vitest";
import { posSettingsDefaults } from "@shared/pos-settings";
import { managerCashier, provisionalState } from "./manager";

describe("manager sign-in", () => {
  const ctx = { user: { id: 7, name: "Ummu" }, company: { id: 1, name: "HOUZS CENTURY SDN BHD", registration_no: "", address: "", phone: "" }, settings: posSettingsDefaults() };
  test("an ERP account becomes a supervisor tile with no PIN and no discount cap", () => {
    const c = managerCashier({ token: "t", user: ctx.user });
    expect(c).toMatchObject({ id: -7, code: "ERP", name: "Ummu", role: "SUPERVISOR", pin_hash: "", max_discount_pct: 100 });
  });
  test("the provisional state has no token, no terminal, no items, and is never a real device", () => {
    const s = provisionalState(ctx);
    expect(s.token).toBe("");
    expect(s.provisional).toBe(true);
    expect(s.bundle.terminal.code).toBe("--");
    expect(s.bundle.items).toEqual([]);
    expect(s.bundle.cashiers).toEqual([]);
    expect(s.bundle.company.name).toBe("HOUZS CENTURY SDN BHD");
    expect(s.test_mode).toBe(false);
  });
});
