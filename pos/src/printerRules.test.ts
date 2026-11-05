import { describe, expect, test } from "vitest";
import { printerGone } from "./printerRules";

describe("printerGone", () => {
  test("a pulled cable or powered-off printer reads as gone", () => {
    expect(printerGone(new Error("Failed to execute 'transferOut' on 'USBDevice': The device was disconnected."))).toBe(true);
    expect(printerGone(new DOMException("The device was disconnected.", "NetworkError"))).toBe(true);
    expect(printerGone(new Error("The device must be opened first."))).toBe(false);
    expect(printerGone(new Error("No printer connected"))).toBe(false);
  });
});
