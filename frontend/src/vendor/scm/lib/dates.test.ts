import { afterEach, describe, expect, it, vi } from "vitest";
import { instantToMytLocal, mytDayOfValue, mytLocalToInstant, todayMyt } from "./dates";

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

describe("mytDayOfValue", () => {
  it("an instant is converted to its Malaysian day", () => {
    expect(mytDayOfValue("2026-11-09T17:30:00Z")).toBe("2026-11-10");
    expect(mytDayOfValue("2026-11-09T17:30:00.123456+00:00")).toBe("2026-11-10");
    expect(mytDayOfValue("2026-11-09 17:30:00+00")).toBe("2026-11-10");
    expect(mytDayOfValue("2026-11-09T17:30:00+0000")).toBe("2026-11-10");
    expect(mytDayOfValue("2026-11-10T01:30:00+08:00")).toBe("2026-11-10");
    expect(mytDayOfValue("2026-11-09T15:59:59Z")).toBe("2026-11-09");
  });
  it("a plain date or an offset-less timestamp stays as written", () => {
    expect(mytDayOfValue("2026-11-10")).toBe("2026-11-10");
    expect(mytDayOfValue("2026/11/10")).toBe("2026-11-10");
    expect(mytDayOfValue("2026-11-09T23:30:00")).toBe("2026-11-09");
  });
  it("anything else is null", () => {
    expect(mytDayOfValue(null)).toBeNull();
    expect(mytDayOfValue("")).toBeNull();
    expect(mytDayOfValue("10/11/2026")).toBeNull();
    expect(mytDayOfValue(42)).toBeNull();
  });
});
