import { describe, expect, it } from "vitest";
import { isOnePlace } from "./ScheduleRouteMap";

describe("isOnePlace", () => {
  it("a day with one planned stop but a long GPS line is not one place, so the map fits the whole day", () => {
    const stop = { lat: 3.05, lng: 101.45 };
    expect(isOnePlace([stop, stop, { lat: 3.1, lng: 101.6 }, { lat: 3.2, lng: 101.7 }])).toBe(false);
  });

  it("only the same spot repeated is one place", () => {
    const p = { lat: 3.05, lng: 101.45 };
    expect(isOnePlace([p])).toBe(true);
    expect(isOnePlace([p, { ...p }])).toBe(true);
    expect(isOnePlace([])).toBe(true);
  });
});
