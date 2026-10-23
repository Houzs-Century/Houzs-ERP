import { describe, expect, test } from "vitest";
import { DEMO_PIN, demoState, isDemo } from "./demo";
import { verifyPin } from "./pin";
import { findByBarcode } from "./cart";

describe("demo mode", () => {
  test("a demo state has no token, is forced into test mode, and its cashiers open with the demo PIN", async () => {
    const s = await demoState(null);
    expect(s.token).toBe("");
    expect(s.test_mode).toBe(true);
    expect(isDemo(s)).toBe(true);
    expect(s.bundle.cashiers.some((c) => c.role === "SUPERVISOR")).toBe(true);
    for (const c of s.bundle.cashiers) expect(await verifyPin(DEMO_PIN, c.pin_hash)).toBe(true);
    expect(await verifyPin("0000", s.bundle.cashiers[0]!.pin_hash)).toBe(false);
  });
  test("every sample item has a scannable barcode and the event is running today", async () => {
    const s = await demoState(null);
    expect(s.bundle.items.length).toBeGreaterThanOrEqual(8);
    for (const it of s.bundle.items) expect(findByBarcode(s.bundle.items, it.barcodes[0]!)?.code).toBe(it.code);
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    expect(s.bundle.event.start_date! <= today && today <= s.bundle.event.end_date!).toBe(true);
  });
  test("a real prepared device is not demo", () => {
    expect(isDemo(null)).toBe(false);
    expect(isDemo({ demo: undefined } as unknown as Parameters<typeof isDemo>[0])).toBe(false);
  });
});
