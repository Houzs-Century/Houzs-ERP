import { afterEach, describe, expect, it, vi } from "vitest";
import { instantToMytLocal, mytLocalToInstant, todayMyt } from "./dates";

afterEach(() => { vi.useRealTimers(); });

describe("todayMyt at the 00:00-08:00 Malaysia window", () => {
  it("17:30 UTC on 9 Nov is 10 Nov in Malaysia", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T17:30:00Z"));
    expect(todayMyt()).toBe("2026-11-10");
    expect(todayMyt(-45)).toBe("2026-09-26");
  });

  it("on the 1st before 08:00 the month is already the new one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-30T23:00:00Z"));
    expect(todayMyt().slice(0, 7)).toBe("2026-12");
  });
});

describe("instantToMytLocal / mytLocalToInstant", () => {
  it("shows a stored instant on the Malaysian clock", () => {
    expect(instantToMytLocal("2026-11-10T03:00:00+00:00")).toBe("2026-11-10T11:00");
    expect(instantToMytLocal("2026-11-09T17:30:00Z")).toBe("2026-11-10T01:30");
    expect(instantToMytLocal(null)).toBe("");
    expect(instantToMytLocal("not a date")).toBe("");
  });

  it("saves a typed Malaysian time with its +08:00 offset, the same instant back", () => {
    expect(mytLocalToInstant("2026-11-10T11:00")).toBe("2026-11-10T11:00:00+08:00");
    expect(new Date(mytLocalToInstant("2026-11-10T11:00")!).toISOString()).toBe("2026-11-10T03:00:00.000Z");
    expect(mytLocalToInstant("")).toBeNull();
    expect(mytLocalToInstant(instantToMytLocal("2026-11-10T03:00:00Z"))).toBe("2026-11-10T11:00:00+08:00");
  });
});
