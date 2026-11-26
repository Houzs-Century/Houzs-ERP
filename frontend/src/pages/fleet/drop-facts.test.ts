import { describe, expect, test } from "vitest";
import { metresFromAddress, minutesOnSite } from "./drop-facts";

const fix = (lat: number, min: number) => ({ lat, lng: 101.6, recorded_at: new Date(Date.UTC(2026, 10, 20, 2, min)).toISOString() });

describe("metresFromAddress", () => {
  test("distance to the stop, null without GPS on either side", () => {
    expect(metresFromAddress({ lat: 3.1, lng: 101.6 }, { lat: 3.11, lng: 101.6 })).toBeGreaterThan(1000);
    expect(metresFromAddress({ lat: null, lng: null }, { lat: 3.1, lng: 101.6 })).toBeNull();
    expect(metresFromAddress({ lat: 3.1, lng: 101.6 }, null)).toBeNull();
  });
});

describe("minutesOnSite", () => {
  test("the unbroken stay around the POD time, not an earlier visit", () => {
    const fixes = [fix(3.1, 0), fix(3.2, 10), fix(3.1, 20), fix(3.1, 25), fix(3.1, 35), fix(3.3, 40)];
    expect(minutesOnSite({ lat: 3.1, lng: 101.6, at: fixes[3]!.recorded_at }, fixes)).toBe(15);
  });
  test("null with no fix near or no POD GPS", () => {
    expect(minutesOnSite({ lat: 3.5, lng: 101.6, at: "2026-11-20T02:00:00Z" }, [fix(3.1, 0)])).toBeNull();
    expect(minutesOnSite({ lat: null, lng: null, at: "2026-11-20T02:00:00Z" }, [fix(3.1, 0)])).toBeNull();
  });
});
