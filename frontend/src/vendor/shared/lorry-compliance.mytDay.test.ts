/* Lorry document expiry (road tax, insurance, Puspakom) counts days from the
   MALAYSIAN today. At 01:30 on 10 Nov (Malaysia), on a device whose clock
   zone is UTC, a road tax expiring on the 9th is already expired. Run with
   TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daysUntil, expiryStatus, todayIso } from "./lorry-compliance";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z")); // 01:30 on 10 Nov in Malaysia
});
afterEach(() => vi.useRealTimers());

describe("lorry expiry judges today by the Malaysian day", () => {
  it("today is the 10th", () => {
    expect(todayIso()).toBe("2026-11-10");
  });
  it("a document expiring on the 9th is one day past", () => {
    expect(daysUntil("2026-11-09")).toBe(-1);
    expect(expiryStatus("2026-11-09")).toEqual(expiryStatus("2026-11-09", "2026-11-10"));
  });
  it("a document expiring on the 10th has zero days left", () => {
    expect(daysUntil("2026-11-10")).toBe(0);
  });
  it("the day turns at 16:00 UTC", () => {
    vi.setSystemTime(new Date("2026-11-09T15:59:59Z"));
    expect(todayIso()).toBe("2026-11-09");
    vi.setSystemTime(new Date("2026-11-09T16:00:00Z"));
    expect(todayIso()).toBe("2026-11-10");
  });
});
