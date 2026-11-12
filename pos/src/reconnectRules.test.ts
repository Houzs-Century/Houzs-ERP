import { describe, expect, test } from "vitest";
import { ApiError } from "./api";
import { lostTerminal, lostTerminalText, requestRefused } from "./reconnectRules";

describe("reconnectRules", () => {
  test("only the ERP saying device_not_registered means the terminal is lost", () => {
    expect(lostTerminal(new ApiError(401, "device_not_registered", { error: "device_not_registered" }))).toBe(true);
    expect(lostTerminal(new ApiError(401, "device_token_required", { error: "device_token_required" }))).toBe(false);
    expect(lostTerminal(new ApiError(500, "HTTP 500", null))).toBe(false);
    expect(lostTerminal(new Error("Failed to fetch"))).toBe(false);
  });
  test("a refused request is not retried, a network failure is", () => {
    expect(requestRefused(new ApiError(404, "not_eligible", { error: "not_eligible" }))).toBe(true);
    expect(requestRefused(new ApiError(401, "device_not_registered", { error: "device_not_registered" }))).toBe(true);
    expect(requestRefused(new ApiError(503, "HTTP 503", null))).toBe(false);
    expect(requestRefused(new Error("Failed to fetch"))).toBe(false);
  });
  test("the cashier is told the bills are safe and whether there is anything to do", () => {
    expect(lostTerminalText("no", "T01")).toBeNull();
    expect(lostTerminalText("waiting", "T01")).toContain("nothing to type here");
    expect(lostTerminalText("waiting", "T01")).toContain("every bill is kept on this device");
    expect(lostTerminalText("not_eligible", "T01")).toContain("pairing link");
  });
});
